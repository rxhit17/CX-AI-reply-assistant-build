import { ArrowLeft, MessageSquareText, PanelRight } from 'lucide-react';
import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { EmptyState } from '@/components/ui/primitives';
import { ChatPanel } from '@/conversations/ChatPanel';
import { ConversationList } from '@/conversations/ConversationList';
import { SidePanel } from '@/conversations/SidePanel';
import { cn } from '@/lib/utils';

/** Three-pane agent workspace. On small screens only one pane is visible at a time. */
export function Conversations() {
  const { id } = useParams();
  const [details, setDetails] = useState(false);

  return (
    <div className="flex h-full" data-testid="conversations-page">
      <div className={cn('w-full shrink-0 border-r md:block md:w-80', id ? 'hidden' : 'block')}>
        <ConversationList activeId={id} />
      </div>

      {id ? (
        <>
          <div className={cn('min-w-0 flex-1 flex-col', details ? 'hidden lg:flex' : 'flex')}>
            <div className="flex items-center gap-2 border-b bg-card px-3 py-1.5 md:hidden">
              <Link
                to="/conversations"
                className="inline-flex items-center gap-1 text-xs font-medium text-primary"
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Inbox
              </Link>
              <button
                className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-primary lg:hidden"
                onClick={() => setDetails(true)}
              >
                <PanelRight className="h-3.5 w-3.5" aria-hidden /> Details & AI
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <ChatPanel key={id} conversationId={id} />
            </div>
          </div>
          <aside
            aria-label="Customer details and AI assistant"
            className={cn(
              'w-full shrink-0 border-l bg-card lg:block lg:w-[22rem] xl:w-[26rem]',
              details ? 'block' : 'hidden',
            )}
          >
            <button
              className="flex w-full items-center gap-1 border-b px-3 py-1.5 text-xs font-medium text-primary lg:hidden"
              onClick={() => setDetails(false)}
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to chat
            </button>
            <SidePanel conversationId={id} />
          </aside>
        </>
      ) : (
        <div className="hidden flex-1 items-center justify-center md:flex">
          <EmptyState
            icon={<MessageSquareText className="h-8 w-8" />}
            title="Select a conversation"
          >
            Choose a conversation on the left to read the history, check the order and draft a reply
            with the AI assistant.
          </EmptyState>
        </div>
      )}
    </div>
  );
}
