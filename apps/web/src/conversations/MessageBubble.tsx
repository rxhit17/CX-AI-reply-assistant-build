import { Check, CheckCheck, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Dialog, DialogContent } from '@/components/ui/primitives';
import { formatTime } from '@/lib/format';
import type { MessageRow } from '@/lib/types';
import { cn } from '@/lib/utils';

export function MessageBubble({
  message,
  customerName,
  agentName,
}: {
  message: MessageRow;
  customerName: string;
  agentName?: string;
}) {
  const [zoom, setZoom] = useState<string | null>(null);
  const fromCustomer = message.sender_type === 'customer';
  const isAi = Boolean(message.ai_generation_id);
  const images = message.attachments ?? [];

  return (
    <div
      className={cn('flex', fromCustomer ? 'justify-start' : 'justify-end')}
      data-testid={`message-${message.sender_type}`}
    >
      <div className={cn('max-w-[78%] space-y-1')}>
        <p className={cn('px-1 text-[11px] text-muted-foreground', !fromCustomer && 'text-right')}>
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
            fromCustomer
              ? 'rounded-tl-sm bg-white ring-1 ring-slate-200'
              : 'rounded-tr-sm bg-primary text-primary-foreground',
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
            !fromCustomer && 'justify-end',
          )}
        >
          <time dateTime={message.created_at}>{formatTime(message.created_at)}</time>
          {!fromCustomer &&
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
