import { randomUUID } from 'node:crypto';
import { END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import type { Eligibility, GuardrailResult } from '@cx/shared';
import type { AiConfig } from '../config.js';
import type { EmbeddingService } from '../embeddings.js';
import { blockingMessages, hasBlockingFailure, validateDraft } from '../guardrails.js';
import type { ComposeMode, HistoryItem, LlmPort, LlmResult } from '../llm/types.js';
import {
  categoriesForIntent,
  eligibilityKindsFor,
  looksLikePromptInjection,
  routeFor,
} from '../policy/intent.js';
import type {
  ConversationContext,
  GenerationPorts,
  GenerationRecord,
  HistoryMessage,
} from '../ports.js';
import { createToolRegistry, type ToolRegistry } from '../tools.js';
import { assembleReply, firstName, holdingMessage } from './assemble.js';
import { GenerationState, type GState, type GUpdate, type SourceRef } from './state.js';

export interface GraphDeps {
  ports: GenerationPorts;
  llm: LlmPort;
  config: AiConfig;
  embeddings: EmbeddingService | null;
  now?: () => Date;
}

export interface GenerationInput {
  conversationId: string;
  brandId: string;
  customerId: string;
  orderId: string | null;
  requestedBy: string | null;
  parentGenerationId?: string | null;
  extraInstruction?: string | null;
}

/** Initial attempt + one corrective retry before falling back. */
export const MAX_COMPOSE_ATTEMPTS = 2;
const HISTORY_WINDOW = 12;
const MAX_SOURCES = 6;
const MAX_IMAGES = 3;

type NodeFn = (s: GState) => Promise<GUpdate>;

export function buildGenerationGraph(deps: GraphDeps) {
  const { ports, llm, config } = deps;
  const now = deps.now ?? (() => new Date());
  // One registry per run, bound to the run's trusted scope (set in `loadConversation`'s closure).
  let tools: ToolRegistry;

  /** Wraps a node with timing/tracing and converts exceptions into `state.error` (no unhandled throw mid-graph). */
  const node =
    (name: string, fn: NodeFn): NodeFn =>
    async (s) => {
      const t0 = Date.now();
      try {
        const update = await fn(s);
        const own = Array.isArray(update.trace) ? update.trace : [];
        return { ...update, trace: [...own, { node: name, ms: Date.now() - t0 }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          error: {
            code: (err as { code?: string }).code ?? 'NODE_FAILED',
            message: message.slice(0, 500),
            node: name,
          },
          trace: [{ node: name, ms: Date.now() - t0, note: `error: ${message.slice(0, 200)}` }],
        };
      }
    };

  const usageOf = (...results: LlmResult<unknown>[]): GUpdate => ({
    inputTokens: results.reduce((n, r) => n + r.usage.input, 0),
    outputTokens: results.reduce((n, r) => n + r.usage.output, 0),
    models: results.map((r) => r.model),
  });

  const toHistory = (messages: HistoryMessage[]): HistoryItem[] =>
    messages
      .filter((m) => m.sender_type !== 'system')
      .map((m) => ({
        role: m.sender_type === 'customer' ? 'customer' : 'agent',
        text: m.body.slice(0, 1200),
        imageCount: m.attachments.length,
      }));

  // ------------------------------------------------------------------------------------------------
  // Nodes
  // ------------------------------------------------------------------------------------------------
  const loadConversation = node('loadConversation', async (s) => {
    tools = createToolRegistry(
      {
        brandId: s.brandId,
        customerId: s.customerId,
        conversationId: s.conversationId,
        orderId: s.orderId,
        actorId: s.requestedBy,
      },
      { ports, llm, embeddings: deps.embeddings, thresholds: config.retrieval, now },
    );
    const context = await tools.getConversation();
    const customerMessages = context.messages.filter((m) => m.sender_type === 'customer');
    const latest = customerMessages.at(-1);
    if (!latest) {
      throw Object.assign(new Error('The conversation has no customer message to reply to'), {
        code: 'NO_CUSTOMER_MESSAGE',
      });
    }
    return {
      context,
      latest: {
        id: latest.id,
        body: latest.body,
        attachmentIds: latest.attachments.map((a) => a.id),
      },
      customerSentImage: customerMessages.some((m) => m.attachments.length > 0),
      priorAgentMessage: context.messages.some((m) => m.sender_type === 'agent'),
    };
  });

  const loadVerifiedOrderFacts = node('loadVerifiedOrderFacts', async () => {
    const [orderFacts, policies] = await Promise.all([
      tools.getOrderDetails(),
      tools.allPolicies(),
    ]);
    return { orderFacts, policies };
  });

  const understandIntent = node('understandIntent', async (s) => {
    const ctx = s.context!;
    const latest = s.latest!;
    const earlier = ctx.messages.filter((m) => m.id !== latest.id);
    const result = await llm.understand({
      brandName: ctx.brand.name,
      history: toHistory(earlier).slice(-HISTORY_WINDOW),
      latest: latest.body,
      latestHasImage: latest.attachmentIds.length > 0,
      anyCustomerImage: s.customerSentImage,
    });
    const u = result.value;
    const supported = ctx.brand.voice.supported_languages;
    const customerLanguage = u.language || ctx.customer.preferred_language || 'en';
    return {
      understanding: u,
      customerLanguage,
      // Reply in the customer's language when the brand supports it, otherwise in English.
      replyLanguage: supported.includes(customerLanguage) ? customerLanguage : 'en',
      injectionSuspected: u.injection_suspected || looksLikePromptInjection(latest.body),
      route: routeFor({
        intent: u.intent,
        asksForHuman: u.asks_for_human,
        hasCustomerImage: s.customerSentImage,
      }),
      ...usageOf(result),
    };
  });

  const analyzeImage = node('analyzeImage', async (s) => {
    const ids = s
      .context!.messages.filter((m) => m.sender_type === 'customer')
      .flatMap((m) => m.attachments.map((a) => a.id))
      .slice(-MAX_IMAGES);
    try {
      const result = await tools.analyzeCustomerImage(ids, s.latest!.body);
      if (!result) return { imageAnalysisFailed: true };
      return { imageEvidence: result.value, ...usageOf(result) };
    } catch {
      // Keep the attachment, fall back to a text-only reply that says the team will look at it.
      return {
        imageAnalysisFailed: true,
        trace: [
          { node: 'analyzeImage', ms: 0, note: 'vision analysis failed; continuing without it' },
        ],
      };
    }
  });

  const getOrderDetails = node('getOrderDetails', async () => ({
    deliveryEstimate: await tools.calculateDeliveryEstimate(),
    composeMode: 'order' as ComposeMode,
  }));

  const rewriteQuery = node('rewriteQuery', async (s) => {
    // The standalone English query was produced during understanding (one model call instead of two).
    const q = (s.understanding?.standalone_query ?? '').trim() || s.latest!.body;
    return { searchQuery: q.slice(0, 500) };
  });

  const retrieveBrandKnowledge = node('retrieveBrandKnowledge', async (s) => {
    const retrieval = await tools.retrieveBrandPolicies(
      s.searchQuery!,
      categoriesForIntent(s.understanding!.intent),
    );
    return { retrieval };
  });

  const evaluateEligibility = node('evaluateEligibility', async (s) => {
    const intent = s.understanding!.intent;
    const kinds = eligibilityKindsFor(intent);
    const eligibility: Eligibility[] = [];
    for (const kind of kinds) {
      if (kind === 'return') eligibility.push(await tools.checkReturnEligibility());
      else if (kind === 'refund') eligibility.push(await tools.checkRefundEligibility());
      else if (kind === 'cancellation')
        eligibility.push(await tools.checkCancellationEligibility());
      else if (kind === 'shipping') eligibility.push(await tools.calculateShippingEligibility());
      else if (kind === 'damage') {
        eligibility.push(
          await tools.checkDamageEligibility({
            hasPhoto: s.customerSentImage,
            visibleDamage: s.imageEvidence?.visible_damage ?? null,
          }),
        );
      }
    }
    const deliveryEstimate =
      s.deliveryEstimate ??
      (intent === 'shipping_question' || intent === 'missing_product'
        ? await tools.calculateDeliveryEstimate()
        : null);

    // Sources = relevant retrieved entries + the policies the deterministic rules relied on (deduplicated).
    const sources: SourceRef[] = [];
    const add = (
      id: string,
      title: string,
      version: number,
      content: string,
      extra: Partial<SourceRef> = {},
    ) => {
      if (sources.some((x) => x.id === id) || sources.length >= MAX_SOURCES) return;
      sources.push({
        id,
        label: `S${sources.length + 1}`,
        title,
        version,
        content,
        rank: sources.length + 1,
        vector_score: null,
        text_score: null,
        fused_score: 0,
        ...extra,
      });
    };
    for (const r of s.retrieval?.relevant ?? []) {
      add(r.id, r.title, r.version, r.content, {
        vector_score: r.vector_score,
        text_score: r.text_score,
        fused_score: r.fused_score,
      });
    }
    for (const e of eligibility) {
      const p = await tools.policyFor(e.kind);
      if (p) add(p.kbId, p.title, p.version, p.content);
    }

    const policyRelevant = s.route === 'policy' || s.route === 'image';
    const insufficient = policyRelevant && sources.length === 0;
    const reasons: string[] = [];
    if (insufficient)
      reasons.push('No relevant policy information was found in this brand’s knowledge base');
    if (eligibility.some((e) => e.outcome === 'needs_review'))
      reasons.push('An automated check needs a person to review the evidence');
    return {
      eligibility,
      deliveryEstimate,
      sources,
      composeMode: (insufficient
        ? 'insufficient'
        : s.route === 'order'
          ? 'order'
          : 'policy') as ComposeMode,
      escalate: s.escalate || reasons.length > 0,
      escalationReason: reasons.length ? reasons.join('; ') : s.escalationReason,
    };
  });

  /** Single place where the model is asked to write; the specialised draft nodes only choose the mode. */
  async function compose(s: GState, mode: ComposeMode): Promise<GUpdate> {
    const ctx = s.context!;
    const latest = s.latest!;
    const voice = ctx.brand.voice;
    const earlier = ctx.messages.filter((m) => m.id !== latest.id);
    const result = await llm.compose({
      mode,
      brand: { name: ctx.brand.name, tone: voice.tone, style: voice.communication_style },
      replyLanguage: s.replyLanguage,
      includeGreetingInBody:
        s.replyLanguage !== 'en' && !s.priorAgentMessage && Boolean(voice.greeting_preference),
      customerFirstName: firstName(ctx.customer.name),
      history: toHistory(earlier).slice(-HISTORY_WINDOW),
      latestCustomerMessage: latest.body,
      customerSentImage: s.customerSentImage,
      imageEvidence: s.imageEvidence,
      imageAnalysisFailed: s.imageAnalysisFailed,
      orderFacts: s.orderFacts,
      deliveryEstimate: s.deliveryEstimate,
      eligibility: s.eligibility,
      sources: s.sources.map((x) => ({ label: x.label, title: x.title, content: x.content })),
      extraInstruction: s.extraInstruction ?? undefined,
      violationFeedback: s.attempts > 0 ? s.violationFeedback : undefined,
    });
    const body = assembleReply({
      body: result.value.reply_body,
      voice,
      customerName: ctx.customer.name,
      addGreeting: s.replyLanguage === 'en' && !s.priorAgentMessage,
    });
    return {
      composed: result.value,
      proposedResponse: body,
      composeMode: mode,
      attempts: s.attempts + 1,
      escalate: s.escalate || result.value.suggest_human_review,
      ...usageOf(result),
    };
  }

  const generateConversationalDraft = node('generateConversationalDraft', (s) =>
    compose(s, 'small_talk'),
  );
  const generateEscalationDraft = node('generateEscalationDraft', async (s) => ({
    ...(await compose(s, 'escalation')),
    escalate: true,
    escalationReason: 'The customer asked to speak to a person',
  }));
  const generateSafeFallback = node('generateSafeFallback', async (s) => ({
    ...(await compose(s, 'clarify')),
    escalate: true,
    escalationReason: 'The request was unclear or unsupported',
  }));
  const generateResponse = node('generateResponse', (s) => compose(s, s.composeMode));

  const validateResponse = node('validateResponse', async (s) => {
    const composed = s.composed!;
    const ctx = s.context!;
    const labelToId = new Map(s.sources.map((x) => [x.label, x.id]));
    const citedIds = composed.cited_source_ids.map(
      (l) => labelToId.get(l.trim().toUpperCase()) ?? `unknown:${l}`,
    );
    const policyRelevant = s.route === 'policy' || s.route === 'image';
    const results: GuardrailResult[] = [
      {
        check: 'structured_output',
        passed: true,
        severity: 'info',
        detail: 'Model output matched the schema',
      },
      ...validateDraft({
        reply: s.proposedResponse!,
        citedIds,
        sources: s.sources.map((x) => ({ id: x.id, title: x.title, content: x.content })),
        eligibility: s.eligibility,
        order: s.orderFacts,
        deliveryEstimate: s.deliveryEstimate,
        otherBrandNames: await ports.listOtherBrandNames(s.brandId),
        customerSentImage: s.customerSentImage,
        priorAgentMessage: s.priorAgentMessage,
        retrievalSufficient: s.sources.length > 0,
        policyRelevant,
        expectedLanguage: s.replyLanguage,
        replyLanguage: composed.reply_language,
        selfReported: composed,
      }),
    ];
    if (s.injectionSuspected) {
      results.push({
        check: 'prompt_injection_suspected',
        passed: true,
        severity: 'info',
        detail:
          'The customer message looks like an attempt to instruct the assistant; it was treated as data',
      });
    }
    const update: GUpdate = {};
    // Model-based check only where regexes are unreliable (non-English text) and only if nothing already blocks.
    if (s.replyLanguage !== 'en' && !hasBlockingFailure(results)) {
      const facts = JSON.stringify({
        order: s.orderFacts,
        eligibility: s.eligibility,
        policies: s.sources.map((x) => x.content),
      });
      const judged = await llm.judge({ reply: s.proposedResponse!, facts });
      Object.assign(update, usageOf(judged));
      // Findings must quote the reply verbatim; a flag whose quote is not in the reply is discarded as unreliable.
      const norm = (x: string) => x.toLowerCase().replace(/s+/g, ' ').trim();
      const reply = norm(s.proposedResponse!);
      const confirmed = judged.value.violations.filter(
        (v) => v.quote.trim().length >= 6 && reply.includes(norm(v.quote)),
      );
      results.push(
        confirmed.length
          ? {
              check: 'llm_compliance_check',
              passed: false,
              severity: 'blocking',
              detail: confirmed
                .map((v) => `${v.type}: "${v.quote}" (${v.reason})`)
                .join(' | ')
                .slice(0, 500),
            }
          : {
              check: 'llm_compliance_check',
              passed: true,
              severity: 'info',
              detail: judged.value.violations.length
                ? `Discarded ${judged.value.violations.length} unverifiable finding(s)`
                : undefined,
            },
      );
    }
    void ctx;
    return { ...update, guardrails: results, violationFeedback: blockingMessages(results) };
  });

  const safeFallback = node('safeFallback', async (s) => {
    const reasons = blockingMessages(s.guardrails);
    const body = assembleReply({
      body: holdingMessage(s.replyLanguage),
      voice: s.context!.brand.voice,
      customerName: s.context!.customer.name,
      addGreeting: s.replyLanguage === 'en' && !s.priorAgentMessage,
    });
    return {
      fallbackUsed: true,
      proposedResponse: body,
      escalate: true,
      escalationReason: `AI draft withheld by safety checks: ${reasons.join('; ').slice(0, 300)}`,
      // The withheld candidate stays in the trace for admins; the agent sees the explanation, not the unsafe text.
      guardrails: [
        ...s.guardrails,
        {
          check: 'safe_fallback',
          passed: false,
          severity: 'warning' as const,
          detail: `The generated draft was withheld (${reasons.join('; ').slice(0, 300)}). A neutral holding message was prepared instead; review the order and respond manually or escalate.`,
        },
      ],
      trace: [
        {
          node: 'safeFallback',
          ms: 0,
          note: `withheld: ${(s.proposedResponse ?? '').slice(0, 300)}`,
        },
      ],
    };
  });

  function record(s: GState, status: 'draft' | 'failed'): GenerationRecord {
    const failed = status === 'failed';
    const started = s.startedAt || Date.now();
    return {
      brand_id: s.brandId,
      conversation_id: s.conversationId,
      trigger_message_id: s.latest?.id ?? null,
      requested_by: s.requestedBy,
      parent_generation_id: s.parentGenerationId,
      status,
      intent: s.understanding?.intent ?? null,
      language: s.replyLanguage,
      search_query: s.searchQuery,
      body: failed ? '' : (s.proposedResponse ?? ''),
      model: s.models.join(', ') || llm.chatModel,
      prompt_tokens: s.inputTokens,
      completion_tokens: s.outputTokens,
      latency_ms: Date.now() - started,
      error_code: s.error?.code ?? null,
      error_message: s.error?.message ?? null,
      escalate: s.escalate,
      guardrails: s.guardrails,
      eligibility: s.eligibility,
      order_facts: s.orderFacts,
      image_evidence: s.imageEvidence,
      graph_trace: s.trace,
      sources: s.sources.map((x) => ({
        kb_id: x.id,
        kb_version: x.version,
        title: x.title,
        rank: x.rank,
        vector_score: x.vector_score,
        text_score: x.text_score,
        fused_score: x.fused_score,
      })),
    };
  }

  const saveDraft = node('saveDraft', async (s) => {
    const generationId = await ports.saveGeneration(record(s, 'draft'));
    if (s.escalate) {
      await tools.requestHumanEscalation(
        generationId,
        s.escalationReason ?? 'Escalation suggested by the assistant',
      );
    }
    return { generationId };
  });

  const saveFailure = async (s: GState): Promise<GUpdate> => {
    // The conversation may not have loaded; the run scope is still trusted, so a failed attempt is auditable.
    const generationId = await ports.saveGeneration({ ...record(s, 'failed'), escalate: false });
    return { generationId };
  };

  // ------------------------------------------------------------------------------------------------
  // Edges
  // ------------------------------------------------------------------------------------------------
  const failOr = (next: string) => (s: GState) => (s.error ? 'saveFailure' : next);

  const afterUnderstanding = (s: GState) => {
    if (s.error) return 'saveFailure';
    switch (s.route) {
      case 'small_talk':
        return 'generateConversationalDraft';
      case 'order':
        return 'getOrderDetails';
      case 'policy':
        return 'rewriteQuery';
      case 'image':
        return 'analyzeImage';
      case 'human':
        return 'generateEscalationDraft';
      default:
        return 'generateSafeFallback';
    }
  };

  const safetyRouter = (s: GState) => {
    if (s.error) return 'saveFailure';
    if (!hasBlockingFailure(s.guardrails)) return 'saveDraft';
    return s.attempts < MAX_COMPOSE_ATTEMPTS ? 'generateResponse' : 'safeFallback';
  };

  const g = new StateGraph(GenerationState)
    .addNode('loadConversation', loadConversation)
    .addNode('loadVerifiedOrderFacts', loadVerifiedOrderFacts)
    .addNode('understandIntent', understandIntent)
    .addNode('generateConversationalDraft', generateConversationalDraft)
    .addNode('getOrderDetails', getOrderDetails)
    .addNode('rewriteQuery', rewriteQuery)
    .addNode('retrieveBrandKnowledge', retrieveBrandKnowledge)
    .addNode('analyzeImage', analyzeImage)
    .addNode('generateEscalationDraft', generateEscalationDraft)
    .addNode('generateSafeFallback', generateSafeFallback)
    .addNode('evaluateEligibility', evaluateEligibility)
    .addNode('generateResponse', generateResponse)
    .addNode('validateResponse', validateResponse)
    .addNode('safeFallback', safeFallback)
    .addNode('saveDraft', saveDraft)
    .addNode('saveFailure', saveFailure)
    .addEdge(START, 'loadConversation')
    .addConditionalEdges('loadConversation', failOr('loadVerifiedOrderFacts'), [
      'loadVerifiedOrderFacts',
      'saveFailure',
    ])
    .addConditionalEdges('loadVerifiedOrderFacts', failOr('understandIntent'), [
      'understandIntent',
      'saveFailure',
    ])
    .addConditionalEdges('understandIntent', afterUnderstanding, [
      'generateConversationalDraft',
      'getOrderDetails',
      'rewriteQuery',
      'analyzeImage',
      'generateEscalationDraft',
      'generateSafeFallback',
      'saveFailure',
    ])
    .addConditionalEdges('getOrderDetails', failOr('evaluateEligibility'), [
      'evaluateEligibility',
      'saveFailure',
    ])
    .addConditionalEdges('analyzeImage', failOr('rewriteQuery'), ['rewriteQuery', 'saveFailure'])
    .addConditionalEdges('rewriteQuery', failOr('retrieveBrandKnowledge'), [
      'retrieveBrandKnowledge',
      'saveFailure',
    ])
    .addConditionalEdges('retrieveBrandKnowledge', failOr('evaluateEligibility'), [
      'evaluateEligibility',
      'saveFailure',
    ])
    .addConditionalEdges('evaluateEligibility', failOr('generateResponse'), [
      'generateResponse',
      'saveFailure',
    ])
    .addConditionalEdges('generateConversationalDraft', failOr('validateResponse'), [
      'validateResponse',
      'saveFailure',
    ])
    .addConditionalEdges('generateEscalationDraft', failOr('validateResponse'), [
      'validateResponse',
      'saveFailure',
    ])
    .addConditionalEdges('generateSafeFallback', failOr('validateResponse'), [
      'validateResponse',
      'saveFailure',
    ])
    .addConditionalEdges('generateResponse', failOr('validateResponse'), [
      'validateResponse',
      'saveFailure',
    ])
    .addConditionalEdges('validateResponse', safetyRouter, [
      'saveDraft',
      'generateResponse',
      'safeFallback',
      'saveFailure',
    ])
    .addEdge('safeFallback', 'saveDraft')
    .addConditionalEdges('saveDraft', failOr(END), [END, 'saveFailure'])
    .addEdge('saveFailure', END);

  // Per-process checkpointing lets an in-flight run be inspected/resumed within this server. The durable audit
  // trail lives in Postgres (saveGeneration); the graph never waits for agent approval.
  return g.compile({ checkpointer: new MemorySaver() });
}

export interface GenerationOutcome {
  generationId: string | null;
  state: GState;
}

export async function runGeneration(
  deps: GraphDeps,
  input: GenerationInput,
  opts: { signal?: AbortSignal } = {},
): Promise<GenerationOutcome> {
  const graph = buildGenerationGraph(deps);
  const state = (await graph.invoke(
    {
      conversationId: input.conversationId,
      brandId: input.brandId,
      customerId: input.customerId,
      orderId: input.orderId,
      requestedBy: input.requestedBy,
      parentGenerationId: input.parentGenerationId ?? null,
      extraInstruction: input.extraInstruction ?? null,
      startedAt: Date.now(),
    },
    { configurable: { thread_id: randomUUID() }, signal: opts.signal },
  )) as GState;
  return { generationId: state.generationId, state };
}

export type { ConversationContext };
