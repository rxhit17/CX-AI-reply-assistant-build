import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  BrandRow,
  BrandSettingsRow,
  ConversationDetail,
  ConversationListItem,
  CustomerRow,
  DraftResponse,
  KbRow,
  LogRow,
  OrderRow,
} from '@/lib/types';

export const settingsOf = (b: BrandRow): BrandSettingsRow | null =>
  Array.isArray(b.settings) ? (b.settings[0] ?? null) : b.settings;

export function useBrands() {
  return useQuery({
    queryKey: ['brands'],
    queryFn: async () => (await api.get<{ brands: BrandRow[] }>('/api/brands')).brands,
    staleTime: 60_000,
  });
}

export function useConversations(filters: { brand_id?: string; status?: string; q?: string }) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  return useQuery({
    queryKey: ['conversations', filters],
    queryFn: async () =>
      (await api.get<{ conversations: ConversationListItem[] }>(`/api/conversations?${params}`)).conversations,
    refetchInterval: 60_000, // safety net if a realtime event is missed
  });
}

export function useConversation(id: string | undefined) {
  return useQuery({
    queryKey: ['conversation', id],
    enabled: Boolean(id),
    queryFn: () => api.get<ConversationDetail>(`/api/conversations/${id}`),
  });
}

export function useOrder(conversationId: string | undefined) {
  return useQuery({
    queryKey: ['order', conversationId],
    enabled: Boolean(conversationId),
    queryFn: async () => (await api.get<{ order: OrderRow | null }>(`/api/conversations/${conversationId}/order`)).order,
  });
}

export function useDraft(conversationId: string | undefined) {
  return useQuery({
    queryKey: ['draft', conversationId],
    enabled: Boolean(conversationId),
    queryFn: () => api.get<DraftResponse>(`/api/conversations/${conversationId}/draft`),
  });
}

export function useCustomers(brandId?: string) {
  return useQuery({
    queryKey: ['customers', brandId],
    queryFn: async () =>
      (await api.get<{ customers: CustomerRow[] }>(`/api/customers${brandId ? `?brand_id=${brandId}` : ''}`)).customers,
  });
}

export function useKb(filters: { brand_id?: string; category?: string; q?: string; active?: string; include_archived?: string }) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  return useQuery({
    queryKey: ['kb', filters],
    queryFn: async () => (await api.get<{ entries: KbRow[] }>(`/api/knowledge-base?${params}`)).entries,
  });
}

export function useLogs(filters: { brand_id?: string; status?: string; agent_id?: string; from?: string; to?: string }) {
  const params = new URLSearchParams({ limit: '100' });
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  return useQuery({
    queryKey: ['logs', filters],
    queryFn: async () => (await api.get<{ logs: LogRow[] }>(`/api/ai/logs?${params}`)).logs,
  });
}
