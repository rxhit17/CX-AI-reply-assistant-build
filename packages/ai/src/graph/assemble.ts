import type { BrandVoice } from '../ports.js';

export const firstName = (full: string) => full.trim().split(/\s+/)[0] ?? full;

/** A conversation that has been quiet this long gets a fresh greeting/sign-off again. */
export const RESUME_AFTER_MS = 6 * 3_600_000;

/**
 * Brand sign-offs belong on the first reply and when a conversation resumes after a pause, not on every message
 * of a live chat (which reads like email and looks robotic). Brand voice is unchanged; only the frequency is.
 */
export function shouldAddSignOff(opts: {
  priorAgentMessage: boolean;
  lastAgentAt: string | null;
  now: number;
}): boolean {
  if (!opts.priorAgentMessage || !opts.lastAgentAt) return true;
  return opts.now - new Date(opts.lastAgentAt).getTime() > RESUME_AFTER_MS;
}

export interface AssembleInput {
  body: string;
  voice: BrandVoice;
  customerName: string;
  /** Add the brand's templated greeting (English replies to a customer nobody has greeted yet). */
  addGreeting: boolean;
  /** Defaults to true; see shouldAddSignOff. */
  addSignOff?: boolean;
}

/** Greeting and sign-off are applied by code so they are exact, never improvised by the model. */
export function assembleReply({
  body,
  voice,
  customerName,
  addGreeting,
  addSignOff = true,
}: AssembleInput): string {
  const parts: string[] = [];
  if (addGreeting && voice.greeting_preference) {
    parts.push(voice.greeting_preference.replaceAll('{first_name}', firstName(customerName)));
  }
  parts.push(body.trim());
  if (addSignOff && voice.sign_off && !body.trim().endsWith(voice.sign_off))
    parts.push(voice.sign_off);
  return parts.join('\n\n');
}

/**
 * Deterministic holding messages used only when no model draft passed validation. They commit to nothing:
 * they acknowledge the request and say a person will follow up. They are translations of one fixed sentence,
 * not generated content.
 */
const HOLDING: Record<string, string> = {
  en: 'Thank you for your message. We are looking into this and will get back to you shortly.',
  hinglish:
    'Aapke message ke liye shukriya. Hum ise dekh rahe hain aur jaldi hi aapse sampark karenge.',
};
export const holdingMessage = (language: string) => HOLDING[language] ?? HOLDING.en!;

const TOPIC: Record<string, Record<string, string>> = {
  en: {
    return: 'return',
    refund: 'refund',
    return_and_refund: 'return and refund',
    exchange: 'exchange',
    replacement: 'replacement',
    cancellation: 'cancellation',
    other: 'request',
  },
  hinglish: {
    return: 'return',
    refund: 'refund',
    return_and_refund: 'return aur refund',
    exchange: 'exchange',
    replacement: 'replacement',
    cancellation: 'cancellation',
    other: 'request',
  },
};

export interface HandoffInput {
  language: string;
  /** What the customer wants (case state): return, refund, return_and_refund, exchange, ... or anything else. */
  resolution: string;
  /** Verified order number, when an order is linked. */
  orderNumber: string | null;
  /** A handoff message was already sent: acknowledge the follow-up instead of repeating it. */
  followUp: boolean;
}

/**
 * Last-resort reply when no model draft passed validation but the case is understood. It is built only from the
 * case state and the verified order number: it names what was asked for, says the team will follow up, and promises
 * nothing else (no eligibility, no amounts, no steps). Far more useful than a generic holding message.
 */
export function handoffMessage({
  language,
  resolution,
  orderNumber,
  followUp,
}: HandoffInput): string {
  const lang = TOPIC[language] ? language : 'en';
  const topic = TOPIC[lang]![resolution] ?? TOPIC[lang]!.other!;
  const o = orderNumber;
  switch (lang) {
    case 'hinglish':
      return followUp
        ? `Follow-up ke liye shukriya. Aapki ${topic} request${o ? ` (order ${o})` : ''} hamari team ke paas hai; woh next steps ke saath aapse sampark karenge.`
        : `Aapke message ke liye shukriya. Aapki ${topic} request${o ? ` (order ${o})` : ''} hamari team ko bheji ja rahi hai; woh next steps ke saath aapse sampark karenge.`;
    default:
      return followUp
        ? `Thank you for following up. Your ${topic} request${o ? ` for order ${o}` : ''} is with our team, who will contact you with the next steps.`
        : `Thank you for your message. I am passing your ${topic} request${o ? ` for order ${o}` : ''} to our team, who will contact you with the next steps.`;
  }
}
