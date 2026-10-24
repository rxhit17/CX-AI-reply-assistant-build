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
  es: 'Gracias por tu mensaje. Estamos revisando tu caso y te responderemos en breve.',
  fr: 'Merci pour votre message. Nous étudions votre demande et reviendrons vers vous très rapidement.',
  hi: 'आपके संदेश के लिए धन्यवाद। हम इसे देख रहे हैं और जल्द ही आपसे संपर्क करेंगे।',
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
  es: {
    return: 'devolución',
    refund: 'reembolso',
    return_and_refund: 'devolución y reembolso',
    exchange: 'cambio',
    replacement: 'reemplazo',
    cancellation: 'cancelación',
    other: 'solicitud',
  },
  fr: {
    return: 'retour',
    refund: 'remboursement',
    return_and_refund: 'retour et remboursement',
    exchange: 'échange',
    replacement: 'remplacement',
    cancellation: 'annulation',
    other: 'demande',
  },
  hi: {
    return: 'वापसी',
    refund: 'रिफंड',
    return_and_refund: 'वापसी और रिफंड',
    exchange: 'एक्सचेंज',
    replacement: 'प्रतिस्थापन',
    cancellation: 'रद्दीकरण',
    other: 'अनुरोध',
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
    case 'es':
      return followUp
        ? `Gracias por escribir de nuevo. Tu solicitud de ${topic}${o ? ` del pedido ${o}` : ''} está con nuestro equipo, que se pondrá en contacto contigo con los siguientes pasos.`
        : `Gracias por tu mensaje. Estoy pasando tu solicitud de ${topic}${o ? ` del pedido ${o}` : ''} a nuestro equipo, que se pondrá en contacto contigo con los siguientes pasos.`;
    case 'fr':
      return followUp
        ? `Merci de votre relance. Votre demande de ${topic}${o ? ` pour la commande ${o}` : ''} est entre les mains de notre équipe, qui vous contactera avec les prochaines étapes.`
        : `Merci pour votre message. Je transmets votre demande de ${topic}${o ? ` pour la commande ${o}` : ''} à notre équipe, qui vous contactera avec les prochaines étapes.`;
    case 'hi':
      return followUp
        ? `फ़ॉलो-अप के लिए धन्यवाद। आपका ${topic} अनुरोध${o ? ` (ऑर्डर ${o})` : ''} हमारी टीम के पास है; वे अगले चरणों के साथ आपसे संपर्क करेंगे।`
        : `आपके संदेश के लिए धन्यवाद। आपका ${topic} अनुरोध${o ? ` (ऑर्डर ${o})` : ''} हमारी टीम को भेजा जा रहा है; वे अगले चरणों के साथ आपसे संपर्क करेंगे।`;
    default:
      return followUp
        ? `Thank you for following up. Your ${topic} request${o ? ` for order ${o}` : ''} is with our team, who will contact you with the next steps.`
        : `Thank you for your message. I am passing your ${topic} request${o ? ` for order ${o}` : ''} to our team, who will contact you with the next steps.`;
  }
}
