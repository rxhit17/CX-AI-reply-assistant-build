import type { Eligibility, GuardrailResult, KbEntry } from '@cx/shared';

export interface Me {
  id: string;
  email: string;
  role: 'admin' | 'agent';
  full_name: string;
  brand_ids: string[];
}

export interface BrandSettingsRow {
  brand_id: string;
  tone: string;
  communication_style: string;
  greeting_preference: string | null;
  sign_off: string;
  supported_languages: string[];
}
export interface BrandRow {
  id: string;
  name: string;
  slug: string;
  settings: BrandSettingsRow | BrandSettingsRow[] | null;
}

export interface ConversationListItem {
  id: string;
  brand_id: string;
  brand_name: string;
  customer_id: string;
  customer_name: string;
  order_id: string | null;
  status: 'open' | 'closed';
  last_message_body: string | null;
  last_message_sender: 'customer' | 'agent' | 'system' | null;
  last_activity_at: string;
  unread_count: number;
}

export interface AttachmentRow {
  id: string;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  url: string | null;
}
export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_type: 'customer' | 'agent' | 'system';
  sender_id: string | null;
  body: string;
  client_message_id: string | null;
  ai_generation_id: string | null;
  delivered_at: string | null;
  read_at: string | null;
  created_at: string;
  unsent_at?: string | null;
  attachments?: AttachmentRow[];
}

export interface OrderRow {
  id: string;
  order_number: string;
  status: 'processing' | 'shipped' | 'in_transit' | 'delivered' | 'cancelled';
  total: number;
  currency: string;
  placed_at: string;
  shipped_at: string | null;
  delivered_at: string | null;
  estimated_delivery_at: string | null;
  items: { id: string; name: string; quantity: number; unit_price: number }[];
}

export interface ConversationDetail {
  conversation: {
    id: string;
    brand_id: string;
    customer_id: string;
    order_id: string | null;
    status: 'open' | 'closed';
  };
  customer: { id: string; name: string; email: string; preferred_language: string | null };
  brand: { id: string; name: string; slug: string };
  messages: MessageRow[];
}

export interface DraftRow {
  id: string;
  brand_id: string;
  conversation_id: string;
  status:
    'draft' | 'edited' | 'approved' | 'sent' | 'discarded' | 'superseded' | 'withheld' | 'failed';
  intent: string | null;
  language: string | null;
  original_body: string;
  current_body: string;
  escalate: boolean;
  guardrails: GuardrailResult[];
  eligibility: Eligibility[];
  /** What the assistant understood about the case (customer statements are unverified). */
  case_state: {
    issue_type: string;
    confirmed_facts: string[];
    denied_facts: string[];
    desired_resolution: string;
    resolution_confirmed: boolean;
    corrections: string[];
    derived?: {
      workflow_stage: string;
      next_action: string;
      missing_information: string[];
      eligibility_status: string;
    };
  } | null;
  image_evidence: {
    usable: boolean;
    subject: string;
    visible_damage: string;
    description: string;
    confidence: string;
  } | null;
  model: string | null;
  latency_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  error_code: string | null;
  error_message: string | null;
  stale_policy?: boolean;
  created_at: string;
  approved_at: string | null;
  sent_at: string | null;
}
export interface DraftSource {
  kb_id: string;
  kb_version: number;
  title: string;
  rank: number;
  vector_score: number | null;
  text_score: number | null;
  fused_score: number;
}
export interface DraftResponse {
  draft: DraftRow | null;
  sources: DraftSource[];
  stale_sources: { kb_id: string }[];
}

export interface CustomerRow {
  id: string;
  brand_id: string;
  name: string;
  email: string;
  preferred_language: string | null;
  orders: { id: string; order_number: string; status: string }[];
}

export type KbRow = KbEntry & { embedded_hash: string | null; embedding_model: string | null };

export interface RetrievalPreview {
  entries: {
    id: string;
    title: string;
    category: string;
    version: number;
    vector_score: number | null;
    text_score: number | null;
    fused_score: number;
  }[];
  relevant: { id: string }[];
  sufficient: boolean;
  mode: 'hybrid' | 'keyword';
  reason: string;
  embeddingError?: string;
  thresholds: {
    minVectorSimilarity: number;
    relativeMargin: number;
    minFusedScore: number;
    topK: number;
  };
}

export interface LogRow {
  id: string;
  requested_by: string | null;
  brand_id: string;
  conversation_id: string;
  status: DraftRow['status'];
  intent: string | null;
  language: string | null;
  original_body: string;
  current_body: string;
  escalate: boolean;
  guardrails: GuardrailResult[];
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: number | null;
  error_code: string | null;
  error_message: string | null;
  approved_at: string | null;
  sent_at: string | null;
  created_at: string;
  requester: { full_name: string } | null;
  trigger: { body: string } | null;
  conversations: { brands: { name: string } | null; customers: { name: string } | null } | null;
  ai_generation_sources: { title: string; kb_version: number }[];
}
