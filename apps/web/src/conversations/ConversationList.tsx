import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form';
import { ALL, Badge, EmptyState, ErrorState, Select, Skeleton } from '@/components/ui/primitives';
import { useBrands, useConversations, useCustomers } from '@/hooks';
import { api, errorMessage } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import type { ConversationListItem } from '@/lib/types';
import { cn } from '@/lib/utils';
import { NewConversationDialog } from './NewConversationDialog';

const ROW =
  'block w-full border-b border-l-4 border-l-transparent px-3 py-3 text-left hover:bg-muted/60';
/** The customer whose chat is open: light blue with a blue edge, so it is obvious where you clicked. */
const SELECTED = 'border-l-blue-500 bg-blue-100 hover:bg-blue-100';

/** Every customer of the selected brand(s) is listed; the latest conversation (if any) is shown under the name. */
export function ConversationList({ activeId }: { activeId?: string }) {
  const brands = useBrands();
  const [q, setQ] = useState('');
  const [brand, setBrand] = useState(ALL);
  const [creating, setCreating] = useState(false);
  const brandId = brand === ALL ? undefined : brand;
  const customers = useCustomers(brandId);
  const conversations = useConversations({ brand_id: brandId });
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const start = useMutation({
    mutationFn: (customerId: string) =>
      api.post<{ conversation: { id: string } }>('/api/conversations', {
        customer_id: customerId,
        order_id: null,
      }),
    onSuccess: ({ conversation }) => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      navigate(`/conversations/${conversation.id}`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const brandName = useMemo(
    () => new Map((brands.data ?? []).map((b) => [b.id, b.name])),
    [brands.data],
  );

  const rows = useMemo(() => {
    // The list is ordered by recent activity, so the first conversation seen per customer is the latest.
    const latest = new Map<string, ConversationListItem>();
    for (const c of conversations.data ?? [])
      if (!latest.has(c.customer_id)) latest.set(c.customer_id, c);
    const term = q.trim().toLowerCase();
    return (customers.data ?? [])
      .map((customer) => ({ customer, conversation: latest.get(customer.id) ?? null }))
      .filter(
        ({ customer, conversation }) =>
          !term ||
          customer.name.toLowerCase().includes(term) ||
          customer.email.toLowerCase().includes(term) ||
          (conversation?.last_message_body ?? '').toLowerCase().includes(term),
      )
      .sort((a, b) => {
        if (a.conversation && b.conversation)
          return b.conversation.last_activity_at.localeCompare(a.conversation.last_activity_at);
        if (a.conversation) return -1;
        if (b.conversation) return 1;
        return a.customer.name.localeCompare(b.customer.name);
      });
  }, [customers.data, conversations.data, q]);

  const pending = customers.isPending || conversations.isPending;
  const error = customers.error ?? conversations.error;

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
        <Select
          aria-label="Filter by brand"
          value={brand}
          onValueChange={setBrand}
          options={[
            { value: ALL, label: 'All brands' },
            ...(brands.data ?? []).map((b) => ({ value: b.id, label: b.name })),
          ]}
        />
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto" data-testid="conversation-list">
        {pending ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : error ? (
          <ErrorState
            message={error.message}
            onRetry={() => {
              void customers.refetch();
              void conversations.refetch();
            }}
          />
        ) : rows.length === 0 ? (
          <EmptyState title="No customers found">Adjust the search or the brand filter.</EmptyState>
        ) : (
          <ul>
            {rows.map(({ customer, conversation: c }) => (
              <li key={customer.id}>
                {c ? (
                  <Link
                    to={`/conversations/${c.id}`}
                    aria-current={c.id === activeId ? 'page' : undefined}
                    data-testid="conversation-item"
                    className={cn(ROW, c.id === activeId && SELECTED)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{customer.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {relativeTime(c.last_activity_at)}
                      </span>
                    </div>
                    <p
                      className={cn(
                        'mt-0.5 truncate text-xs',
                        c.unread_count > 0
                          ? 'font-medium text-foreground'
                          : 'text-muted-foreground',
                      )}
                    >
                      {c.last_message_sender === 'agent' && 'You: '}
                      {c.last_message_body ||
                        (c.last_message_sender ? '(attachment)' : 'No messages yet')}
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
                ) : (
                  <button
                    type="button"
                    data-testid="customer-item"
                    disabled={start.isPending}
                    onClick={() => start.mutate(customer.id)}
                    className={cn(
                      ROW,
                      start.isPending && start.variables === customer.id && SELECTED,
                    )}
                  >
                    <span className="block truncate text-sm font-medium">{customer.name}</span>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      No messages yet · click to start a conversation
                    </p>
                    <div className="mt-1.5">
                      <Badge tone="violet">{brandName.get(customer.brand_id) ?? 'Brand'}</Badge>
                    </div>
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <NewConversationDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
