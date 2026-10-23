/**
 * Deterministic stand-in for the model, for unit/integration/e2e tests and CI ONLY (LLM_MODE=mock).
 * It is never used on a production path: createLlm() only returns it when explicitly configured.
 * Behaviour is intentionally simple and rule-based; real-model quality is measured separately by the
 * evaluation suite.
 */
import type { Intent } from '@cx/shared';
import {
  type ComposeInput,
  type ComposedReply,
  type ImageEvidence,
  type LlmPort,
  type LlmResult,
  type Understanding,
  type UnderstandInput,
} from './types.js';

const ZERO = { input: 0, output: 0 };
const wrap = <T>(value: T): LlmResult<T> => ({ value, usage: ZERO, model: 'mock' });

export function detectLanguage(text: string): string {
  if (/[ऀ-ॿ]/.test(text)) return 'hi';
  if (/[¿¡ñ]|\b(hola|gracias|pedido|devolver|cuándo|cuando llegar)/i.test(text)) return 'es';
  if (/\b(bonjour|merci|commande|annuler|colis|je voudrais)\b/i.test(text)) return 'fr';
  return 'en';
}

const RULES: [RegExp, Intent][] = [
  [/\b(human|real person|agent|manager|speak to (a|someone))\b/i, 'human_agent_request'],
  [/\b(broken|cracked|damaged|smashed|shattered|crack|arrived with)\b|टूटा/i, 'damaged_product'],
  [/\b(refund|money back)\b|रिफंड|reembols|rembours/i, 'refund_request'],
  [/\b(exchange|swap|replace)\b/i, 'exchange'],
  [/\b(return|send (it )?back|changed my mind)\b|devolver/i, 'return_request'],
  [/\b(cancel)\b|रद्द|annuler|cancelar/i, 'cancellation'],
  [/\b(missing|not included|never arrived|didn't arrive|parcel)\b/i, 'missing_product'],
  [
    /\b(where is my (order|package)|track|when will|status)\b|cuándo llegar|llegará/i,
    'order_status',
  ],
  [/\b(shipping|delivery|free shipping)\b/i, 'shipping_question'],
  [/^\s*(hi|hello|hey|hola|bonjour|thanks|thank you|gracias|merci)[\s!.,?]*$/i, 'greeting'],
];

export function createMockLlm(): LlmPort {
  return {
    chatModel: 'mock',

    async understand(input: UnderstandInput) {
      const text = input.latest;
      const language = detectLanguage(text);
      let intent: Intent = 'unclear';
      for (const [re, i] of RULES) {
        if (re.test(text)) {
          intent = i;
          break;
        }
      }
      // follow-ups: use the earlier customer message for context
      if (intent === 'unclear' && input.latestHasImage) intent = 'damaged_product';
      if (intent === 'unclear') {
        const earlier = [...input.history].reverse().find((h) => h.role === 'customer' && h.text);
        if (/^(what about|and the|here it is|is that|can i)/i.test(text.trim()) && earlier) {
          for (const [re, i] of RULES)
            if (re.test(earlier.text)) {
              intent = /refund/i.test(text) ? 'refund_request' : i;
              break;
            }
        }
      }
      const value: Understanding = {
        intent,
        language,
        standalone_query: text,
        refers_to_attachment: input.latestHasImage || /here it is|attached|photo/i.test(text),
        asks_for_human: intent === 'human_agent_request',
        injection_suspected: /ignore (all )?(previous|prior)|system prompt|developer mode/i.test(
          text,
        ),
      };
      return wrap(value);
    },

    async analyzeImages() {
      const value: ImageEvidence = {
        usable: true,
        subject: 'product photo',
        visible_damage: 'possible',
        description: 'The photo appears to show a damaged product.',
        confidence: 'medium',
      };
      return wrap(value);
    },

    async compose(input: ComposeInput) {
      const lines: string[] = [];
      const cited: string[] = [];
      const e = input.eligibility;
      if (input.mode === 'small_talk') lines.push('Happy to help. What can I do for you today?');
      else if (input.mode === 'escalation')
        lines.push('I will pass this to a member of our team who will take over from here.');
      else if (input.mode === 'clarify')
        lines.push('Could you tell me a little more about what you need help with?');
      else if (input.mode === 'insufficient')
        lines.push(
          'Thanks for your message. I am checking this with the team and will come back to you.',
        );
      else if (input.mode === 'order') {
        const d = input.deliveryEstimate;
        if (d?.state === 'in_transit' && d.expected_on)
          lines.push(`Your order is on its way and is expected on ${d.expected_on}.`);
        else if (d?.state === 'delivered')
          lines.push(`Your order was delivered on ${d.delivered_on}.`);
        else if (d?.state === 'not_shipped') lines.push('Your order has not shipped yet.');
        else lines.push('I am checking the latest status of your order.');
      } else {
        for (const x of e) {
          if (x.outcome === 'ineligible')
            lines.push(`Unfortunately this is outside our policy: ${x.reason}.`);
          else if (x.outcome === 'eligible')
            lines.push(
              `This looks eligible under our policy, subject to verification: ${x.reason}.`,
            );
          else if (x.details.missing_evidence === 'photo' && !input.customerSentImage)
            lines.push('Could you please send a photo of the damage so we can look into it?');
          else lines.push('Our team will review this and get back to you.');
        }
        if (input.customerSentImage)
          lines.push('Thank you for the photo; our team will review it.');
        if (e.length === 0) lines.push('Our team will review your request.');
        if (input.sources[0]) cited.push(input.sources[0].label);
      }
      const value: ComposedReply = {
        reply_body: lines.join(' '),
        cited_source_ids: cited,
        reply_language: 'en',
        asks_customer_for_photo: /send a photo/.test(lines.join(' ')),
        promises_refund: false,
        promises_replacement: false,
        offers_discount: false,
        claims_action_done: false,
        suggest_human_review: input.mode === 'escalation' || input.mode === 'insufficient',
        agent_note: null,
      };
      return wrap(value);
    },

    async judge() {
      return wrap({ violations: [] });
    },
  };
}
