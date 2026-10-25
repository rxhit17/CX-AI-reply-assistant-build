import { createLlm, runGeneration, type LlmPort, type ProgressEvent } from '@cx/ai';
import type { SupabaseClient } from '@supabase/supabase-js';
import { assertBrandAccess, type AuthUser } from '../auth.js';
import type { Deps } from '../deps.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../errors.js';
import { SlidingWindowLimiter } from '../rate-limit.js';
import { createGenerationPorts } from './ai-ports.js';
import { loadConversation } from './conversations.js';

export interface AiRuntime {
  llm: LlmPort;
  perAgent: SlidingWindowLimiter;
  perConversation: SlidingWindowLimiter;
  inFlight: Set<string>;
}

export function createAiRuntime(deps: Deps): AiRuntime {
  return {
    llm: createLlm(deps.aiConfig),
    perAgent: new SlidingWindowLimiter(deps.env.RATE_LIMIT_AI_PER_AGENT_PER_MIN, 60_000),
    perConversation: new SlidingWindowLimiter(
      deps.env.RATE_LIMIT_AI_PER_CONVERSATION_PER_MIN,
      60_000,
    ),
    inFlight: new Set(),
  };
}

type AiDeps = Pick<Deps, 'db' | 'env' | 'aiConfig' | 'embeddings'> & { runtime: AiRuntime };

const DRAFT_COLUMNS =
  'id, brand_id, conversation_id, trigger_message_id, requested_by, parent_generation_id, status, intent, language, ' +
  'search_query, original_body, current_body, final_message_id, model, prompt_tokens, completion_tokens, latency_ms, ' +
  'error_code, error_message, escalate, case_state, guardrails, eligibility, order_facts, image_evidence, approved_by, approved_at, ' +
  'sent_by, sent_at, created_at, updated_at';

function throttle(runtime: AiRuntime, userId: string, conversationId: string) {
  const a = runtime.perAgent.take(userId);
  if (!a.allowed) {
    throw new HttpError(
      429,
      'AI_RATE_LIMITED',
      `Too many AI requests. Try again in ${Math.ceil(a.retryAfterMs / 1000)}s`,
    );
  }
  const c = runtime.perConversation.take(conversationId);
  if (!c.allowed) {
    throw new HttpError(
      429,
      'AI_RATE_LIMITED',
      `This conversation was regenerated too often. Try again in ${Math.ceil(c.retryAfterMs / 1000)}s`,
    );
  }
}

export async function generateDraft(
  deps: AiDeps,
  user: AuthUser,
  input: {
    conversation_id: string;
    options?: { regenerate_of?: string; extra_instruction?: string };
  },
  hooks?: { onProgress?: (event: ProgressEvent) => void },
) {
  const { db, runtime } = deps;
  // Brand, customer and order come from the database row, never from the request.
  const conv = await loadConversation(db, user, input.conversation_id);

  let parent: string | null = null;
  if (input.options?.regenerate_of) {
    const { data } = await db
      .from('ai_generations')
      .select('id, conversation_id')
      .eq('id', input.options.regenerate_of)
      .maybeSingle();
    if (!data || data.conversation_id !== conv.id)
      throw badRequest('regenerate_of does not belong to this conversation');
    parent = data.id;
  }

  throttle(runtime, user.id, conv.id);
  if (runtime.inFlight.has(conv.id))
    throw conflict(
      'A reply is already being generated for this conversation',
      'GENERATION_IN_PROGRESS',
    );
  runtime.inFlight.add(conv.id);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.env.REQUEST_TIMEOUT_MS);
  try {
    const { generationId, state } = await runGeneration(
      {
        ports: createGenerationPorts(db),
        llm: runtime.llm,
        config: deps.aiConfig,
        embeddings: deps.embeddings,
        onProgress: hooks?.onProgress,
      },
      {
        conversationId: conv.id,
        brandId: conv.brand_id,
        customerId: conv.customer_id,
        orderId: conv.order_id,
        requestedBy: user.id,
        parentGenerationId: parent,
        extraInstruction: input.options?.extra_instruction ?? null,
      },
      { signal: controller.signal },
    );
    if (!generationId)
      throw new HttpError(500, 'GENERATION_FAILED', 'The reply could not be generated');
    const draft = await getDraft(deps, user, generationId);
    if (state.error) {
      // A failed run is persisted for the audit trail; tell the caller clearly instead of returning a fake draft.
      throw new HttpError(
        502,
        state.error.code,
        `The reply could not be generated (${state.error.message})`,
      );
    }
    return draft;
  } catch (err) {
    if (controller.signal.aborted)
      throw new HttpError(504, 'GENERATION_TIMEOUT', 'Generating the reply took too long');
    throw err;
  } finally {
    clearTimeout(timer);
    runtime.inFlight.delete(conv.id);
  }
}

async function loadGeneration(db: SupabaseClient, user: AuthUser, id: string) {
  const { data, error } = await db
    .from('ai_generations')
    .select(DRAFT_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw notFound('Draft');
  const row = data as unknown as { brand_id: string };
  assertBrandAccess(user, row.brand_id, 'Draft');
  return data as unknown as Record<string, unknown> & {
    id: string;
    brand_id: string;
    status: string;
    conversation_id: string;
  };
}

export async function getDraft(deps: Pick<AiDeps, 'db'>, user: AuthUser, id: string) {
  const { db } = deps;
  const draft = await loadGeneration(db, user, id);
  const [sources, stale] = await Promise.all([
    db
      .from('ai_generation_sources')
      .select('kb_id, kb_version, title, rank, vector_score, text_score, fused_score')
      .eq('generation_id', id)
      .order('rank'),
    db.rpc('draft_stale_sources', { p_generation: id }),
  ]);
  const staleRows = (stale.data ?? []) as { kb_id: string }[];
  const open = ['draft', 'edited', 'approved'].includes(draft.status);
  return {
    draft: { ...draft, stale_policy: open && staleRows.length > 0 },
    sources: sources.data ?? [],
    stale_sources: open ? staleRows : [],
  };
}

export async function latestDraftForConversation(
  deps: Pick<AiDeps, 'db'>,
  user: AuthUser,
  conversationId: string,
) {
  const conv = await loadConversation(deps.db, user, conversationId);
  const { data } = await deps.db
    .from('ai_generations')
    .select('id')
    .eq('conversation_id', conv.id)
    .in('status', ['draft', 'edited', 'approved'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? getDraft(deps, user, data.id) : null;
}

/** Translates the SQL function errors into HTTP errors. */
function mapRpcError(error: { message: string; code?: string }): never {
  const m = error.message;
  if (/STALE_POLICY/.test(m)) {
    throw new HttpError(
      409,
      'STALE_POLICY',
      'A policy used by this draft has changed since it was generated. Regenerate the reply.',
    );
  }
  if (error.code === '42501' || /forbidden/.test(m)) throw forbidden();
  if (error.code === 'P0002' || /not found/.test(m)) throw notFound('Draft');
  if (/must be approved/.test(m))
    throw conflict('Approve the draft before sending it', 'NOT_APPROVED');
  if (/blocking guardrail/.test(m))
    throw new HttpError(
      422,
      'BLOCKED_BY_GUARDRAILS',
      'This draft has failed safety checks and cannot be approved. Edit or regenerate it.',
    );
  if (error.code === 'P0001') throw conflict(m.replace(/^.*?: /, ''), 'INVALID_STATE');
  if (error.code === '22023') throw badRequest(m);
  throw new Error(m);
}

export async function editDraft(
  deps: Pick<AiDeps, 'db'>,
  user: AuthUser,
  id: string,
  body: string,
) {
  await loadGeneration(deps.db, user, id);
  const { error } = await deps.db.rpc('fn_edit_draft', {
    p_generation: id,
    p_actor: user.id,
    p_body: body,
  });
  if (error) mapRpcError(error);
  return getDraft(deps, user, id);
}

export async function approveDraft(deps: Pick<AiDeps, 'db'>, user: AuthUser, id: string) {
  await loadGeneration(deps.db, user, id);
  const { error } = await deps.db.rpc('fn_approve_draft', { p_generation: id, p_actor: user.id });
  if (error) mapRpcError(error);
  return getDraft(deps, user, id);
}

export async function sendDraft(
  deps: Pick<AiDeps, 'db'>,
  user: AuthUser,
  id: string,
  idempotencyKey: string,
) {
  await loadGeneration(deps.db, user, id);
  const { data, error } = await deps.db.rpc('fn_send_draft', {
    p_generation: id,
    p_actor: user.id,
    p_idempotency_key: idempotencyKey,
  });
  if (error) mapRpcError(error);
  return { message: data, ...(await getDraft(deps, user, id)) };
}

export async function discardDraft(deps: Pick<AiDeps, 'db'>, user: AuthUser, id: string) {
  await loadGeneration(deps.db, user, id);
  const { error } = await deps.db.rpc('fn_discard_draft', { p_generation: id, p_actor: user.id });
  if (error) mapRpcError(error);
  return getDraft(deps, user, id);
}

// ------------------------------------------------------------------------------------------------
// Logs
// ------------------------------------------------------------------------------------------------
export interface LogFilters {
  brand_id?: string;
  status?: string;
  agent_id?: string;
  from?: string;
  to?: string;
  limit: number;
}

export async function listLogs(deps: Pick<AiDeps, 'db'>, user: AuthUser, f: LogFilters) {
  const brandIds = f.brand_id ? user.brandIds.filter((b) => b === f.brand_id) : user.brandIds;
  if (brandIds.length === 0) return [];
  let q = deps.db
    .from('ai_generations')
    .select(
      'id, brand_id, conversation_id, status, intent, language, original_body, current_body, escalate, guardrails, model, prompt_tokens, completion_tokens, latency_ms, error_code, error_message, requested_by, approved_at, sent_at, created_at, ' +
        'requester:profiles!ai_generations_requested_by_fkey(full_name), trigger:messages!ai_generations_trigger_message_id_fkey(body), ' +
        'conversations!inner(brands(name), customers(name)), ai_generation_sources(title, kb_version)',
    )
    .in('brand_id', brandIds)
    .order('created_at', { ascending: false })
    .limit(f.limit);
  if (f.status) q = q.eq('status', f.status);
  if (f.agent_id) q = q.eq('requested_by', f.agent_id);
  if (f.from) q = q.gte('created_at', f.from);
  if (f.to) q = q.lte('created_at', f.to);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getLog(deps: Pick<AiDeps, 'db'>, user: AuthUser, id: string) {
  const detail = await getDraft(deps, user, id);
  const g = detail.draft as unknown as Record<string, unknown> & {
    brand_id: string;
    trigger_message_id: string | null;
    final_message_id: string | null;
  };
  const [events, trigger, final, trace] = await Promise.all([
    deps.db
      .from('ai_draft_events')
      .select(
        'id, event_type, from_status, to_status, payload, created_at, actor:profiles(full_name)',
      )
      .eq('generation_id', id)
      .order('created_at'),
    g.trigger_message_id
      ? deps.db
          .from('messages')
          .select('id, body, created_at')
          .eq('id', g.trigger_message_id)
          .maybeSingle()
      : null,
    g.final_message_id
      ? deps.db
          .from('messages')
          .select('id, body, created_at')
          .eq('id', g.final_message_id)
          .maybeSingle()
      : null,
    deps.db.from('ai_generations').select('graph_trace').eq('id', id).single(),
  ]);
  // Withheld candidate text is only for administrators; agents see that a draft was withheld and why.
  const nodes = (
    (trace.data?.graph_trace ?? []) as { node: string; ms: number; note?: string }[]
  ).map((t) =>
    user.role === 'admin' || !t.note?.startsWith('withheld')
      ? t
      : { ...t, note: 'withheld (text hidden)' },
  );
  return {
    ...detail,
    events: events.data ?? [],
    trigger_message: trigger?.data ?? null,
    final_message: final?.data ?? null,
    graph_trace: nodes,
  };
}
