import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { supabase } from '@/lib/supabase';

export type ConnectionStatus = 'connecting' | 'live' | 'offline';
const Ctx = createContext<ConnectionStatus>('connecting');
export const useConnectionStatus = () => useContext(Ctx);

/**
 * One Supabase Realtime channel for the signed-in user. RLS is applied to every event, so a user only
 * receives rows from brands they can access. Events only invalidate queries; the API stays the source of truth.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const token = session?.access_token;

  useEffect(() => {
    if (!token) return;
    supabase.realtime.setAuth(token);
    const channel = supabase
      .channel('workspace')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, (payload) => {
        const row = (payload.new ?? payload.old) as { conversation_id?: string };
        void queryClient.invalidateQueries({ queryKey: ['conversations'] });
        if (row.conversation_id) {
          void queryClient.invalidateQueries({ queryKey: ['conversation', row.conversation_id] });
          // a customer message may have named an order, which links it to the conversation
          void queryClient.invalidateQueries({ queryKey: ['order', row.conversation_id] });
        }
      })
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'ai_generations' },
        (payload) => {
          const row = (payload.new ?? payload.old) as { conversation_id?: string };
          if (row.conversation_id)
            void queryClient.invalidateQueries({ queryKey: ['draft', row.conversation_id] });
          void queryClient.invalidateQueries({ queryKey: ['logs'] });
        },
      )
      .subscribe((s) => {
        if (s === 'SUBSCRIBED') setStatus('live');
        else if (s === 'CLOSED' || s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') setStatus('offline');
        else setStatus('connecting');
      });
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [token, queryClient]);

  return <Ctx.Provider value={status}>{children}</Ctx.Provider>;
}
