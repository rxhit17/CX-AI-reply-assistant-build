import type { Eligibility, Intent, KbCategory } from '@cx/shared';

export type Route = 'small_talk' | 'order' | 'policy' | 'image' | 'human' | 'unsupported';

export interface RoutingInput {
  intent: Intent;
  asksForHuman: boolean;
  /** The conversation contains at least one image sent by the customer. */
  hasCustomerImage: boolean;
}

/** Pure routing decision for the LangGraph conditional edge. */
export function routeFor({ intent, asksForHuman, hasCustomerImage }: RoutingInput): Route {
  if (asksForHuman || intent === 'human_agent_request') return 'human';
  if (intent === 'greeting') return 'small_talk';
  if (intent === 'unclear') return 'unsupported';
  if (intent === 'order_status') return 'order';
  if (intent === 'damaged_product' && hasCustomerImage) return 'image';
  return 'policy';
}

/** Categories that boost ranking for an intent (they never filter: retrieval still searches the whole brand KB). */
export function categoriesForIntent(intent: Intent): KbCategory[] | null {
  switch (intent) {
    case 'return_request':
    case 'exchange':
      return ['return_policy'];
    case 'refund_request':
      return ['refund_policy', 'return_policy'];
    case 'damaged_product':
      return ['damaged_products', 'refund_policy'];
    case 'shipping_question':
      return ['shipping_policy', 'delivery_problems'];
    case 'cancellation':
      return ['cancellation_policy'];
    case 'missing_product':
      return ['missing_products', 'delivery_problems'];
    default:
      return null;
  }
}

/** Which deterministic checks apply to an intent. */
export function eligibilityKindsFor(intent: Intent): Eligibility['kind'][] {
  switch (intent) {
    case 'return_request':
    case 'exchange':
      return ['return'];
    case 'refund_request':
      return ['refund'];
    case 'damaged_product':
      return ['damage'];
    case 'cancellation':
      return ['cancellation'];
    case 'shipping_question':
      return ['shipping'];
    default:
      return [];
  }
}

const INJECTION_PATTERNS = [
  /ignore\b[^.!?\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.!?\n]{0,30}\b(instruction|prompt|rule)s?/i,
  /disregard\b[^.!?\n]{0,40}\b(instruction|rule|polic)/i,
  /(reveal|show|print|repeat|leak)\b[^.!?\n]{0,30}\b(system|developer|hidden|initial)\b[^.!?\n]{0,10}\b(prompt|message|instruction)/i,
  /\b(developer|debug|jailbreak|dan)\s+mode\b/i,
  /you are now\b/i,
  /\b(act|pretend)\s+as\b[^.!?\n]{0,30}\b(admin|developer|manager|system)/i,
  /\bapi[\s_-]?key\b/i,
  /override\b[^.!?\n]{0,30}\b(polic|rule|restriction)/i,
];

/** Cheap heuristic pre-screen; the model also reports `injection_suspected`. Either one triggers extra care. */
export function looksLikePromptInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

const GREETING_ONLY =
  /^\s*(hi|hello|hey|hola|namaste|good (morning|afternoon|evening)|thanks?|thank you|gracias|shukriya)[\s!.,?]*$/i;
export function isGreetingOnly(text: string): boolean {
  return GREETING_ONLY.test(text);
}
