/**
 * Deterministic stand-in for the model, for unit/integration/e2e tests and CI ONLY (LLM_MODE=mock).
 * It is never used on a production path: createLlm() only returns it when explicitly configured.
 * Behaviour is intentionally simple and rule-based (including a keyword-based case extractor that reads the
 * whole history, as the real model does); real-model quality is measured separately by the evaluation suite.
 */
import type { Intent } from '@cx/shared';
import type { CaseUpdate, FactKey, IssueType, QuestionTopic, Resolution } from '../case-state.js';
import {
  type ComposeInput,
  type ComposedReply,
  type HistoryItem,
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

const YES = /^\s*(yes|yeah|yep|sure|correct|it is|it's|that's right|confirmed)\b/i;

/** Keyword case extractor: reads the customer's messages in order, resolving short answers against the agent's question. */
function extractCase(history: HistoryItem[], latest: string): CaseUpdate {
  const turns: HistoryItem[] = [...history, { role: 'customer', text: latest, imageCount: 0 }];
  const confirmed = new Set<FactKey>();
  const denied = new Set<FactKey>();
  const retracted = new Set<FactKey>();
  const corrections: string[] = [];
  let issue: IssueType = 'unknown';
  let resolution: Resolution = 'unknown';
  let resolutionConfirmed = false;
  let lastAgent = '';

  for (const t of turns) {
    if (t.role === 'agent') {
      lastAgent = t.text;
      continue;
    }
    const x = t.text;
    const yes = YES.test(x);
    if (
      /\b(unused|never (been )?used|not (been )?used|haven'?t used)\b/i.test(x) ||
      (yes && /unused|been used/i.test(lastAgent))
    )
      confirmed.add('item_unused');
    if (/\bused\b/i.test(x) && /\b(has been|was|is) used\b/i.test(x)) {
      denied.add('item_unused');
      confirmed.delete('item_unused');
    }
    if (
      /\b(original|its) packaging|\bsealed\b|\bin the box\b/i.test(x) ||
      (yes && /packaging/i.test(lastAgent))
    )
      confirmed.add('original_packaging');
    if (/\bdoesn'?t look like|\bnot (what|like what) i ordered|\bdifferent from\b/i.test(x)) {
      confirmed.add('item_differs_from_listing');
      issue = 'general';
    }
    if (/\b(i )?(think )?i ordered the wrong\b|\bmy mistake\b|\bordered by mistake\b/i.test(x)) {
      confirmed.add('customer_ordered_wrong_item');
      if (confirmed.delete('item_differs_from_listing')) retracted.add('item_differs_from_listing');
      corrections.push('customer says they ordered the wrong item themselves');
      issue = 'return';
    }
    if (/\b(broken|cracked|damaged|smashed|shattered)\b/i.test(x)) {
      confirmed.add('item_damaged');
      issue = 'damaged';
    }
    if (/\brefund\b/i.test(x) && /\b(return|send (it )?back)\b/i.test(x)) {
      resolution = 'return_and_refund';
      issue = 'return';
    } else if (/\b(return|send (it )?back)\b/i.test(x)) {
      resolution = resolution === 'return_and_refund' ? resolution : 'return';
      issue = issue === 'unknown' || issue === 'general' ? 'return' : issue;
    } else if (/\brefund|money back\b/i.test(x)) {
      resolution = resolution === 'return_and_refund' ? resolution : 'refund';
      issue = issue === 'unknown' || issue === 'general' ? 'refund' : issue;
    } else if (/\b(exchange|swap)\b/i.test(x)) {
      resolution = 'exchange';
      issue = 'exchange';
    } else if (/\bcancel/i.test(x)) {
      resolution = 'cancellation';
      issue = 'cancellation';
    }
    if (
      /\bi (want|would like|need) to (return|get a refund)|\bi want (a )?(refund|to return)|\bplease (process|proceed)|\bi('?d| would) like to return/i.test(
        x,
      )
    )
      resolutionConfirmed = true;
    if (yes && /confirm|proceed|would you like to return|want to return/i.test(lastAgent))
      resolutionConfirmed = true;
    if (/\bi already confirmed\b/i.test(x) && resolution !== 'unknown') resolutionConfirmed = true;
  }
  return {
    issue_type: issue,
    confirmed_facts: [...confirmed],
    denied_facts: [...denied],
    retracted_facts: [...retracted],
    other_facts: [],
    desired_resolution: resolution,
    resolution_confirmed: resolutionConfirmed,
    asks_next_step:
      /\bnext steps?\b|\bwhat (do i|happens|now)\b|\bhow (do|can) i (proceed|return|send)\b/i.test(
        latest,
      ),
    corrections,
  };
}

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
        case_update: extractCase(input.history, text),
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
      const questions: QuestionTopic[] = [];
      let documented = true;
      let humanReview = input.mode === 'escalation' || input.mode === 'insufficient';
      const e = input.eligibility;
      const known = new Set(input.avoidAsking);

      if (input.mode === 'small_talk') lines.push('Happy to help. What can I do for you today?');
      else if (input.mode === 'escalation')
        lines.push('I will pass this to a member of our team who will take over from here.');
      else if (input.mode === 'clarify') {
        lines.push('Could you tell me a little more about what you need help with?');
        questions.push('other');
      } else if (input.mode === 'insufficient')
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
      } else if (input.nextAction === 'ask_missing_info') {
        if (input.missingInformation.includes('order_reference')) {
          lines.push('Could you share your order number so I can look up the details?');
          questions.push('order_reference');
        }
        if (input.missingInformation.includes('photo') && !input.customerSentImage) {
          lines.push('Could you please send a photo of the damage so we can look into it?');
          questions.push('photo_provided');
        }
      } else if (input.nextAction === 'provide_next_step') {
        // Acknowledge the decision once; when the customer follows up, answer the actual question instead.
        const acknowledged = Boolean(input.lastAgentReply?.includes('Thank you for confirming'));
        lines.push(
          acknowledged
            ? 'On the next step:'
            : 'Thank you for confirming that you would like to proceed.',
        );
        const mentioned = [
          known.has('item_unused') ? 'unused' : null,
          known.has('original_packaging') ? 'in its original packaging' : null,
        ].filter(Boolean);
        if (mentioned.length)
          lines.push(
            `You mentioned the item is ${mentioned.join(' and ')}; our team confirms this when the item is inspected.`,
          );
        for (const x of e) {
          if (x.outcome === 'eligible')
            lines.push(
              `Your ${x.kind} request looks eligible under our policy, subject to verification.`,
            );
        }
        // The seeded policies do not document how a return is started, so the honest next step is a human handoff.
        const procedure = input.sources.some((s) =>
          /how to (start|initiate)|return form|return portal/i.test(s.content),
        );
        if (!procedure) {
          lines.push('Our team will follow up with the exact return instructions.');
          documented = false;
          humanReview = true;
        }
        if (input.sources[0]) cited.push(input.sources[0].label);
      } else {
        for (const x of e) {
          if (x.outcome === 'ineligible')
            lines.push(`Unfortunately this is outside our policy: ${x.reason}.`);
          else if (x.outcome === 'eligible')
            lines.push(
              `This looks eligible under our policy, subject to verification: ${x.reason}.`,
            );
          else if (x.details.missing_evidence === 'photo' && !input.customerSentImage) {
            lines.push('Could you please send a photo of the damage so we can look into it?');
            questions.push('photo_provided');
          } else lines.push('Our team will review this and get back to you.');
        }
        if (input.customerSentImage)
          lines.push('Thank you for the photo; our team will review it.');
        if (e.length === 0) lines.push('Our team will review your request.');
        if (input.sources[0]) cited.push(input.sources[0].label);
      }
      let replyBody = lines.join(' ');
      // A repeated customer message must not get a repeated answer (the real model is told the same in its prompt).
      if (
        input.lastAgentReply &&
        replyBody &&
        input.lastAgentReply.includes(replyBody.slice(0, 40))
      ) {
        replyBody =
          'Thanks for following up. Nothing has changed on our side yet; the team has your request and will come back to you.';
        questions.length = 0;
      }
      const value: ComposedReply = {
        reply_body: replyBody,
        cited_source_ids: cited,
        reply_language: 'en',
        asks_customer_for_photo: /send a photo/.test(lines.join(' ')),
        promises_refund: false,
        promises_replacement: false,
        offers_discount: false,
        claims_action_done: false,
        questions_asked: questions,
        next_step_documented: documented,
        suggest_human_review: humanReview,
        agent_note: null,
      };
      return wrap(value);
    },

    async judge() {
      return wrap({ violations: [] });
    },
  };
}
