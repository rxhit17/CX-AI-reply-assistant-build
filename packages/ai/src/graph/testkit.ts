/** In-memory ports and fixtures for graph tests. Test-only; not exported from the package index. */
import { vi } from 'vitest';
import type { RetrievedKb } from '@cx/shared';
import type { AiConfig } from '../config.js';
import type { PolicyRef, OrderFacts } from '../policy/rules.js';
import type {
  ConversationContext,
  GenerationPorts,
  GenerationRecord,
  HistoryMessage,
} from '../ports.js';
import type { GraphDeps, GenerationInput } from './build.js';
import { createMockLlm } from '../llm/mock.js';

export const NOW = new Date('2026-10-23T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

export const BLOOM_ID = '00000000-0000-4000-8000-0000000000b1';
export const NORDIC_ID = '00000000-0000-4000-8000-0000000000c2';
export const CONV_ID = '00000000-0000-4000-8000-0000000000d3';

export const config: AiConfig = {
  llmMode: 'mock',
  chatModel: 'mock',
  visionModel: 'mock',
  embeddingModel: 'mock',
  embeddingDimensions: 16,
  timeoutMs: 1000,
  retrieval: { minVectorSimilarity: 0.26, relativeMargin: 0.04, minFusedScore: 0.0162, topK: 5 },
};

export const bloomVoice = {
  tone: 'Friendly and casual',
  communication_style: 'Short sentences',
  greeting_preference: 'Hi {first_name}!',
  sign_off: 'Happy growing, The Bloom Team',
  supported_languages: ['en', 'es', 'hi', 'fr'],
};

export const nordicVoice = {
  tone: 'Professional, premium and formal',
  communication_style: 'Complete sentences, no slang, no emoji',
  greeting_preference: 'Dear {first_name},',
  sign_off: 'With kind regards, Nordic Living Customer Care',
  supported_languages: ['en', 'fr', 'es'],
};

export const msg = (
  id: string,
  sender: 'customer' | 'agent',
  body: string,
  images = 0,
  createdAt: string = NOW.toISOString(),
): HistoryMessage => ({
  id,
  sender_type: sender,
  body,
  created_at: createdAt,
  attachments: Array.from({ length: images }, (_, i) => ({
    id: `${id}-img${i}`,
    mime_type: 'image/png',
  })),
});

export const order = (over: Partial<OrderFacts> = {}): OrderFacts => ({
  order_number: 'BB-10041',
  status: 'delivered',
  total: 64.5,
  currency: 'USD',
  placed_at: daysAgo(5),
  shipped_at: daysAgo(4),
  delivered_at: daysAgo(1),
  estimated_delivery_at: null,
  items: [{ name: 'Glass Propagation Bottle', quantity: 1, unit_price: 28.5 }],
  ...over,
});

const policy = (
  category: string,
  conditions: PolicyRef['conditions'],
  content: string,
  id: string,
): PolicyRef & { content: string } => ({
  kbId: id,
  version: 1,
  title: `Bloom ${category}`,
  category,
  conditions,
  content,
});

export const bloomPolicies = [
  policy(
    'return_policy',
    { window_days: 7, window_anchor: 'delivery' },
    'Returns within 7 days of delivery.',
    '10000000-0000-4000-8000-000000000001',
  ),
  policy(
    'refund_policy',
    { window_days: 7, window_anchor: 'delivery', discretionary_review: true },
    'Refunds within 7 days of delivery.',
    '10000000-0000-4000-8000-000000000002',
  ),
  policy(
    'damaged_products',
    { report_within_days: 2, requires_photo: true, discretionary_review: true },
    'Report damage within 48 hours with a photo.',
    '10000000-0000-4000-8000-000000000003',
  ),
  policy(
    'shipping_policy',
    { free_shipping_threshold: 50, delivery_business_days: [3, 5] },
    'Free shipping over $50. Delivery takes 3-5 business days.',
    '10000000-0000-4000-8000-000000000004',
  ),
  policy(
    'cancellation_policy',
    { cancellable_until: 'processing' },
    'Cancel only while processing.',
    '10000000-0000-4000-8000-000000000005',
  ),
];

const nordicPolicy = (
  category: string,
  conditions: PolicyRef['conditions'],
  content: string,
  id: string,
) => ({
  ...policy(category, conditions, content, id),
  title: `Nordic Living ${category}`,
});

/** Condensed copies of the seeded Nordic Living policy text (same windows and conditions). */
export const nordicPolicies = [
  nordicPolicy(
    'return_policy',
    { window_days: 30, window_anchor: 'delivery' },
    'Items may be returned within 30 days of delivery provided they are unused and in their original packaging. Return shipping is paid by the customer unless the item arrived defective or damaged, in which case we arrange a prepaid collection.',
    '20000000-0000-4000-8000-000000000001',
  ),
  nordicPolicy(
    'refund_policy',
    { window_days: 30, window_anchor: 'delivery', discretionary_review: true },
    'Refunds are available for returns initiated within 30 days of delivery. After the returned item has been received and inspected, the refund is processed within 10 business days to the original payment method.',
    '20000000-0000-4000-8000-000000000002',
  ),
  nordicPolicy(
    'shipping_policy',
    { free_shipping_threshold: 100, delivery_business_days: [5, 8] },
    'Complimentary shipping is provided on orders over $100. Standard delivery takes 5-8 business days after dispatch.',
    '20000000-0000-4000-8000-000000000004',
  ),
];

/** Nordic Living, Emma Larsen, Oak Side Table delivered 12 days ago. */
export const emmaOrder = (over: Partial<OrderFacts> = {}): OrderFacts =>
  order({
    order_number: 'NL-20077',
    total: 180,
    placed_at: daysAgo(17),
    shipped_at: daysAgo(15),
    delivered_at: daysAgo(12),
    items: [{ name: 'Oak Side Table', quantity: 1, unit_price: 180 }],
    ...over,
  });

export interface Harness {
  deps: GraphDeps;
  input: GenerationInput;
  saved: GenerationRecord[];
  escalations: { generationId: string; reason: string }[];
  search: ReturnType<typeof vi.fn>;
  ctx: ConversationContext;
}

export function makeHarness(opts: {
  messages: HistoryMessage[];
  order?: OrderFacts | null;
  policies?: typeof bloomPolicies;
  searchResults?: RetrievedKb[];
  otherBrands?: string[];
  llm?: GraphDeps['llm'];
  voice?: typeof bloomVoice;
  customerLanguage?: string;
  brand?: 'bloom' | 'nordic';
}): Harness {
  const nordic = opts.brand === 'nordic';
  const brandId = nordic ? NORDIC_ID : BLOOM_ID;
  const saved: GenerationRecord[] = [];
  const escalations: Harness['escalations'] = [];
  const ctx: ConversationContext = {
    conversation: {
      id: CONV_ID,
      brand_id: brandId,
      customer_id: 'cust-1',
      order_id: opts.order === null ? null : 'order-1',
      status: 'open',
    },
    brand: {
      id: brandId,
      name: nordic ? 'Nordic Living' : 'Bloom Botanics',
      voice: opts.voice ?? (nordic ? nordicVoice : bloomVoice),
    },
    customer: {
      id: 'cust-1',
      name: nordic ? 'Emma Larsen' : 'Maya Patel',
      preferred_language: opts.customerLanguage ?? 'en',
    },
    messages: opts.messages,
  };
  const search = vi.fn().mockResolvedValue(opts.searchResults ?? []);
  const ports: GenerationPorts = {
    loadConversation: async () => ctx,
    loadOrder: async () => (opts.order === undefined ? order() : opts.order),
    loadPolicies: async () => opts.policies ?? (nordic ? nordicPolicies : bloomPolicies),
    // Mirrors the Postgres port: the case state saved by the most recent earlier run.
    // Mirrors the Postgres port: the state computed for the most recent customer message BEFORE the one being
    // answered (ordered by message position, not by when the generation was written).
    loadPreviousCaseState: async (_conversationId, beforeMessageId) => {
      const position = (id: string | null) => ctx.messages.findIndex((m) => m.id === id);
      const candidates = saved
        .filter((r) => r.case_state && r.trigger_message_id !== beforeMessageId)
        .map((r, order) => ({ r, pos: position(r.trigger_message_id), order }))
        .filter((c) => c.pos < position(beforeMessageId));
      candidates.sort((a, b) => b.pos - a.pos || b.order - a.order);
      return candidates[0]?.r.case_state ?? null;
    },
    search: { search },
    listOtherBrandNames: async () =>
      opts.otherBrands ?? (nordic ? ['Bloom Botanics'] : ['Nordic Living']),
    loadImages: async ({ attachmentIds }) =>
      attachmentIds.map((id) => ({ id, dataUrl: 'data:image/png;base64,AAAA' })),
    saveGeneration: async (record) => {
      saved.push(record);
      return `gen-${saved.length}`;
    },
    createEscalation: async ({ generationId, reason }) => {
      escalations.push({ generationId, reason });
    },
  };
  return {
    deps: { ports, llm: opts.llm ?? createMockLlm(), config, embeddings: null, now: () => NOW },
    input: {
      conversationId: CONV_ID,
      brandId,
      customerId: 'cust-1',
      orderId: opts.order === null ? null : 'order-1',
      requestedBy: 'agent-1',
    },
    saved,
    escalations,
    search,
    ctx,
  };
}

export const kb = (over: Partial<RetrievedKb> & { id: string }): RetrievedKb => ({
  title: 'Bloom entry',
  category: 'faq',
  version: 1,
  content: 'content',
  conditions: null,
  vector_score: 0.6,
  text_score: 0.2,
  fused_score: 0.03,
  ...over,
});
