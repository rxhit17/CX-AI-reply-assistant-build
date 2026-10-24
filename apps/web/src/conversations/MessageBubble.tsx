import { Ban, Check, CheckCheck, Sparkles, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/auth/AuthProvider';
import { Dialog, DialogContent } from '@/components/ui/primitives';
import { formatTime } from '@/lib/format';
import type { MessageRow } from '@/lib/types';
import { cn } from '@/lib/utils';

export function MessageBubble({
  message,
  customerName,
  agentName,
  viewAs = 'agent',
  onUnsend,
  unsending = false,
}: {
  message: MessageRow;
  customerName: string;
  agentName?: string;
  /** Whose side of the conversation is being viewed: that side's own messages sit on the right. */
  viewAs?: 'agent' | 'customer';
  /** Withdraws the message. Only offered on the viewer's own messages. */
  onUnsend?: () => void;
  unsending?: boolean;
}) {
  const { me } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [zoom, setZoom] = useState<string | null>(null);
  const fromCustomer = message.sender_type === 'customer';
  const mine = viewAs === 'customer' ? fromCustomer : !fromCustomer;
  const isAi = Boolean(message.ai_generation_id);
  const images = message.attachments ?? [];
  const unsent = Boolean(message.unsent_at);
  // Agents may unsend their own messages (admins any); the simulator may unsend the customer's.
  const canUnsend =
    Boolean(onUnsend) &&
    !unsent &&
    mine &&
    message.sender_type !== 'system' &&
    (fromCustomer || message.sender_id === me?.id || me?.role === 'admin');

  if (unsent) {
    return (
      <div
        className={cn('flex', mine ? 'justify-end' : 'justify-start')}
        data-testid="message-unsent"
      >
        <div className="max-w-[78%] space-y-1">
          <p
            className={cn(
              'flex items-center gap-1.5 rounded-2xl border border-dashed px-3.5 py-2 text-sm italic text-muted-foreground',
              mine && 'justify-end',
            )}
          >
            <Ban className="h-3.5 w-3.5" aria-hidden />
            {mine ? 'You unsent a message' : 'This message was unsent'}
          </p>
          <p className={cn('px-1 text-[11px] text-muted-foreground', mine && 'text-right')}>
            <time dateTime={message.created_at}>{formatTime(message.created_at)}</time>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn('flex', mine ? 'justify-end' : 'justify-start')}
      data-testid={`message-${message.sender_type}`}
    >
      <div className={cn('max-w-[78%] space-y-1')}>
        <p className={cn('px-1 text-[11px] text-muted-foreground', mine && 'text-right')}>
          {fromCustomer ? customerName : (agentName ?? 'Agent')}
          {isAi && (
            <span
              className="ml-1.5 inline-flex items-center gap-0.5 text-teal-700"
              title="AI-assisted reply approved by an agent"
            >
              <Sparkles className="h-3 w-3" aria-hidden /> AI-assisted
            </span>
          )}
        </p>
        <div
          className={cn(
            'rounded-2xl px-3.5 py-2 text-sm shadow-sm',
            mine
              ? 'rounded-tr-sm bg-primary text-primary-foreground'
              : 'rounded-tl-sm bg-white ring-1 ring-slate-200',
          )}
        >
          {images.length > 0 && (
            <div className={cn('mb-2 grid gap-1.5', images.length > 1 && 'grid-cols-2')}>
              {images.map((a) =>
                a.url ? (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setZoom(a.url)}
                    className="overflow-hidden rounded-lg"
                  >
                    <img
                      src={a.url}
                      alt="Attached image"
                      className="max-h-56 w-full object-cover"
                      loading="lazy"
                    />
                  </button>
                ) : (
                  <div key={a.id} className="rounded bg-black/10 p-2 text-xs">
                    Image unavailable
                  </div>
                ),
              )}
            </div>
          )}
          {message.body && <p className="whitespace-pre-wrap break-words">{message.body}</p>}
        </div>
        <p
          className={cn(
            'flex items-center gap-1 px-1 text-[11px] text-muted-foreground',
            mine && 'justify-end',
          )}
        >
          <time dateTime={message.created_at}>{formatTime(message.created_at)}</time>
          {canUnsend && (
            <button
              type="button"
              className="inline-flex items-center gap-0.5 hover:text-foreground hover:underline"
              onClick={() => setConfirming(true)}
              data-testid="unsend-message"
            >
              <Undo2 className="h-3 w-3" aria-hidden /> Unsend
            </button>
          )}
          {!fromCustomer &&
            viewAs === 'agent' &&
            (message.read_at ? (
              <span className="inline-flex items-center gap-0.5 text-sky-600" title="Read">
                <CheckCheck className="h-3.5 w-3.5" aria-hidden /> Read
              </span>
            ) : message.delivered_at ? (
              <span className="inline-flex items-center gap-0.5" title="Delivered">
                <Check className="h-3.5 w-3.5" aria-hidden /> Delivered
              </span>
            ) : null)}
        </p>
      </div>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent
          title="Unsend this message?"
          description="It will be removed for everyone in this conversation. This cannot be undone."
          className="max-w-md"
        >
          <p className="mb-4 line-clamp-4 whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 text-sm">
            {message.body || (images.length > 0 ? 'Image attachment' : '')}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={unsending}
              data-testid="confirm-unsend"
              onClick={() => {
                onUnsend?.();
                setConfirming(false);
              }}
            >
              Unsend for everyone
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={zoom !== null} onOpenChange={(o) => !o && setZoom(null)}>
        <DialogContent title="Attachment" className="max-w-3xl">
          {zoom && (
            <img
              src={zoom}
              alt="Attachment full size"
              className="max-h-[75vh] w-full object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
