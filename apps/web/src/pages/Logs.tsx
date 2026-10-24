import { useQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import { useState } from 'react';
import {
  Card,
  Badge,
  Dialog,
  DialogContent,
  EmptyState,
  ErrorState,
  Select,
  Skeleton,
  ALL,
} from '@/components/ui/primitives';
import { Input } from '@/components/ui/form';
import { useBrands, useLogs } from '@/hooks';
import { api } from '@/lib/api';
import { formatDateTime, titleCase } from '@/lib/format';
import type { DraftResponse, DraftRow, LogRow } from '@/lib/types';

const STATUS_TONE: Record<string, 'neutral' | 'green' | 'amber' | 'red' | 'blue'> = {
  draft: 'blue',
  edited: 'amber',
  approved: 'green',
  sent: 'green',
  discarded: 'neutral',
  superseded: 'neutral',
  withheld: 'red',
  failed: 'red',
};
const STATUSES = [
  'draft',
  'edited',
  'approved',
  'sent',
  'discarded',
  'superseded',
  'withheld',
  'failed',
];

export function Logs() {
  const brands = useBrands();
  const [brand, setBrand] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [agent, setAgent] = useState(ALL);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const logs = useLogs({
    brand_id: brand === ALL ? undefined : brand,
    status: status === ALL ? undefined : status,
    agent_id: agent === ALL ? undefined : agent,
    from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
    to: to ? new Date(`${to}T23:59:59`).toISOString() : undefined,
  });
  const agents = new Map<string, string>();
  for (const l of logs.data ?? [])
    if (l.requested_by && l.requester) agents.set(l.requested_by, l.requester.full_name);

  return (
    <div className="scroll-thin h-full overflow-y-auto p-4 md:p-6">
      <div className="mx-auto max-w-6xl space-y-4">
        <div>
          <h1 className="text-lg font-semibold">AI Logs</h1>
          <p className="text-sm text-muted-foreground">
            Every generation with its sources, safety checks, edits and delivery. Prompts and
            secrets are never stored or shown.
          </p>
        </div>
        <Card className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-5">
          <Select
            aria-label="Filter by brand"
            value={brand}
            onValueChange={setBrand}
            options={[
              { value: ALL, label: 'All brands' },
              ...(brands.data ?? []).map((b) => ({ value: b.id, label: b.name })),
            ]}
          />
          <Select
            aria-label="Filter by status"
            value={status}
            onValueChange={setStatus}
            options={[
              { value: ALL, label: 'Any status' },
              ...STATUSES.map((s) => ({ value: s, label: titleCase(s) })),
            ]}
          />
          <Select
            aria-label="Filter by agent"
            value={agent}
            onValueChange={setAgent}
            options={[
              { value: ALL, label: 'All agents' },
              ...[...agents].map(([id, name]) => ({ value: id, label: name })),
            ]}
          />
          <Input
            aria-label="From date"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <Input
            aria-label="To date"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </Card>

        {logs.isPending ? (
          <Skeleton className="h-64" />
        ) : logs.isError ? (
          <ErrorState message={logs.error.message} onRetry={() => void logs.refetch()} />
        ) : logs.data.length === 0 ? (
          <Card>
            <EmptyState icon={<ScrollText className="h-8 w-8" />} title="No generations yet">
              Generate a reply from a conversation and it will appear here.
            </EmptyState>
          </Card>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-xs" data-testid="logs-table">
              <thead className="border-b bg-muted/50 text-muted-foreground">
                <tr>
                  {[
                    'Time',
                    'Brand / customer',
                    'Customer message',
                    'Intent',
                    'Status',
                    'Model',
                    'Latency',
                    'Tokens',
                    'Checks',
                  ].map((h) => (
                    <th key={h} className="px-3 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {logs.data.map((l) => (
                  <LogLine key={l.id} log={l} onOpen={() => setOpen(l.id)} />
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
      {open && <LogDetail id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function LogLine({ log, onOpen }: { log: LogRow; onOpen: () => void }) {
  const failed = log.guardrails.filter((g) => !g.passed).length;
  return (
    <tr
      className="cursor-pointer border-b last:border-0 hover:bg-muted/40"
      onClick={onOpen}
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      data-testid="log-row"
    >
      <td className="whitespace-nowrap px-3 py-2">{formatDateTime(log.created_at)}</td>
      <td className="px-3 py-2">
        <div>{log.conversations?.brands?.name}</div>
        <div className="text-muted-foreground">{log.conversations?.customers?.name}</div>
      </td>
      <td className="max-w-[220px] truncate px-3 py-2" title={log.trigger?.body}>
        {log.trigger?.body ?? '—'}
      </td>
      <td className="px-3 py-2">{log.intent ? titleCase(log.intent) : '—'}</td>
      <td className="px-3 py-2">
        <Badge tone={STATUS_TONE[log.status]}>{log.status}</Badge>
        {log.error_code && <div className="text-destructive">{log.error_code}</div>}
      </td>
      <td className="px-3 py-2">{log.model ?? '—'}</td>
      <td className="whitespace-nowrap px-3 py-2">{log.latency_ms ?? '—'} ms</td>
      <td className="px-3 py-2">{(log.prompt_tokens ?? 0) + (log.completion_tokens ?? 0)}</td>
      <td className="px-3 py-2">
        {failed ? <Badge tone="amber">{failed} flagged</Badge> : <Badge tone="green">clean</Badge>}
      </td>
    </tr>
  );
}

interface Detail extends DraftResponse {
  events: {
    id: string;
    event_type: string;
    created_at: string;
    actor: { full_name: string } | null;
    payload: Record<string, unknown>;
  }[];
  trigger_message: { body: string; created_at: string } | null;
  final_message: { body: string; created_at: string } | null;
  graph_trace: { node: string; ms: number; note?: string }[];
}

function LogDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['log', id],
    queryFn: () => api.get<Detail>(`/api/ai/logs/${id}`),
  });
  const d = q.data;
  const draft = d?.draft as (DraftRow & { approved_by?: string | null }) | undefined;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Generation detail"
        description="Audit trail for one AI-generated reply."
        className="max-w-3xl"
      >
        {q.isPending ? (
          <Skeleton className="h-48" />
        ) : q.isError ? (
          <ErrorState message={q.error.message} />
        ) : (
          draft &&
          d && (
            <div className="space-y-4 text-xs" data-testid="log-detail">
              <Section title="Customer message">{d.trigger_message?.body ?? '—'}</Section>
              <Section title="Retrieved knowledge">
                {d.sources.length ? (
                  <ul className="list-disc pl-4">
                    {d.sources.map((s) => (
                      <li key={s.kb_id}>
                        {s.title} v{s.kb_version}
                        {s.vector_score !== null && ` · similarity ${s.vector_score.toFixed(2)}`}
                      </li>
                    ))}
                  </ul>
                ) : (
                  'None'
                )}
              </Section>
              <Section title="AI-generated reply">
                <pre className="whitespace-pre-wrap font-sans">
                  {draft.original_body || '(none)'}
                </pre>
              </Section>
              {draft.current_body !== draft.original_body && (
                <Section title="Agent-edited text">
                  <pre className="whitespace-pre-wrap font-sans">{draft.current_body}</pre>
                </Section>
              )}
              <Section title="Final response sent">
                {d.final_message ? (
                  <pre className="whitespace-pre-wrap font-sans">{d.final_message.body}</pre>
                ) : (
                  'Not sent'
                )}
              </Section>
              <Section title="Safety checks">
                <ul className="space-y-0.5">
                  {draft.guardrails.map((g) => (
                    <li
                      key={g.check}
                      className={
                        g.passed
                          ? 'text-emerald-700'
                          : g.severity === 'blocking'
                            ? 'text-red-700'
                            : 'text-amber-700'
                      }
                    >
                      {g.passed ? '✓' : '✗'} {titleCase(g.check)}
                      {g.detail ? `: ${g.detail}` : ''}
                    </li>
                  ))}
                </ul>
              </Section>
              <Section title="Timeline">
                <ol className="space-y-0.5">
                  {d.events.map((e) => (
                    <li key={e.id}>
                      {formatDateTime(e.created_at)} · {e.event_type}
                      {e.actor ? ` by ${e.actor.full_name}` : ''}
                    </li>
                  ))}
                </ol>
              </Section>
              <Section title="Run">
                {draft.model} · {draft.latency_ms} ms · {draft.prompt_tokens}+
                {draft.completion_tokens} tokens (approx.)
                {draft.error_code && (
                  <span className="text-destructive">
                    {' '}
                    · {draft.error_code}: {draft.error_message}
                  </span>
                )}
                <div className="mt-1 text-muted-foreground">
                  {d.graph_trace.map((t) => `${t.node} ${t.ms}ms`).join(' → ')}
                </div>
              </Section>
            </div>
          )
        )}
      </DialogContent>
    </Dialog>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div>
    <p className="mb-1 font-semibold">{title}</p>
    <div className="rounded border bg-muted/30 p-2">{children}</div>
  </div>
);
