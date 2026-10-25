/**
 * Order verification gate (pure functions). Before the assistant answers a question that needs order data it must
 * know which order the customer means, and that order must be one of THIS customer's orders in THIS brand. The
 * match is deterministic: no model decides whether an order number is valid.
 */
import type { Intent } from '@cx/shared';
import type { IssueType } from '../case-state.js';

/** Intents that cannot be answered without the customer's order (status, return, refund, damage, cancellation). */
const ORDER_INTENTS: Intent[] = [
  'order_status',
  'return_request',
  'refund_request',
  'exchange',
  'damaged_product',
  'cancellation',
  'missing_product',
];
const ORDER_ISSUES: IssueType[] = [
  'order_status',
  'return',
  'refund',
  'exchange',
  'damaged',
  'missing',
  'cancellation',
  'mismatch',
];
/** A bare reply such as "BB-10041" carries no intent; the open case says what the customer is trying to do. */
const FOLLOW_UP_INTENTS: Intent[] = ['unclear', 'general_question', 'complaint', 'greeting'];

export function needsOrderData(intent: Intent, issueType: IssueType): boolean {
  if (ORDER_INTENTS.includes(intent)) return true;
  return FOLLOW_UP_INTENTS.includes(intent) && ORDER_ISSUES.includes(issueType);
}

/** Case, spaces, dashes and '#' do not matter: "bb 10041", "#BB-10041" and "BB10041" are the same number. */
export const normalizeOrderNumber = (s: string): string =>
  s.toUpperCase().replace(/[^A-Z0-9]/g, '');

const MIN_NUMBER_LENGTH = 5;

export interface OrderRef {
  id: string;
  order_number: string;
}

/** The customer's own order whose number appears in the text, or null. */
export function matchOrderNumber(text: string, orders: OrderRef[]): OrderRef | null {
  const haystack = normalizeOrderNumber(text);
  if (!haystack) return null;
  // Longest first, so a number that is a prefix of another cannot shadow it.
  const byLength = [...orders].sort((a, b) => b.order_number.length - a.order_number.length);
  return (
    byLength.find((o) => {
      const n = normalizeOrderNumber(o.order_number);
      return n.length >= MIN_NUMBER_LENGTH && haystack.includes(n);
    }) ?? null
  );
}

// Letters joined to digits ("BB-10041", "BB10041"), or a value introduced by "order id / number / no / #".
// ("NL 20077" with a space is caught by BARE below.)
const STRONG =
  /\b[A-Za-z]{1,6}[-_]?\d{3,}\b|\border\s*(?:id|number|no\.?|num|#)\s*[:#-]?\s*[A-Za-z0-9-]{3,}/i;
// Bare digits that look like an order number (not money, not a year).
const BARE = /(?<![\d$€£₹.,])\b\d{4,8}\b(?![\d%.,]\d)/g;
const CURRENCY_BEFORE = /(?:\$|€|£|₹|rs\.?|inr|usd)\s*$/i;

/** True if the text contains something that looks like an order number (so a failed match can be reported). */
export function hasOrderNumberCandidate(text: string): boolean {
  if (STRONG.test(text)) return true;
  for (const m of text.matchAll(BARE)) {
    const value = Number(m[0]);
    if (m[0].length === 4 && value >= 1900 && value <= 2099) continue; // a year
    if (CURRENCY_BEFORE.test(text.slice(0, m.index))) continue; // a price
    return true;
  }
  return false;
}

export type OrderGateOutcome = 'not_needed' | 'verified' | 'ask' | 'handoff';

export interface OrderGateResult {
  outcome: OrderGateOutcome;
  /** Customer messages that contained an order-number-like value which matched none of their orders. */
  failedAttempts: number;
  orderNumber?: string;
}

const ASK: Record<string, string> = {
  en: 'To look into this for you, could you please share your order number? You can find it in your order confirmation email.',
  hinglish:
    'Isme aapki madad karne ke liye, kya aap apna order number bata sakte hain? Yeh aapke order confirmation email mein hota hai.',
};
const RETRY: Record<string, string> = {
  en: 'I could not find an order matching that number on your account. Could you please check it and send it again? It is in your order confirmation email.',
  hinglish:
    'Aapke account par is number se koi order nahi mila. Kya aap ise ek baar check karke dobara bhej sakte hain? Yeh order confirmation email mein hota hai.',
};
const HANDOFF: Record<string, string> = {
  en: 'I am sorry we have not been able to locate your order. I am passing this to our team, who will help you find it and contact you shortly.',
  hinglish:
    'Maaf kijiye, hum aapka order nahi dhoondh paaye. Main ise hamari team ko bhej raha hoon, woh aapki madad karenge aur jaldi sampark karenge.',
};

/** Fixed wording (never model-written), so a customer cannot steer it and it reveals nothing about other accounts. */
export function orderRequestMessage(
  language: string,
  outcome: 'ask' | 'handoff',
  failedAttempts: number,
): string {
  const lang = ASK[language] ? language : 'en';
  if (outcome === 'handoff') return HANDOFF[lang]!;
  return (failedAttempts > 0 ? RETRY : ASK)[lang]!;
}
