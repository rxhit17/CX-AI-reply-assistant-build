import { Bot, Clock, Inbox, MessageSquareWarning } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import { Card, ErrorState, Skeleton } from '@/components/ui/primitives';
import { useConversations, useLogs } from '@/hooks';

function Stat({ icon, label, value, hint, to }: { icon: ReactNode; label: string; value: string | number; hint?: string; to?: string }) {
  const inner = (
    <Card className="p-4 hover:border-teal-300">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">{icon}{label}</div>
      <p className="mt-2 text-2xl font-semibold" data-testid={`stat-${label}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
  return to ? <Link to={to}>{inner}</Link> : inner;
}

export function Dashboard() {
  const { me } = useAuth();
  const convs = useConversations({});
  const logs = useLogs({});

  if (convs.isPending || logs.isPending) {
    return <div className="grid gap-4 p-6 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28" />)}</div>;
  }
  if (convs.isError || logs.isError) return <ErrorState message={(convs.error ?? logs.error)!.message} onRetry={() => { void convs.refetch(); void logs.refetch(); }} />;

  const open = convs.data.filter((c) => c.status === 'open');
  const awaiting = open.filter((c) => c.last_message_sender === 'customer');
  const unread = convs.data.reduce((n, c) => n + c.unread_count, 0);
  const done = logs.data.filter((l) => l.latency_ms !== null && l.status !== 'failed');
  const avg = done.length ? Math.round(done.reduce((n, l) => n + (l.latency_ms ?? 0), 0) / done.length / 100) / 10 : 0;
  const sent = logs.data.filter((l) => l.status === 'sent');
  const edited = sent.filter((l) => l.current_body !== l.original_body).length;
  const withheld = logs.data.filter((l) => l.guardrails.some((g) => g.check === 'safe_fallback')).length;

  return (
    <div className="scroll-thin h-full overflow-y-auto p-4 md:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <div>
          <h1 className="text-lg font-semibold">Welcome back, {me?.full_name || me?.email}</h1>
          <p className="text-sm text-muted-foreground">Here is what needs attention across your brands.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat icon={<Inbox className="h-4 w-4" />} label="Open conversations" value={open.length} hint={`${unread} unread customer message${unread === 1 ? '' : 's'}`} to="/conversations" />
          <Stat icon={<MessageSquareWarning className="h-4 w-4" />} label="Awaiting your reply" value={awaiting.length} hint="Last message is from the customer" to="/conversations" />
          <Stat icon={<Bot className="h-4 w-4" />} label="AI replies sent" value={sent.length} hint={`${edited} edited by an agent`} to="/logs" />
          <Stat icon={<Clock className="h-4 w-4" />} label="Avg. draft time" value={`${avg}s`} hint={`${withheld} draft${withheld === 1 ? '' : 's'} withheld by safety checks`} to="/logs" />
        </div>
        <Card className="p-4">
          <h2 className="text-sm font-semibold">Recent conversations</h2>
          <ul className="mt-2 divide-y">
            {convs.data.slice(0, 6).map((c) => (
              <li key={c.id}>
                <Link to={`/conversations/${c.id}`} className="flex items-center justify-between gap-3 py-2 text-sm hover:text-primary">
                  <span className="truncate">{c.customer_name} <span className="text-muted-foreground">· {c.brand_name}</span></span>
                  <span className="shrink-0 truncate text-xs text-muted-foreground">{c.last_message_body}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
