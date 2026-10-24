import { Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form';
import { ALL, Badge, EmptyState, ErrorState, Select, Skeleton } from '@/components/ui/primitives';
import { useBrands, useConversations } from '@/hooks';
import { relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { NewConversationDialog } from './NewConversationDialog';

export function ConversationList({ activeId }: { activeId?: string }) {
  const brands = useBrands();
  const [q, setQ] = useState('');
  const [brand, setBrand] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [creating, setCreating] = useState(false);
  const list = useConversations({
    q: q.trim() || undefined,
    brand_id: brand === ALL ? undefined : brand,
    status: status === ALL ? undefined : status,
  });

  return (
    <div className="flex h-full flex-col bg-card">
      <div className="space-y-2 border-b p-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Conversations</h2>
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> New
          </Button>
        </div>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
            aria-hidden
          />
          <Input
            aria-label="Search conversations"
            placeholder="Search customer or message"
            className="pl-8"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
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
              { value: 'open', label: 'Open' },
              { value: 'closed', label: 'Closed' },
            ]}
          />
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto" data-testid="conversation-list">
        {list.isPending ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState message={list.error.message} onRetry={() => void list.refetch()} />
        ) : list.data.length === 0 ? (
          <EmptyState title="No conversations found">
            Adjust the filters, or start a new conversation with the button above.
          </EmptyState>
        ) : (
          <ul>
            {list.data.map((c) => (
              <li key={c.id}>
                <Link
                  to={`/conversations/${c.id}`}
                  aria-current={c.id === activeId ? 'page' : undefined}
                  data-testid="conversation-item"
                  className={cn(
                    'block border-b px-3 py-3 hover:bg-muted/60',
                    c.id === activeId && 'bg-teal-50/70 hover:bg-teal-50/70',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{c.customer_name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {relativeTime(c.last_activity_at)}
                    </span>
                  </div>
                  <p
                    className={cn(
                      'mt-0.5 truncate text-xs',
                      c.unread_count > 0 ? 'font-medium text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {c.last_message_sender === 'agent' && 'You: '}
                    {c.last_message_body || '(attachment)'}
                  </p>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <Badge tone="violet">{c.brand_name}</Badge>
                    <Badge tone={c.status === 'open' ? 'green' : 'neutral'}>{c.status}</Badge>
                    {c.unread_count > 0 && (
                      <Badge tone="red" aria-label={`${c.unread_count} unread`}>
                        {c.unread_count} new
                      </Badge>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      <NewConversationDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
