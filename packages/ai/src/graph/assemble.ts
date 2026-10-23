import type { BrandVoice } from '../ports.js';

export const firstName = (full: string) => full.trim().split(/\s+/)[0] ?? full;

export interface AssembleInput {
  body: string;
  voice: BrandVoice;
  customerName: string;
  /** Add the brand's templated greeting (English replies to a customer nobody has greeted yet). */
  addGreeting: boolean;
}

/** Greeting and sign-off are applied by code so they are exact, never improvised by the model. */
export function assembleReply({ body, voice, customerName, addGreeting }: AssembleInput): string {
  const parts: string[] = [];
  if (addGreeting && voice.greeting_preference) {
    parts.push(voice.greeting_preference.replaceAll('{first_name}', firstName(customerName)));
  }
  parts.push(body.trim());
  if (voice.sign_off && !body.trim().endsWith(voice.sign_off)) parts.push(voice.sign_off);
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
