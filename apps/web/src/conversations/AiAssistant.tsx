import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  RefreshCw,
  Send,
  ShieldAlert,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/form';
import { Badge, Card, ErrorState, Skeleton } from '@/components/ui/primitives';
import { useDraft } from '@/hooks';
import { api, ApiError, errorMessage } from '@/lib/api';
import { titleCase } from '@/lib/format';
import type { DraftResponse } from '@/lib/types';
import { newId } from '@/lib/utils';

const OUTCOME_TONE = {
  eligible: 'green',
  ineligible: 'red',
  needs_review: 'amber',
  insufficient_data: 'neutral',
} as const;
const STATUS_TONE = { draft: 'blue', edited: 'amber', approved: 'green' } as const;

function useElapsed(active: boolean) {
  const [s, setS] = useState(0);
  useEffect(() => {
    if (!active) return setS(0);
    const t = setInterval(() => setS((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
  return s;
}

export function AiAssistant({
  conversationId,
  hasCustomerMessage,
}: {
  conversationId: string;
  hasCustomerMessage: boolean;
}) {
  const queryClient = useQueryClient();
  const draftQuery = useDraft(conversationId);
  const draft = draftQuery.data?.draft ?? null;
  const [instruction, setInstruction] = useState('');
  const sendKey = useRef<{ id: string; key: string } | null>(null);

  // The editor shows the server copy unless the agent has typed a local edit for this exact draft.
  const [local, setLocal] = useState<{ id: string; text: string } | null>(null);
  const body = draft ? (local?.id === draft.id ? local.text : draft.current_body) : '';
  const dirty = draft !== null && body !== draft.current_body;
  const setBody = (text: string) => draft && setLocal({ id: draft.id, text });

  const apply = (res: DraftResponse) => queryClient.setQueryData(['draft', conversationId], res);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['draft', conversationId] });
    void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
    void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    void queryClient.invalidateQueries({ queryKey: ['logs'] });
  };
  const fail = (err: unknown) => {
    toast.error(errorMessage(err));
    if (err instanceof ApiError && ['STALE_POLICY', 'INVALID_STATE'].includes(err.code)) refresh();
  };

  const generate = useMutation({
    mutationFn: (regenerateOf?: string) =>
      regenerateOf
        ? api.post<DraftResponse>('/api/ai/regenerate', {
            conversation_id: conversationId,
            options: {
              regenerate_of: regenerateOf,
              extra_instruction: instruction.trim() || undefined,
            },
          })
        : api.post<DraftResponse>('/api/ai/generate', { conversation_id: conversationId }),
    onSuccess: (res) => {
      apply(res);
      setInstruction('');
      refresh();
    },
    onError: fail,
  });
  const edit = useMutation({
    mutationFn: () =>
      api.patch<DraftResponse>(`/api/ai/drafts/${draft!.id}`, { body: body.trim() }),
    onSuccess: (res) => {
      apply(res);
      setLocal(null);
      toast.success('Edit saved');
    },
    onError: fail,
  });
  const approve = useMutation({
    mutationFn: async () => {
      if (dirty)
        await api.patch<DraftResponse>(`/api/ai/drafts/${draft!.id}`, { body: body.trim() });
      return api.post<DraftResponse>(`/api/ai/drafts/${draft!.id}/approve`);
    },
    onSuccess: (res) => {
      apply(res);
      setLocal(null);
      toast.success('Approved. It has not been sent yet.');
    },
    onError: fail,
  });
  const send = useMutation({
    mutationFn: () => {
      if (sendKey.current?.id !== draft!.id) sendKey.current = { id: draft!.id, key: newId() };
      return api.post(`/api/ai/drafts/${draft!.id}/send`, { idempotency_key: sendKey.current.key });
    },
    onSuccess: () => {
      toast.success('Reply sent to the customer');
      sendKey.current = null;
      queryClient.setQueryData(['draft', conversationId], {
        draft: null,
        sources: [],
        stale_sources: [],
      });
      refresh();
    },
    onError: fail,
  });
  const discard = useMutation({
    mutationFn: () => api.post(`/api/ai/drafts/${draft!.id}/discard`),
    onSuccess: () => {
      queryClient.setQueryData(['draft', conversationId], {
        draft: null,
        sources: [],
        stale_sources: [],
      });
      refresh();
    },
    onError: fail,
  });

  const elapsed = useElapsed(generate.isPending);
  const busy =
    generate.isPending ||
    edit.isPending ||
    approve.isPending ||
    send.isPending ||
    discard.isPending;

  if (draftQuery.isPending) return <Skeleton className="h-40" />;
  if (draftQuery.isError)
    return (
      <ErrorState message={draftQuery.error.message} onRetry={() => void draftQuery.refetch()} />
    );

  const sources = draftQuery.data?.sources ?? [];
  const blocking = draft?.guardrails.filter((g) => !g.passed && g.severity === 'blocking') ?? [];
  const warnings = draft?.guardrails.filter((g) => !g.passed && g.severity !== 'blocking') ?? [];
  const passed = draft?.guardrails.filter((g) => g.passed).length ?? 0;
  const stale = Boolean(draft?.stale_policy);
  const fallback = draft?.guardrails.some((g) => g.check === 'safe_fallback');

  return (
    <section aria-label="AI assistant" className="space-y-3" data-testid="ai-panel">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Sparkles className="h-4 w-4 text-primary" aria-hidden /> AI assistant
        </h3>
        {draft && (
          <Badge
            tone={STATUS_TONE[draft.status as keyof typeof STATUS_TONE] ?? 'neutral'}
            data-testid="draft-status"
          >
            {draft.status}
          </Badge>
        )}
      </div>

      {generate.isPending && (
        <Card className="space-y-2 p-3" role="status" data-testid="generating">
          <p className="flex items-center gap-2 text-sm">
            <RefreshCw className="h-4 w-4 animate-spin text-primary" aria-hidden /> Drafting a
            reply… {elapsed}s
          </p>
          <p className="text-xs text-muted-foreground">
            Reading the conversation and verified order facts, searching this brand's policies,
            checking eligibility, writing the draft and running safety checks. Usually 5–10 seconds.
          </p>
        </Card>
      )}

      {!draft && !generate.isPending && (
        <Card className="space-y-2 p-3">
          <p className="text-xs text-muted-foreground">
            Generates a draft reply from this brand's knowledge base and the verified order. Nothing
            is sent until you approve and send it.
          </p>
          <Button
            className="w-full"
            onClick={() => generate.mutate(undefined)}
            disabled={!hasCustomerMessage || busy}
            data-testid="generate-reply"
          >
            <Sparkles className="h-4 w-4" aria-hidden /> Generate AI reply
          </Button>
          {!hasCustomerMessage && (
            <p className="text-xs text-amber-700">There is no customer message to reply to yet.</p>
          )}
        </Card>
      )}

      {draft && !generate.isPending && (
        <div className="space-y-3">
          {stale && (
            <div
              role="alert"
              className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900"
              data-testid="stale-warning"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <p>
                A policy this draft relied on has changed since it was written. Regenerate before
                approving or sending.
              </p>
            </div>
          )}
          {fallback && (
            <div
              role="alert"
              className="flex gap-2 rounded-md border border-red-200 bg-red-50 p-2.5 text-xs text-red-900"
              data-testid="fallback-warning"
            >
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <p>
                The AI draft was withheld by safety checks. This is a neutral holding message;
                review the order and reply yourself, or escalate.
              </p>
            </div>
          )}
          {draft.escalate && !fallback && (
            <div className="rounded-md border border-sky-200 bg-sky-50 p-2.5 text-xs text-sky-900">
              The assistant suggests human review before anything is promised.
            </div>
          )}
          {blocking.map((g) => (
            <div
              key={g.check}
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 p-2.5 text-xs text-red-900"
            >
              <strong>{titleCase(g.check)}:</strong> {g.detail}
            </div>
          ))}

          <div>
            <label htmlFor="draft-body" className="mb-1 block text-xs font-medium">
              Draft reply {dirty && <span className="text-amber-700">· unsaved changes</span>}
            </label>
            <Textarea
              id="draft-body"
              className="min-h-[170px] text-sm"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              data-testid="draft-body"
              disabled={busy}
            />
            {draft.status === 'approved' && (
              <p className="mt-1 text-xs text-muted-foreground">
                Editing an approved draft requires approving it again.
              </p>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            {dirty && (
              <Button
                size="sm"
                variant="outline"
                loading={edit.isPending}
                disabled={busy || body.trim().length === 0}
                onClick={() => edit.mutate()}
                data-testid="save-edit"
              >
                Save edit
              </Button>
            )}
            {draft.status !== 'approved' || dirty ? (
              <Button
                size="sm"
                loading={approve.isPending}
                disabled={busy || stale || blocking.length > 0 || body.trim().length === 0}
                onClick={() => approve.mutate()}
                data-testid="approve-draft"
              >
                <CheckCircle2 className="h-4 w-4" aria-hidden />{' '}
                {dirty ? 'Save & approve' : 'Approve'}
              </Button>
            ) : (
              <Button
                size="sm"
                loading={send.isPending}
                disabled={busy || stale}
                onClick={() => send.mutate()}
                data-testid="send-draft"
              >
                <Send className="h-4 w-4" aria-hidden /> Send to customer
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              loading={discard.isPending}
              onClick={() => discard.mutate()}
              data-testid="discard-draft"
            >
              <Trash2 className="h-4 w-4" aria-hidden /> Discard
            </Button>
          </div>

          <details className="rounded-md border bg-muted/40 p-2 text-xs">
            <summary className="cursor-pointer font-medium">Regenerate with an instruction</summary>
            <div className="mt-2 space-y-2">
              <Textarea
                aria-label="Extra instruction for the assistant"
                placeholder="e.g. Keep it shorter. Policy rules still apply."
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                maxLength={500}
                className="min-h-[56px] text-xs"
              />
              <Button
                size="sm"
                variant="outline"
                loading={generate.isPending}
                disabled={busy}
                onClick={() => generate.mutate(draft.id)}
                data-testid="regenerate"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Regenerate
              </Button>
            </div>
          </details>

          <Evidence draft={draft} sources={sources} warnings={warnings} passed={passed} />
        </div>
      )}
    </section>
  );
}

function Evidence({
  draft,
  sources,
  warnings,
  passed,
}: {
  draft: NonNullable<DraftResponse['draft']>;
  sources: DraftResponse['sources'];
  warnings: NonNullable<DraftResponse['draft']>['guardrails'];
  passed: number;
}) {
  return (
    <div className="space-y-3 text-xs" data-testid="evidence">
      <div>
        <p className="mb-1 flex items-center gap-1 font-medium">
          <BookOpen className="h-3.5 w-3.5" aria-hidden /> Knowledge used
        </p>
        {sources.length === 0 ? (
          <p className="text-muted-foreground">No policy entries were used for this draft.</p>
        ) : (
          <ul className="space-y-1" data-testid="sources">
            {sources.map((s) => (
              <li
                key={s.kb_id}
                className="flex items-center justify-between gap-2 rounded border bg-card px-2 py-1"
              >
                <span className="truncate" title={s.title}>
                  {s.title}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  v{s.kb_version}
                  {s.vector_score !== null
                    ? ` · ${(s.vector_score * 100).toFixed(0)}% match`
                    : ' · direct policy lookup'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {draft.case_state && (
        <div data-testid="case-understanding">
          <p className="mb-1 font-medium">What the assistant understood</p>
          <div className="space-y-1 rounded border bg-card px-2 py-1.5">
            <p>
              <span className="text-muted-foreground">Issue:</span>{' '}
              {titleCase(draft.case_state.issue_type)} ·{' '}
              <span className="text-muted-foreground">Customer wants:</span>{' '}
              {titleCase(draft.case_state.desired_resolution)}
              {draft.case_state.resolution_confirmed && (
                <Badge tone="green" className="ml-1">
                  confirmed
                </Badge>
              )}
            </p>
            {draft.case_state.confirmed_facts.length > 0 && (
              <p>
                <span className="text-muted-foreground">Customer says (unverified):</span>{' '}
                {draft.case_state.confirmed_facts.map(titleCase).join(', ')}
              </p>
            )}
            {draft.case_state.corrections.length > 0 && (
              <p>
                <span className="text-muted-foreground">Correction applied:</span>{' '}
                {draft.case_state.corrections.join('; ')}
              </p>
            )}
            {draft.case_state.derived && (
              <p>
                <span className="text-muted-foreground">Next action:</span>{' '}
                {titleCase(draft.case_state.derived.next_action)}
                {draft.case_state.derived.missing_information.length > 0 &&
                  ` · missing: ${draft.case_state.derived.missing_information.map(titleCase).join(', ')}`}
              </p>
            )}
          </div>
        </div>
      )}

      {draft.eligibility.length > 0 && (
        <div>
          <p className="mb-1 font-medium">Policy checks (computed by software)</p>
          <ul className="space-y-1" data-testid="eligibility">
            {draft.eligibility.map((e) => (
              <li key={e.kind} className="rounded border bg-card px-2 py-1.5">
                <div className="flex items-center gap-1.5">
                  <Badge tone={OUTCOME_TONE[e.outcome]}>{titleCase(e.outcome)}</Badge>
                  <span className="font-medium">{titleCase(e.kind)}</span>
                </div>
                <p className="mt-1 text-muted-foreground">{e.reason}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {draft.image_evidence && (
        <div>
          <p className="mb-1 font-medium">Photo review</p>
          <p className="rounded border bg-card px-2 py-1.5 text-muted-foreground">
            {draft.image_evidence.description}{' '}
            <span className="font-medium">
              (damage visible: {draft.image_evidence.visible_damage};{' '}
              {draft.image_evidence.confidence} confidence. Not proof; the team verifies.)
            </span>
          </p>
        </div>
      )}

      {warnings.length > 0 && (
        <ul className="space-y-1" data-testid="warnings">
          {warnings.map((w) => (
            <li
              key={w.check}
              className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-900"
            >
              <strong>{titleCase(w.check)}:</strong> {w.detail}
            </li>
          ))}
        </ul>
      )}
      <p className="text-muted-foreground">
        {passed} safety checks passed · {draft.model ?? 'model n/a'} · {draft.latency_ms ?? '?'} ms
        · {(draft.prompt_tokens ?? 0) + (draft.completion_tokens ?? 0)} tokens
      </p>
    </div>
  );
}
