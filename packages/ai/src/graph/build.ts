import { randomUUID } from 'node:crypto';
import { END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import type { Eligibility, GuardrailResult } from '@cx/shared';
import type { AiConfig } from '../config.js';
import type { EmbeddingService } from '../embeddings.js';
import {
  blockingMessages,
  hasBlockingFailure,
  statedFigures,
  validateDraft,
} from '../guardrails.js';
import { hasDocumentedProcedure } from '../procedure.js';
import type { ComposeMode, HistoryItem, LlmPort, LlmResult } from '../llm/types.js';
import {
  answeredTopics,
  describeCaseState,
  mergeCaseState,
  type CaseDerived,
  type PersistedCaseState,
} from '../case-state.js';
import { categoriesForIntent, looksLikePromptInjection } from '../policy/intent.js';
import {
  decideNextAction as decide,
  ELIGIBILITY_TOPIC_INTENTS,
  finalizeNextAction,
  isAmbiguousMismatch,
} from '../policy/next-action.js';
import type {
  ConversationContext,
  GenerationPorts,
  GenerationRecord,
  HistoryMessage,
} from '../ports.js';
import { createToolRegistry, type ToolRegistry } from '../tools.js';
import {
  assembleReply,
  firstName,
  handoffMessage,
  holdingMessage,
  shouldAddSignOff,
} from './assemble.js';
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
// Enough for a long support thread; facts beyond it survive in the persisted case state.
const HISTORY_WINDOW = 30;
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
    const lastAgent = context.messages.filter((m) => m.sender_type === 'agent').at(-1);
    return {
      lastAgentReply: lastAgent?.body ?? null,
      lastAgentAt: lastAgent?.created_at ?? null,
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

  const loadVerifiedOrderFacts = node('loadVerifiedOrderFacts', async (s) => {
    const [orderFacts, policies, previousCaseState] = await Promise.all([
      tools.getOrderDetails(),
      tools.allPolicies(),
      ports.loadPreviousCaseState(s.conversationId, s.latest!.id),
    ]);
    return { orderFacts, policies, previousCaseState };
  });

  const understandIntent = node('understandIntent', async (s) => {
    const ctx = s.context!;
    const latest = s.latest!;
    const earlier = ctx.messages.filter((m) => m.id !== latest.id);
    const result = await llm.understand({
      brandName: ctx.brand.name,
      previousCaseState: s.previousCaseState ? describeCaseState(s.previousCaseState) : null,
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
      asksNextStep: u.case_update.asks_next_step,
      asksClarification: u.case_update.asks_clarification,
      ...usageOf(result),
    };
  });

  /** Merges what the customer said in the latest messages into the running case state. */
  const updateCaseState = node('updateCaseState', async (s) => {
    const base = mergeCaseState(s.previousCaseState, s.understanding!.case_update, s.latest!.id);
    // An attachment is a backend fact, not a statement: it overrides what the model inferred about photos.
    const caseState =
      s.customerSentImage && !base.confirmed_facts.includes('photo_provided')
        ? { ...base, confirmed_facts: [...base.confirmed_facts, 'photo_provided' as const] }
        : base;
    // Derived from the message history (authoritative), never from the model:
    //  - was the next step / handoff already given to the customer by an agent reply that was actually sent?
    //  - which policy figures have agents already stated?
    const messages = s.context!.messages;
    const prev = s.previousCaseState;
    const at = prev?.as_of_message_id
      ? messages.findIndex((m) => m.id === prev.as_of_message_id)
      : -1;
    const agentRepliedSince =
      at >= 0 && messages.slice(at + 1).some((m) => m.sender_type === 'agent');
    const nextStepAlreadyGiven = Boolean(
      agentRepliedSince &&
      prev?.derived &&
      ['provide_next_step', 'handoff_to_human', 'follow_up_pending'].includes(
        prev.derived.next_action,
      ),
    );
    const previouslyStatedFigures = [
      ...new Set(
        messages.filter((m) => m.sender_type === 'agent').flatMap((m) => statedFigures(m.body)),
      ),
    ];
    // Same words as an earlier customer message (ignoring case, punctuation and spacing).
    const norm = (t: string) =>
      t
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
    const latestText = norm(s.latest!.body);
    const customerRepeated =
      latestText.length > 3 &&
      messages
        .filter((m) => m.sender_type === 'customer' && m.id !== s.latest!.id)
        .slice(-6)
        .some((m) => norm(m.body) === latestText);
    return { caseState, nextStepAlreadyGiven, previouslyStatedFigures, customerRepeated };
  });

  /** Decides route, required checks and the next support action from the case state (deterministic). */
  const decideNextAction = node('decideNextAction', async (s) => {
    const d = decide({
      intent: s.understanding!.intent,
      asksForHuman: s.understanding!.asks_for_human,
      asksNextStep: s.asksNextStep,
      state: s.caseState!,
      customerSentImage: s.customerSentImage,
      orderLinked: s.orderFacts !== null,
      nextStepAlreadyGiven: s.nextStepAlreadyGiven,
      customerRepeated: s.customerRepeated,
    });
    return {
      effectiveIntent: d.effectiveIntent,
      route: d.route,
      eligibilityKinds: d.eligibilityKinds,
      missingInformation: d.missingInformation,
      workflowStage: d.workflowStage,
      nextAction: d.nextAction,
      trace: [
        {
          node: 'decideNextAction',
          ms: 0,
          note: `intent ${s.understanding!.intent} -> ${d.effectiveIntent}, stage ${d.workflowStage}, next ${d.nextAction}`,
        },
      ],
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
      categoriesForIntent(s.effectiveIntent ?? s.understanding!.intent),
    );
    return { retrieval };
  });

  const evaluateEligibility = node('evaluateEligibility', async (s) => {
    const intent = s.effectiveIntent ?? s.understanding!.intent;
    const eligibility: Eligibility[] = [];
    for (const kind of s.eligibilityKinds) {
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
        category: null,
        ...extra,
      });
    };
    for (const r of s.retrieval?.relevant ?? []) {
      add(r.id, r.title, r.version, r.content, {
        category: r.category,
        vector_score: r.vector_score,
        text_score: r.text_score,
        fused_score: r.fused_score,
      });
    }
    for (const e of eligibility) {
      const p = await tools.policyFor(e.kind);
      if (p) add(p.kbId, p.title, p.version, p.content, { category: p.category });
    }

    const policyRelevant = s.route === 'policy' || s.route === 'image';
    const insufficient = policyRelevant && sources.length === 0;
    const finalized = finalizeNextAction(
      {
        effectiveIntent: intent,
        route: s.route!,
        eligibilityKinds: s.eligibilityKinds as Eligibility['kind'][],
        missingInformation: s.missingInformation,
        workflowStage: s.workflowStage,
        nextAction: s.nextAction,
      },
      eligibility,
    );
    if (insufficient) {
      finalized.next_action = 'handoff_to_human';
      finalized.workflow_stage = 'handoff';
    }
    const reasons: string[] = [];
    if (insufficient)
      reasons.push('No relevant policy information was found in this brand’s knowledge base');
    if (eligibility.some((e) => e.outcome === 'needs_review'))
      reasons.push('An automated check needs a person to review the evidence');
    if (finalized.next_action === 'handoff_to_human' && !insufficient) {
      reasons.push('The case needs a person to take the next step');
    }
    return {
      eligibility,
      derived: finalized,
      nextAction: finalized.next_action,
      workflowStage: finalized.workflow_stage,
      missingInformation: finalized.missing_information,
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
    const derived = deriveFor(s, mode);
    const caseState = s.caseState!;
    const result = await llm.compose({
      mode,
      nextAction: derived.next_action,
      caseSummary: describeCaseState(caseState),
      missingInformation: derived.missing_information,
      avoidAsking: [
        ...answeredTopics(caseState, {
          orderLinked: s.orderFacts !== null,
          customerSentImage: s.customerSentImage,
        }),
      ],
      lastAgentReply: s.lastAgentReply,
      alreadyStatedFigures: s.previouslyStatedFigures,
      asksClarification: s.asksClarification,
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
      addSignOff: shouldAddSignOff({
        priorAgentMessage: s.priorAgentMessage,
        lastAgentAt: s.lastAgentAt,
        now: now().getTime(),
      }),
    });
    // The next step is only "documented" if the model says every step it gave is in the policy sources; when it
    // is not, the honest outcome is a human handoff rather than invented instructions.
    // Documentation is checked against the policy sentences that apply to THIS case, not just the model's word.
    const documented =
      result.value.next_step_documented &&
      hasDocumentedProcedure(
        s.sources.map((x) => ({ category: x.category ?? undefined, content: x.content })),
        { caseHasDefect: caseHasDefect(s) },
      );
    const pending = derived.next_action === 'follow_up_pending';
    const gap = (derived.next_action === 'provide_next_step' && !documented) || pending;
    return {
      composed: result.value,
      proposedResponse: body,
      composeMode: mode,
      derived:
        gap && derived.next_action === 'provide_next_step'
          ? { ...derived, workflow_stage: 'handoff' as const }
          : derived,
      attempts: s.attempts + 1,
      escalate: s.escalate || result.value.suggest_human_review || gap,
      escalationReason: gap
        ? pending
          ? 'The customer is following up on a step that is still pending with the team'
          : 'No documented procedure applies to this case; the team must send the instructions'
        : s.escalationReason,
      ...usageOf(result),
    };
  }

  /** The case genuinely involves a defect or damage (customer statement or a damage check that passed/needs review). */
  function caseHasDefect(s: GState): boolean {
    return (
      Boolean(s.caseState?.confirmed_facts.includes('item_damaged')) ||
      s.eligibility.some(
        (e) => e.kind === 'damage' && (e.outcome === 'eligible' || e.outcome === 'needs_review'),
      )
    );
  }

  /** Specific, workflow-level guidance for a retry (the guardrail messages alone say what is wrong, not what to do). */
  function retryGuidance(results: GuardrailResult[], s: GState): string[] {
    const failed = new Set(
      results.filter((r) => !r.passed && r.severity === 'blocking').map((r) => r.check),
    );
    const out = blockingMessages(results);
    if (failed.has('no_repeated_reply')) {
      out.push(
        'PROGRESS REQUIRED: your draft repeats your previous reply, but the conversation has moved on (the customer asked again, or told you something new; see CASE SO FAR and the latest message). Do not restate your previous reply or any policy. In 2-3 sentences respond to what is NEW in their latest message, say where the request stands now, and what happens next. Add nothing the policy sources do not support.',
      );
    }
    if (failed.has('no_redundant_question')) {
      out.push(
        'Use the facts the customer already gave (CASE SO FAR) and move to the next step; ask for nothing already answered.',
      );
    }
    if (failed.has('no_unrequested_eligibility') || failed.has('eligibility_claim_supported')) {
      out.push(
        'Do not state or imply eligibility. Acknowledge the problem and ask the single question that clarifies what happened and what the customer would like.',
      );
    }
    if (failed.has('no_invented_procedure')) {
      out.push(
        'Describe no procedure at all. Say the support team will send the exact instructions.',
      );
    }
    void s;
    return out;
  }

  /** Last-resort text when no draft passed validation: grounded in the case state and verified order only. */
  function fallbackBody(s: GState): { text: string; useful: boolean } {
    const c = s.caseState;
    const resolution =
      c && c.desired_resolution !== 'unknown' && c.desired_resolution !== 'none'
        ? c.desired_resolution
        : c && ['return', 'refund', 'exchange', 'cancellation'].includes(c.issue_type)
          ? c.issue_type
          : null;
    if (!resolution) return { text: holdingMessage(s.replyLanguage), useful: false };
    const base = {
      language: s.replyLanguage,
      resolution,
      orderNumber: s.orderFacts?.order_number ?? null,
    };
    const first = handoffMessage({ ...base, followUp: false });
    const already = Boolean(s.lastAgentReply) && s.lastAgentReply!.includes(first.slice(0, 40));
    return { text: handoffMessage({ ...base, followUp: already }), useful: true };
  }

  /** The decision for this run; paths that skip evaluateEligibility still get a consistent derived record. */
  function deriveFor(s: GState, mode: ComposeMode): CaseDerived {
    if (s.derived) return s.derived;
    const forced =
      mode === 'escalation'
        ? 'handoff_to_human'
        : mode === 'clarify'
          ? 'clarify_request'
          : mode === 'small_talk'
            ? 'acknowledge'
            : s.nextAction;
    return finalizeNextAction(
      {
        effectiveIntent: s.effectiveIntent ?? s.understanding!.intent,
        route: s.route!,
        eligibilityKinds: s.eligibilityKinds as Eligibility['kind'][],
        missingInformation: s.missingInformation,
        workflowStage: s.workflowStage,
        nextAction: forced,
      },
      s.eligibility,
    );
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
        sources: s.sources.map((x) => ({
          id: x.id,
          title: x.title,
          content: x.content,
          category: x.category ?? undefined,
        })),
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
        answeredTopics: [
          ...answeredTopics(s.caseState!, {
            orderLinked: s.orderFacts !== null,
            customerSentImage: s.customerSentImage,
          }),
        ],
        lastAgentReply: s.lastAgentReply,
        allowRepeat: s.asksClarification,
        previouslyStatedFigures: s.previouslyStatedFigures,
        caseHasDefect: caseHasDefect(s),
        eligibilityTopicOpen:
          ELIGIBILITY_TOPIC_INTENTS.includes(s.effectiveIntent ?? s.understanding!.intent) &&
          !isAmbiguousMismatch(s.caseState!),
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
      const norm = (x: string) => x.toLowerCase().replace(/\s+/g, ' ').trim();
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
    return { ...update, guardrails: results, violationFeedback: retryGuidance(results, s) };
  });

  const safeFallback = node('safeFallback', async (s) => {
    const reasons = blockingMessages(s.guardrails);
    const body = assembleReply({
      body: fallbackBody(s).text,
      voice: s.context!.brand.voice,
      customerName: s.context!.customer.name,
      addGreeting: s.replyLanguage === 'en' && !s.priorAgentMessage,
      addSignOff: shouldAddSignOff({
        priorAgentMessage: s.priorAgentMessage,
        lastAgentAt: s.lastAgentAt,
        now: now().getTime(),
      }),
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
      case_state: s.caseState
        ? ({ ...s.caseState, derived: s.derived ?? undefined } as PersistedCaseState)
        : null,
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

  const afterDecision = (s: GState) => {
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
    .addNode('updateCaseState', updateCaseState)
    .addNode('decideNextAction', decideNextAction)
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
    .addConditionalEdges('understandIntent', failOr('updateCaseState'), [
      'updateCaseState',
      'saveFailure',
    ])
    .addConditionalEdges('updateCaseState', failOr('decideNextAction'), [
      'decideNextAction',
      'saveFailure',
    ])
    .addConditionalEdges('decideNextAction', afterDecision, [
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
