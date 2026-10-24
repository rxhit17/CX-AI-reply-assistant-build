import { z } from 'zod';

export const roleSchema = z.enum(['admin', 'agent']);
export type Role = z.infer<typeof roleSchema>;

export const KB_CATEGORIES = [
  'return_policy',
  'refund_policy',
  'shipping_policy',
  'cancellation_policy',
  'damaged_products',
  'missing_products',
  'delivery_problems',
  'payment_issues',
  'warranty',
  'product_information',
  'faq',
  'general_support',
] as const;
export const kbCategorySchema = z.enum(KB_CATEGORIES);
export type KbCategory = z.infer<typeof kbCategorySchema>;

export const INTENTS = [
  'return_request',
  'refund_request',
  'damaged_product',
  'shipping_question',
  'order_status',
  'cancellation',
  'missing_product',
  'exchange',
  'general_question',
  'complaint',
  'greeting',
  'human_agent_request',
  'unclear',
] as const;
export const intentSchema = z.enum(INTENTS);
export type Intent = z.infer<typeof intentSchema>;

export const senderTypeSchema = z.enum(['customer', 'agent', 'system']);
export type SenderType = z.infer<typeof senderTypeSchema>;

export const conversationStatusSchema = z.enum(['open', 'closed']);

export const draftStatusSchema = z.enum([
  'draft',
  'edited',
  'approved',
  'sent',
  'discarded',
  'superseded',
  'withheld',
]);
export type DraftStatus = z.infer<typeof draftStatusSchema>;

export const embeddingStatusSchema = z.enum(['pending', 'ready', 'failed']);

export const ALLOWED_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Languages the assistant can reply in. "hinglish" is Hindi written in the Roman (Latin) alphabet, mixed with English
 * words the way people text. Devanagari is not a supported output script, and French is not supported.
 */
export const SUPPORTED_LANGUAGES = ['en', 'hinglish'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
