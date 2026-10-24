import { z } from 'zod';
import {
  ALLOWED_IMAGE_MIME,
  conversationStatusSchema,
  draftStatusSchema,
  embeddingStatusSchema,
  intentSchema,
  kbCategorySchema,
  senderTypeSchema,
  SUPPORTED_LANGUAGES,
} from './enums.js';

const uuid = z.string().uuid();
const ts = z.string(); // ISO-8601 timestamptz

// ---------- Structured policy conditions (optional, consumed by deterministic rules) ----------
export const policyConditionsSchema = z
  .object({
    window_days: z.number().int().positive().optional(),
    window_anchor: z.enum(['delivery', 'order']).optional(),
    free_shipping_threshold: z.number().nonnegative().optional(),
    requires_photo: z.boolean().optional(),
    report_within_days: z.number().int().positive().optional(),
    cancellable_until: z.enum(['processing', 'shipped']).optional(),
    /** Typical delivery time after dispatch, in business days: [min, max]. */
    delivery_business_days: z
      .tuple([z.number().int().positive(), z.number().int().positive()])
      .optional(),
    /** After the standard window the brand may still review individual cases (never a guaranteed outcome). */
    discretionary_review: z.boolean().optional(),
  })
  .strict();
export type PolicyConditions = z.infer<typeof policyConditionsSchema>;

// ---------- Brands ----------
export const brandSettingsSchema = z.object({
  brand_id: uuid,
  tone: z.string().min(1).max(500),
  communication_style: z.string().min(1).max(500),
  greeting_preference: z.string().max(200).nullable(),
  sign_off: z.string().max(200),
  supported_languages: z.array(z.enum(SUPPORTED_LANGUAGES)).min(1),
});
export type BrandSettings = z.infer<typeof brandSettingsSchema>;
export const brandSettingsUpdateSchema = brandSettingsSchema
  .omit({ brand_id: true })
  .partial()
  .strict();

export const brandSchema = z.object({
  id: uuid,
  name: z.string(),
  slug: z.string(),
  settings: brandSettingsSchema.nullable().optional(),
});
export type Brand = z.infer<typeof brandSchema>;

// ---------- Messages ----------
export const attachmentSchema = z.object({
  id: uuid,
  message_id: uuid.nullable(),
  storage_path: z.string(),
  mime_type: z.string(),
  size_bytes: z.number().int(),
  url: z.string().nullable().optional(), // signed URL
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const messageSchema = z.object({
  id: uuid,
  conversation_id: uuid,
  sender_type: senderTypeSchema,
  sender_id: uuid.nullable(),
  body: z.string(),
  client_message_id: z.string().nullable(),
  ai_generation_id: uuid.nullable(),
  delivered_at: ts.nullable(),
  read_at: ts.nullable(),
  created_at: ts,
  /** Set when the sender withdrew the message; its body and attachments are then removed. */
  unsent_at: ts.nullable().optional(),
  attachments: z.array(attachmentSchema).optional(),
});
export type Message = z.infer<typeof messageSchema>;

export const sendMessageRequestSchema = z
  .object({
    body: z.string().trim().max(4000).default(''),
    sender_type: z.enum(['customer', 'agent']),
    client_message_id: z.string().min(8).max(100),
    attachment_ids: z.array(uuid).max(4).default([]),
  })
  .refine((v) => v.body.length > 0 || v.attachment_ids.length > 0, {
    message: 'A message needs text or at least one attachment',
  });
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

export const imageMimeSchema = z.enum(ALLOWED_IMAGE_MIME);

// ---------- Conversations / orders ----------
export const customerSchema = z.object({
  id: uuid,
  brand_id: uuid,
  name: z.string(),
  email: z.string(),
  preferred_language: z.string().nullable().optional(),
});
export type Customer = z.infer<typeof customerSchema>;

export const orderItemSchema = z.object({
  id: uuid,
  name: z.string(),
  quantity: z.number().int(),
  unit_price: z.number(),
});
export const orderStatusSchema = z.enum([
  'processing',
  'shipped',
  'in_transit',
  'delivered',
  'cancelled',
]);
export const orderSchema = z.object({
  id: uuid,
  brand_id: uuid,
  customer_id: uuid,
  order_number: z.string(),
  status: orderStatusSchema,
  total: z.number(),
  currency: z.string(),
  placed_at: ts,
  shipped_at: ts.nullable(),
  delivered_at: ts.nullable(),
  estimated_delivery_at: ts.nullable(),
  items: z.array(orderItemSchema).optional(),
});
export type Order = z.infer<typeof orderSchema>;

export const conversationSummarySchema = z.object({
  id: uuid,
  brand_id: uuid,
  brand_name: z.string(),
  customer_id: uuid,
  customer_name: z.string(),
  order_id: uuid.nullable(),
  status: conversationStatusSchema,
  last_message_body: z.string().nullable(),
  last_message_at: ts.nullable(),
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const createConversationRequestSchema = z.object({
  customer_id: uuid,
  order_id: uuid.nullable().optional(),
});

// ---------- Knowledge base ----------
export const kbEntryInputSchema = z.object({
  brand_id: uuid,
  title: z.string().trim().min(3).max(200),
  category: kbCategorySchema,
  content: z.string().trim().min(10).max(8000),
  conditions: policyConditionsSchema.nullable().optional(),
  is_active: z.boolean().default(true),
});
export type KbEntryInput = z.infer<typeof kbEntryInputSchema>;
export const kbEntryUpdateSchema = kbEntryInputSchema.omit({ brand_id: true }).partial().strict();

export const kbEntrySchema = z.object({
  id: uuid,
  brand_id: uuid,
  title: z.string(),
  category: kbCategorySchema,
  content: z.string(),
  conditions: policyConditionsSchema.nullable(),
  content_hash: z.string(),
  version: z.number().int(),
  is_active: z.boolean(),
  archived_at: ts.nullable(),
  embedding_status: embeddingStatusSchema,
  embedding_error: z.string().nullable(),
  created_at: ts,
  updated_at: ts,
});
export type KbEntry = z.infer<typeof kbEntrySchema>;

export const retrievedKbSchema = z.object({
  id: uuid,
  title: z.string(),
  category: kbCategorySchema,
  version: z.number().int(),
  content: z.string(),
  conditions: policyConditionsSchema.nullable().optional(),
  vector_score: z.number().nullable(),
  text_score: z.number().nullable(),
  fused_score: z.number(),
});
export type RetrievedKb = z.infer<typeof retrievedKbSchema>;

// ---------- AI ----------
export const generateRequestSchema = z.object({
  conversation_id: uuid,
  options: z
    .object({
      regenerate_of: uuid.optional(),
      extra_instruction: z.string().max(500).optional(),
    })
    .optional(),
});
export type GenerateRequest = z.infer<typeof generateRequestSchema>;

export const draftEditSchema = z.object({ body: z.string().trim().min(1).max(4000) });
export const sendDraftRequestSchema = z.object({ idempotency_key: z.string().min(8).max(100) });

export const guardrailResultSchema = z.object({
  check: z.string(),
  passed: z.boolean(),
  severity: z.enum(['info', 'warning', 'blocking']),
  detail: z.string().optional(),
});
export type GuardrailResult = z.infer<typeof guardrailResultSchema>;

export const eligibilitySchema = z.object({
  kind: z.enum(['return', 'refund', 'shipping', 'cancellation', 'damage']),
  outcome: z.enum(['eligible', 'ineligible', 'needs_review', 'insufficient_data']),
  reason: z.string(),
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type Eligibility = z.infer<typeof eligibilitySchema>;

export const draftSchema = z.object({
  id: uuid,
  conversation_id: uuid,
  brand_id: uuid,
  status: draftStatusSchema,
  intent: intentSchema.nullable(),
  original_body: z.string(),
  current_body: z.string(),
  language: z.string().nullable(),
  sources: z.array(retrievedKbSchema.pick({ id: true, title: true, version: true })),
  guardrails: z.array(guardrailResultSchema),
  eligibility: z.array(eligibilitySchema),
  escalate: z.boolean(),
  stale_policy: z.boolean().optional(),
  created_at: ts,
});
export type Draft = z.infer<typeof draftSchema>;

// ---------- Errors ----------
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
