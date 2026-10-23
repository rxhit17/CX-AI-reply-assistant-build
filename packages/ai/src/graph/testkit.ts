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

export const msg = (
  id: string,
  sender: 'customer' | 'agent',
  body: string,
  images = 0,
): HistoryMessage => ({
  id,
  sender_type: sender,
  body,
  created_at: NOW.toISOString(),
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
}): Harness {
  const saved: GenerationRecord[] = [];
  const escalations: Harness['escalations'] = [];
  const ctx: ConversationContext = {
    conversation: {
      id: CONV_ID,
      brand_id: BLOOM_ID,
      customer_id: 'cust-1',
      order_id: opts.order === null ? null : 'order-1',
      status: 'open',
    },
    brand: { id: BLOOM_ID, name: 'Bloom Botanics', voice: opts.voice ?? bloomVoice },
    customer: {
      id: 'cust-1',
      name: 'Maya Patel',
      preferred_language: opts.customerLanguage ?? 'en',
    },
    messages: opts.messages,
  };
  const search = vi.fn().mockResolvedValue(opts.searchResults ?? []);
  const ports: GenerationPorts = {
    loadConversation: async () => ctx,
    loadOrder: async () => (opts.order === undefined ? order() : opts.order),
    loadPolicies: async () => opts.policies ?? bloomPolicies,
    search: { search },
    listOtherBrandNames: async () => opts.otherBrands ?? ['Nordic Living'],
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
      brandId: BLOOM_ID,
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
