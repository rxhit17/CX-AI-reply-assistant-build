import { Mail, Languages, Package, Truck } from 'lucide-react';
import { Badge, Card, ErrorState, Skeleton } from '@/components/ui/primitives';
import { useConversation, useOrder } from '@/hooks';
import { formatDate, money, titleCase } from '@/lib/format';
import { AiAssistant } from './AiAssistant';

const ORDER_TONE = {
  delivered: 'green',
  in_transit: 'blue',
  shipped: 'blue',
  processing: 'amber',
  cancelled: 'red',
} as const;

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex justify-between gap-3 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}

export function SidePanel({ conversationId }: { conversationId: string }) {
  const detail = useConversation(conversationId);
  const order = useOrder(conversationId);

  if (detail.isPending)
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-32" />
      </div>
    );
  if (detail.isError)
    return <ErrorState message={detail.error.message} onRetry={() => void detail.refetch()} />;
  const { customer, brand, messages } = detail.data;

  return (
    <div className="scroll-thin h-full space-y-4 overflow-y-auto p-4">
      <Card className="space-y-2 p-3" aria-label="Customer profile">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold" data-testid="profile-name">
            {customer.name}
          </h3>
          <Badge tone="violet">{brand.name}</Badge>
        </div>
        <dl className="space-y-1">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Mail className="h-3.5 w-3.5" aria-hidden /> {customer.email}
          </p>
          {customer.preferred_language && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Languages className="h-3.5 w-3.5" aria-hidden /> Prefers{' '}
              {customer.preferred_language.toUpperCase()}
            </p>
          )}
        </dl>
      </Card>

      <Card className="space-y-2 p-3" aria-label="Order information">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Package className="h-4 w-4" aria-hidden /> Order
        </h3>
        {order.isPending ? (
          <Skeleton className="h-20" />
        ) : order.isError ? (
          <p className="text-xs text-destructive">Could not load the order.</p>
        ) : !order.data ? (
          <p className="text-xs text-muted-foreground">
            No order is linked to this conversation. The assistant cannot check eligibility without
            one.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium" data-testid="order-number">
                {order.data.order_number}
              </span>
              <Badge tone={ORDER_TONE[order.data.status]}>{titleCase(order.data.status)}</Badge>
            </div>
            <dl className="space-y-1">
              <Row
                label="Order value"
                value={money(Number(order.data.total), order.data.currency)}
              />
              <Row label="Placed" value={formatDate(order.data.placed_at)} />
              <Row
                label="Shipped"
                value={order.data.shipped_at ? formatDate(order.data.shipped_at) : null}
              />
              <Row
                label="Delivered"
                value={order.data.delivered_at ? formatDate(order.data.delivered_at) : null}
              />
              <Row
                label="Estimated delivery"
                value={
                  order.data.estimated_delivery_at && !order.data.delivered_at
                    ? formatDate(order.data.estimated_delivery_at)
                    : null
                }
              />
            </dl>
            <ul className="border-t pt-2 text-xs">
              {order.data.items.map((i) => (
                <li key={i.id} className="flex justify-between gap-2">
                  <span className="truncate">
                    {i.quantity}× {i.name}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {money(Number(i.unit_price), order.data!.currency)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Truck className="h-3 w-3" aria-hidden /> Verified from the order system.
            </p>
          </>
        )}
      </Card>

      <AiAssistant
        conversationId={conversationId}
        hasCustomerMessage={messages.some((m) => m.sender_type === 'customer')}
      />
    </div>
  );
}
