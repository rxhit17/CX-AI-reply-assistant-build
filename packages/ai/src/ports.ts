import type { Eligibility, GuardrailResult, Intent } from '@cx/shared';
import type { KbSearchPort } from './retrieval.js';
import type { OrderFacts, PolicyRef } from './policy/rules.js';
import type { ImageEvidence } from './llm/types.js';
import type { PersistedCaseState } from './case-state.js';

export interface HistoryMessage {
  id: string;
  sender_type: 'customer' | 'agent' | 'system';
  body: string;
  created_at: string;
  attachments: { id: string; mime_type: string }[];
}

export interface BrandVoice {
  tone: string;
  communication_style: string;
  greeting_preference: string | null;
  sign_off: string;
  supported_languages: string[];
}

export interface ConversationContext {
  conversation: {
    id: string;
    brand_id: string;
    customer_id: string;
    order_id: string | null;
    status: 'open' | 'closed';
  };
  brand: { id: string; name: string; voice: BrandVoice };
  customer: { id: string; name: string; preferred_language: string | null };
  /** Oldest first. */
  messages: HistoryMessage[];
}

export interface SavedSource {
  kb_id: string;
  kb_version: number;
  title: string;
  rank: number;
  vector_score: number | null;
  text_score: number | null;
  fused_score: number;
}

export interface TraceEntry {
  node: string;
  ms: number;
  note?: string;
}

export interface GenerationRecord {
  brand_id: string;
  conversation_id: string;
  trigger_message_id: string | null;
  requested_by: string | null;
  parent_generation_id: string | null;
  status: 'draft' | 'failed';
  intent: Intent | null;
  language: string | null;
  search_query: string | null;
  body: string;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  error_code: string | null;
  error_message: string | null;
  escalate: boolean;
  guardrails: GuardrailResult[];
  eligibility: Eligibility[];
  order_facts: OrderFacts | null;
  image_evidence: ImageEvidence | null;
  graph_trace: TraceEntry[];
  /** Conversation-aware case state after this run (customer statements + derived workflow decision). */
  case_state: PersistedCaseState | null;
  sources: SavedSource[];
}

/**
 * Everything the workflow needs from the outside world. Implementations MUST scope each call to the
 * given brand (and conversation) and must not accept brand/user identifiers from model output.
 */
export interface GenerationPorts {
  loadConversation(conversationId: string): Promise<ConversationContext>;
  loadOrder(orderId: string, brandId: string, customerId: string): Promise<OrderFacts | null>;
  /** Active, non-archived KB entries of the brand that carry structured conditions. */
  loadPolicies(brandId: string): Promise<(PolicyRef & { content: string })[]>;
  /** Case state saved by the most recent earlier run for this conversation (a cache; messages stay authoritative). */
  loadPreviousCaseState(
    conversationId: string,
    /** The customer message being answered: state computed FOR this message is excluded so a regeneration never builds on its own earlier (possibly wrong) extraction. */
    beforeMessageId: string,
  ): Promise<PersistedCaseState | null>;
  search: KbSearchPort;
  listOtherBrandNames(brandId: string): Promise<string[]>;
  loadImages(p: {
    attachmentIds: string[];
    brandId: string;
    conversationId: string;
  }): Promise<{ id: string; dataUrl: string }[]>;
  /**
   * Order verification (optional: the gate is disabled when these are absent). Lists ONLY the given customer's
   * orders in the given brand, so a number can never be matched against someone else's order.
   */
  listCustomerOrders?(
    brandId: string,
    customerId: string,
  ): Promise<{ id: string; order_number: string }[]>;
  /** Attaches a verified order to the conversation. Must not overwrite an order that is already linked. */
  linkOrderToConversation?(p: {
    conversationId: string;
    brandId: string;
    customerId: string;
    orderId: string;
  }): Promise<void>;
  saveGeneration(record: GenerationRecord): Promise<string>;
  createEscalation(p: {
    brandId: string;
    conversationId: string;
    generationId: string;
    reason: string;
    createdBy: string | null;
  }): Promise<void>;
}
