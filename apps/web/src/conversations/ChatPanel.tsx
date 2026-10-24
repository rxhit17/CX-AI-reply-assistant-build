import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ImagePlus, Lock, Send, UserRound, Headset, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { toast } from 'sonner';
import { ALLOWED_IMAGE_MIME, MAX_IMAGE_BYTES } from '@cx/shared';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/form';
import { Badge, EmptyState, ErrorState, Skeleton } from '@/components/ui/primitives';
import { useConversation } from '@/hooks';
import { api, errorMessage } from '@/lib/api';
import type { AttachmentRow, ConversationDetail, MessageRow } from '@/lib/types';
import { cn, newId } from '@/lib/utils';
import { MessageBubble } from './MessageBubble';

type Mode = 'agent' | 'customer';

export function ChatPanel({ conversationId }: { conversationId: string }) {
  const { me } = useAuth();
  const queryClient = useQueryClient();
  const detail = useConversation(conversationId);
  const [mode, setMode] = useState<Mode>('agent');
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<AttachmentRow[]>([]);
  const clientId = useRef(newId()); // idempotency key for the message being composed
  const fileInput = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const messages = detail.data?.messages;

  // Reset the composer when switching conversation.
  useEffect(() => {
    setText('');
    setAttachments([]);
    clientId.current = newId();
  }, [conversationId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages?.length, conversationId]);

  // Mark the other side's messages as read while the conversation is open.
  const unread = messages?.filter((m) => !m.read_at && m.sender_type === (mode === 'agent' ? 'customer' : 'agent')).length ?? 0;
  useEffect(() => {
    if (unread === 0) return;
    api
      .post(`/api/conversations/${conversationId}/read`, { reader: mode })
      .then(() => queryClient.invalidateQueries({ queryKey: ['conversations'] }))
      .catch(() => undefined);
  }, [unread, mode, conversationId, queryClient]);

  const upload = useMutation({
    mutationFn: (file: File) => api.upload<{ attachment: AttachmentRow }>(`/api/conversations/${conversationId}/attachments`, file),
    onSuccess: ({ attachment }) => setAttachments((a) => [...a, attachment]),
    onError: (err) => toast.error(errorMessage(err)),
  });

  const send = useMutation({
    mutationFn: () =>
      api.post<{ message: MessageRow }>(`/api/conversations/${conversationId}/messages`, {
        body: text.trim(),
        sender_type: mode,
        client_message_id: clientId.current,
        attachment_ids: attachments.map((a) => a.id),
      }),
    onSuccess: ({ message }) => {
      queryClient.setQueryData<ConversationDetail>(['conversation', conversationId], (old) =>
        old && !old.messages.some((m) => m.id === message.id) ? { ...old, messages: [...old.messages, message] } : old,
      );
      setText('');
      setAttachments([]);
      clientId.current = newId();
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      void queryClient.invalidateQueries({ queryKey: ['draft', conversationId] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const status = useMutation({
    mutationFn: (next: 'open' | 'closed') => api.patch(`/api/conversations/${conversationId}`, { status: next }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function pickFile(file: File | undefined) {
    if (!file) return;
    if (!(ALLOWED_IMAGE_MIME as readonly string[]).includes(file.type)) {
      toast.error('Only PNG, JPEG, WebP and GIF images can be attached.');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast.error('That image is larger than 5 MB.');
      return;
    }
    if (attachments.length >= 4) {
      toast.error('You can attach up to 4 images per message.');
      return;
    }
    upload.mutate(file);
  }

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !send.isPending && !upload.isPending;
  const submit = () => canSend && send.mutate();
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  if (detail.isPending) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-16 w-2/3" />
        <Skeleton className="ml-auto h-16 w-2/3" />
      </div>
    );
  }
  if (detail.isError) return <ErrorState message={detail.error.message} onRetry={() => void detail.refetch()} />;

  const { customer, brand, conversation } = detail.data;
  const closed = conversation.status === 'closed';

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b bg-card px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold" data-testid="chat-customer">
            {customer.name}
          </h2>
          <div className="mt-0.5 flex items-center gap-1.5">
            <Badge tone="violet" data-testid="chat-brand">
              {brand.name}
            </Badge>
            <Badge tone={closed ? 'neutral' : 'green'}>{conversation.status}</Badge>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div role="group" aria-label="Sender mode" className="inline-flex rounded-md border bg-muted p-0.5 text-xs">
            {(
              [
                ['agent', 'Agent', Headset],
                ['customer', 'Customer simulator', UserRound],
              ] as const
            ).map(([m, label, Icon]) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={cn('inline-flex items-center gap-1 rounded px-2.5 py-1 font-medium', mode === m ? 'bg-card shadow-sm' : 'text-muted-foreground')}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden /> {label}
              </button>
            ))}
          </div>
          <Button size="sm" variant="outline" loading={status.isPending} onClick={() => status.mutate(closed ? 'open' : 'closed')}>
            {closed ? 'Reopen' : 'Close'}
          </Button>
        </div>
      </header>

      <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto bg-slate-50 px-4 py-4" data-testid="message-list" aria-live="polite">
        {messages && messages.length === 0 ? (
          <EmptyState title="No messages yet">Send the first message below. Use the customer simulator to test replies end to end.</EmptyState>
        ) : (
          messages?.map((m) => <MessageBubble key={m.id} message={m} customerName={customer.name} agentName={m.sender_id === me?.id ? 'You' : undefined} />)
        )}
        <div ref={bottom} />
      </div>

      <div className="border-t bg-card p-3">
        {mode === 'customer' && (
          <p className="mb-2 flex items-center gap-1.5 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
            <Lock className="h-3 w-3" aria-hidden /> Customer simulator: messages are sent as <strong>{customer.name}</strong>. This is a test tool, not customer login.
          </p>
        )}
        {attachments.length > 0 && (
          <ul className="mb-2 flex flex-wrap gap-2" aria-label="Attachments to send">
            {attachments.map((a) => (
              <li key={a.id} className="relative">
                {a.url && <img src={a.url} alt="Attachment preview" className="h-16 w-16 rounded-md object-cover ring-1 ring-slate-200" />}
                <button
                  type="button"
                  aria-label="Remove attachment"
                  onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
                  className="absolute -right-1.5 -top-1.5 rounded-full bg-slate-800 p-0.5 text-white"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInput}
            type="file"
            accept={ALLOWED_IMAGE_MIME.join(',')}
            className="sr-only"
            data-testid="file-input"
            onChange={(e) => {
              pickFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <Button variant="outline" size="icon" aria-label="Attach image" loading={upload.isPending} onClick={() => fileInput.current?.click()}>
            {!upload.isPending && <ImagePlus className="h-4 w-4" />}
          </Button>
          <Textarea
            aria-label={mode === 'agent' ? 'Message to customer' : 'Message as customer'}
            placeholder={mode === 'agent' ? 'Write a message to the customer…' : `Type as ${customer.name}…`}
            className="max-h-40 min-h-[40px] flex-1 resize-none"
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            maxLength={4000}
          />
          <Button onClick={submit} disabled={!canSend} loading={send.isPending} data-testid="send-message">
            {!send.isPending && <Send className="h-4 w-4" aria-hidden />}
            {mode === 'agent' ? 'Send' : 'Send as customer'}
          </Button>
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">Enter to send · Shift+Enter for a new line · PNG, JPEG, WebP or GIF up to 5 MB</p>
      </div>
    </div>
  );
}
