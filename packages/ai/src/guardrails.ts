/**
 * Layer-4 output validation. Pure, deterministic and independent of the model that wrote the draft.
 * Each check returns a GuardrailResult; any `blocking` failure keeps the draft from reaching the agent
 * as a normal draft (the graph retries once, then falls back safely).
 */
import type { Eligibility, GuardrailResult } from '@cx/shared';
import { findUnauthorizedProcedures } from './procedure.js';
import type { DeliveryEstimate, OrderFacts } from './policy/rules.js';

export interface GuardrailSource {
  id: string;
  title: string;
  content: string;
  /** KB category; used to scope procedures (a damage policy only applies to damaged goods). */
  category?: string;
}

export interface GuardrailInput {
  /** Final customer-facing text as it would be sent (greeting + body + sign-off). */
  reply: string;
  citedIds: string[];
  /** Entries the model was given (all belong to the conversation's brand by construction). */
  sources: GuardrailSource[];
  eligibility: Eligibility[];
  order: OrderFacts | null;
  /** Computed delivery state; its day counts are verified facts the reply may quote. */
  deliveryEstimate?: DeliveryEstimate | null;
  /** Names of every OTHER brand in the system. */
  otherBrandNames: string[];
  /** The customer has sent at least one image in this conversation. */
  customerSentImage: boolean;
  /** An agent already replied earlier in this conversation. */
  priorAgentMessage: boolean;
  /** Did the retrieval step find sufficient evidence for a policy answer? */
  retrievalSufficient: boolean;
  /** True when the intent needs policy knowledge (as opposed to small talk / order lookups). */
  policyRelevant: boolean;
  expectedLanguage: string;
  replyLanguage: string;
  /** Self-reported by the model; used in addition to (not instead of) the text checks. */
  selfReported?: {
    promises_refund?: boolean;
    promises_replacement?: boolean;
    offers_discount?: boolean;
    claims_action_done?: boolean;
    /** Topics of the questions the reply asks (QuestionTopic). */
    questions_asked?: string[];
  };
  /** Conversation awareness: topics the customer has already answered (confirmed or denied). */
  answeredTopics?: string[];
  /** The previous agent reply, to catch a draft that repeats it. */
  lastAgentReply?: string | null;
  /** The customer explicitly asked for an explanation again, so repeating earlier content is legitimate. */
  allowRepeat?: boolean;
  /** Policy figures an agent already stated earlier in this conversation (normalised, see statedFigures). */
  previouslyStatedFigures?: string[];
  /** The case genuinely involves a defect or damage (customer statement or a damage eligibility result). */
  caseHasDefect?: boolean;
  /**
   * False while the customer has only reported a problem and nobody has asked for (or the case does not call for) a
   * return/refund/cancellation outcome. Eligibility must not be asserted then. Default true.
   */
  eligibilityTopicOpen?: boolean;
}

const pass = (
  check: string,
  severity: GuardrailResult['severity'] = 'info',
  detail?: string,
): GuardrailResult => ({ check, passed: true, severity, detail });
const fail = (
  check: string,
  severity: GuardrailResult['severity'],
  detail: string,
): GuardrailResult => ({ check, passed: false, severity, detail });

const SOURCE_LABEL = /(\(\s*(source|sources|fuente|fuentes|quelle)\s*:|\bS[1-9]\b)/i;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

const LEAK_TERMS =
  /\b(system prompt|developer message|api[\s_-]?key|service[\s_-]?role|langgraph|langchain|openai|embedding|vector|as an ai language model)\b/i;

/** Past-tense or present-perfect claims that an action was performed. This tool can never perform actions. */
const ACTION_DONE = [
  /\b(i('|’)?ve|i have|we('|’)?ve|we have)\s+(already\s+)?(refunded|issued|processed|cancel+ed|approved|initiated|arranged|sent|shipped|dispatched|credited)\b/i,
  /\b(has|have) been\s+(refunded|issued|processed|cancel+ed|approved|credited|dispatched|shipped|initiated)\b/i,
  /\byour (refund|replacement|cancellation|return)\s+(is|has been|was)\s+(approved|confirmed|processed|complete|done)\b/i,
  /\b(he|ha)\s*(sido|n sido)\s+(reembolsad|cancelad|aprobad|procesad)/i,
  /\b(a|ont) été\s+(rembours|annul|approuv|trait)/i,
];

const REFUND_PROMISE = [
  /\b(we('|’)?ll|we will|i('|’)?ll|i will|we are going to|we('|’)?re going to)\s+(\w+\s+){0,3}(refund|reimburse|credit)\b/i,
  /\byou('|’)?ll\s+(get|receive)\s+(a|your|the|an)?\s*(full\s+)?(refund|reimbursement|replacement|credit)\b/i,
  /\byou will\s+(get|receive)\s+(a|your|the|an)?\s*(full\s+)?(refund|reimbursement|replacement|credit)\b/i,
  /\b(full|guaranteed|100%)\s+refund\b/i,
  /\b(reembolsaremos|devolveremos|rembourserons|vous rembourser|te reembolsar)/i,
];
/**
 * Words that actually ASSERT an entitlement. A bare "you are" / "you're" is not one: "you're looking for a refund"
 * or "you are asking about a return" describe the request, they do not promise anything.
 */
const ENTITLEMENT_WORDS = String.raw`eligible|entitled|qualif(?:y|ies|ied)|(?:you|you(?:'|’)?re|you are) (?:can|may|are able to|(?:'|’)?re able to|are allowed to|(?:'|’)?re allowed to) (?:return|get|claim|receive|obtain)`;
const NEGATION = /\b(not|no longer|never|cannot|unable|ineligible)\b|n['’]t\b/i;

const entitlementPattern = (noun: string) =>
  new RegExp(String.raw`\b(${ENTITLEMENT_WORDS})\b[^.!?\n]{0,40}\b(${noun})`, 'gi');

/** Does the text affirmatively say the customer is eligible for / entitled to <noun>? Negated statements are ignored. */
function claimsEntitlementTo(text: string, noun: string): boolean {
  return [...text.matchAll(entitlementPattern(noun))].some((m) => {
    const at = m.index ?? 0;
    // negation anywhere earlier in the SAME sentence ("you are not eligible…", "you can't return…") cancels the claim
    const sentenceStart = Math.max(
      text.lastIndexOf('.', at) + 1,
      text.lastIndexOf('!', at) + 1,
      text.lastIndexOf('?', at) + 1,
      text.lastIndexOf('\n', at) + 1,
    );
    return !NEGATION.test(text.slice(sentenceStart, at + m[0].length));
  });
}

/** True when the text affirmatively says the customer qualifies ("you are eligible…"), ignoring negated statements. */
function claimsEntitlement(text: string): boolean {
  return claimsEntitlementTo(text, 'refund|return|replacement|cancel');
}
const GUARANTEE = /\b(guarantee[ds]?|i promise|we promise|definitely will|100% sure)\b/i;
const GUARANTEE_ALL = /\b(guarantee[ds]?|i promise|we promise|definitely will|100% sure)\b/gi;
const DISCLAIMER = /\b(not|no|cannot|never|without|unable)\b|n['’]t\b/i;

/**
 * A guarantee is only a problem when it is ASSERTED. "I can't guarantee an outcome", "this does not guarantee a
 * refund" and "there is no guarantee" are the honest disclaimers we want, so a negation earlier in the same
 * sentence cancels the match.
 */
function assertsGuarantee(text: string): boolean {
  return [...text.matchAll(GUARANTEE_ALL)].some((m) => {
    const at = m.index ?? 0;
    const sentenceStart = Math.max(
      text.lastIndexOf('.', at) + 1,
      text.lastIndexOf('!', at) + 1,
      text.lastIndexOf('?', at) + 1,
      text.lastIndexOf('\n', at) + 1,
    );
    return !DISCLAIMER.test(text.slice(sentenceStart, at + m[0].length));
  });
}
const DISCOUNT =
  /(\bdiscount\b|\bcoupon\b|\bpromo(tion(al)?)? code\b|\bvoucher\b|\b\d{1,2}\s?% off\b|\bfree gift\b|\bstore credit\b|\bcomplimentary upgrade\b)/i;

const PHOTO_WORD =
  /\b(photos?|pictures?|images?|screenshots?|attachments?|foto|photo|imagen|image|तस्वीर|फोटो)\b/i;
const CLAIMS_PHOTO_RECEIVED =
  /\b(thanks? (you )?for (sending|sharing|the|your)|(received|got|can see|i see|i('|’)?ve (seen|reviewed)|looking at)|(gracias por|merci pour|reçu|recibido|hemos recibido|nous avons reçu))\b[^.!?\n]{0,50}\b(photos?|pictures?|images?|screenshots?|foto|imagen)\b/i;
const ASKS_FOR_PHOTO =
  /\b(send|share|provide|upload|attach|submit|could you (please )?(send|share)|please (send|share)|envíe|enviar|envoyez|partagez|भेज)\b[^.!?\n]{0,50}\b(photos?|pictures?|images?|screenshots?|foto|imagen|तस्वीर|फोटो)\b/i;

// Backstops for the model's own \`questions_asked\` self-report (English only; other languages rely on the report).
const REASKS: Record<string, RegExp> = {
  resolution_confirmation:
    /\b(please |kindly )?confirm (that )?(you|if you|whether you)( still)? (want|would like|wish) to (return|proceed|go ahead|get)|\bdo you (still )?(want|wish) to (return|proceed)|\bwould you like (me )?to proceed\b|\bcan you confirm (that )?you (want|would like)\b/i,
  item_unused:
    /\b(is|was|has)\s+(the\s+(item|product)|it)\s+(been\s+)?(un)?used\b|\bhave you (used|opened)\b|\bconfirm\b[^.?!]{0,40}\bunused\b/i,
  original_packaging:
    /\b(is|was)\s+(it|the\s+(item|product))\b[^.?!]{0,25}\boriginal packaging\b|\bconfirm\b[^.?!]{0,40}\bpackaging\b|\bdo you still have the (original )?(packaging|box)\b/i,
};

/** Normalised "n unit" / "$n" tokens, used to notice a reply restating a policy figure it already gave. */
export function statedFigures(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(
    /(\d{1,3}(?:[.,]\d+)?)\s*[- ]?\s*(business\s+days?|working\s+days?|days?|hours?|weeks?)\b/gi,
  )) {
    out.add(`${m[1]} ${m[2]!.toLowerCase().replace(/s$/, '').replace(/\s+/g, ' ')}`);
  }
  for (const m of text.matchAll(/[$€£]\s?(\d{1,6}(?:[.,]\d{1,2})?)/g)) out.add(`$${m[1]}`);
  return [...out];
}

const words = (t: string) => new Set(t.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []);
function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

const GREETING_START =
  /^\s*(hi|hello|hey|dear|hola|bonjour|namaste|good (morning|afternoon|evening))\b/i;

const UNITS =
  '(?:business\\s+days?|working\\s+days?|days?|hours?|hrs?|weeks?|months?|años|días|dias|horas|jours?|heures?|semaines?|दिन|घंटे)';
const FIGURE = new RegExp(`(\\d{1,3}(?:[.,]\\d+)?)\\s*[- ]?\\s*${UNITS}`, 'gi');
const MONEY = /(?:[$€£₹]\s?|USD\s?)(\d{1,6}(?:[.,]\d{1,2})?)/g;
const ORDER_NUMBER = /\b[A-Z]{2}-\d{4,6}\b/g;

function numbersIn(text: string, re: RegExp): number[] {
  return [...text.matchAll(new RegExp(re.source, re.flags))].map((m) =>
    Number(String(m[1]).replace(',', '.')),
  );
}

function collectAllowedFigures(input: GuardrailInput): { counts: Set<number>; money: Set<number> } {
  const counts = new Set<number>();
  const money = new Set<number>();
  for (const s of input.sources) {
    numbersIn(s.content, FIGURE).forEach((n) => counts.add(n));
    numbersIn(s.content, MONEY).forEach((n) => money.add(n));
  }
  const addDetailNumbers = (v: unknown) => {
    if (typeof v === 'number') {
      counts.add(v);
      if (Number.isInteger(v)) counts.add(Math.abs(v));
    }
  };
  for (const e of input.eligibility) {
    Object.values(e.details).forEach(addDetailNumbers);
    // hours expressed as days (48h = 2 days) and vice versa
    const h = e.details.report_within_hours;
    if (typeof h === 'number') counts.add(h / 24);
    const w = e.details.window_days;
    if (typeof w === 'number') counts.add(w * 24);
    const thr = e.details.free_shipping_threshold;
    if (typeof thr === 'number') money.add(thr);
  }
  const de = input.deliveryEstimate;
  if (de) {
    for (const v of Object.values(de)) if (typeof v === 'number') counts.add(Math.abs(v));
  }
  if (input.order) {
    money.add(input.order.total);
    for (const it of input.order.items) {
      money.add(it.unit_price);
      money.add(Math.round(it.unit_price * it.quantity * 100) / 100);
    }
  }
  return { counts, money };
}

export function validateDraft(input: GuardrailInput): GuardrailResult[] {
  const out: GuardrailResult[] = [];
  const text = input.reply;
  const sourceText = input.sources.map((s) => s.content).join('\n');
  const outcomeOf = (kind: Eligibility['kind']) =>
    input.eligibility.find((e) => e.kind === kind)?.outcome;

  // --- citations --------------------------------------------------------------------------------
  const allowedIds = new Set(input.sources.map((s) => s.id));
  const badIds = input.citedIds.filter((id) => !allowedIds.has(id));
  out.push(
    badIds.length
      ? fail(
          'citations_exist',
          'blocking',
          `Cited ${badIds.length} source(s) that were not provided to the model`,
        )
      : pass('citations_exist'),
  );
  if (input.sources.length > 0 && input.policyRelevant && input.citedIds.length === 0) {
    out.push(
      fail(
        'citations_present',
        'warning',
        'The draft cites no policy source even though policy context was available',
      ),
    );
  }

  // --- insufficient context -----------------------------------------------------------------------
  if (input.policyRelevant && !input.retrievalSufficient) {
    const stated = numbersIn(text, FIGURE).length + numbersIn(text, MONEY).length;
    out.push(
      stated > 0
        ? fail(
            'no_policy_without_evidence',
            'blocking',
            'The draft states policy figures although no relevant policy was found',
          )
        : pass('no_policy_without_evidence'),
    );
  }

  // --- ungrounded figures ---------------------------------------------------------------------------
  const allowed = collectAllowedFigures(input);
  const badCounts = [...new Set(numbersIn(text, FIGURE))].filter((n) => !allowed.counts.has(n));
  const badMoney = [...new Set(numbersIn(text, MONEY))].filter((n) => !allowed.money.has(n));
  out.push(
    badCounts.length || badMoney.length
      ? fail(
          'grounded_figures',
          'blocking',
          `Figures not found in the provided policy or order facts: ${[...badCounts.map((n) => String(n)), ...badMoney.map((n) => `$${n}`)].join(', ')}`,
        )
      : pass('grounded_figures'),
  );

  // --- order identity -------------------------------------------------------------------------------
  const mentioned = [...new Set(text.match(ORDER_NUMBER) ?? [])];
  const wrongOrders = mentioned.filter((o) => o !== input.order?.order_number);
  out.push(
    wrongOrders.length
      ? fail(
          'order_number_matches',
          'blocking',
          'The draft mentions an order number that is not this conversation’s order',
        )
      : pass('order_number_matches'),
  );

  // --- actions that were never performed ---------------------------------------------------------------
  const doneHit = ACTION_DONE.some((re) => re.test(text)) || input.selfReported?.claims_action_done;
  out.push(
    doneHit
      ? fail(
          'no_completed_action_claims',
          'blocking',
          'The draft says an action (refund, cancellation, dispatch…) has already been done; drafts can only describe next steps',
        )
      : pass('no_completed_action_claims'),
  );

  // --- unsupported promises -----------------------------------------------------------------------------
  const refundEligible =
    outcomeOf('refund') === 'eligible' ||
    outcomeOf('damage') === 'eligible' ||
    outcomeOf('return') === 'eligible';
  const promisesRefund =
    REFUND_PROMISE.some((re) => re.test(text)) ||
    input.selfReported?.promises_refund ||
    input.selfReported?.promises_replacement;
  if (promisesRefund) {
    out.push(
      refundEligible
        ? fail(
            'no_unsupported_promises',
            'warning',
            'The draft commits to a refund/replacement; eligible, but wording must stay subject to verification',
          )
        : fail(
            'no_unsupported_promises',
            'blocking',
            'The draft promises a refund/replacement that the eligibility rules do not support',
          ),
    );
  } else if (
    claimsEntitlement(text) &&
    !refundEligible &&
    !input.eligibility.some((e) => e.outcome === 'eligible')
  ) {
    out.push(
      fail(
        'no_unsupported_promises',
        'blocking',
        'The draft says the customer is eligible/entitled but no eligibility rule confirms it',
      ),
    );
  } else {
    out.push(pass('no_unsupported_promises'));
  }
  // Ineligible outcomes must not be contradicted.
  for (const e of input.eligibility) {
    if (
      (e.kind === 'refund' || e.kind === 'return') &&
      e.outcome === 'ineligible' &&
      claimsEntitlementTo(text, e.kind === 'refund' ? 'refund' : 'return|exchange')
    ) {
      out.push(
        fail(
          'respects_ineligibility',
          'blocking',
          `The ${e.kind} rule says ineligible but the draft reads as if the customer qualifies`,
        ),
      );
    }
  }
  out.push(
    assertsGuarantee(text) && !GUARANTEE.test(sourceText)
      ? fail(
          'no_guarantees',
          'blocking',
          'The draft makes a guarantee/promise that is not in the policy',
        )
      : pass('no_guarantees'),
  );
  out.push(
    (DISCOUNT.test(text) && !DISCOUNT.test(sourceText)) || input.selfReported?.offers_discount
      ? fail(
          'no_invented_offers',
          'blocking',
          'The draft offers a discount/credit/gift that is not in the policy',
        )
      : pass('no_invented_offers'),
  );

  // --- brand isolation -------------------------------------------------------------------------------------
  const leaked = input.otherBrandNames.filter(
    (n) => n && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text),
  );
  out.push(
    leaked.length
      ? fail('no_cross_brand_leakage', 'blocking', 'The draft mentions another brand')
      : pass('no_cross_brand_leakage'),
  );

  // --- confidentiality -------------------------------------------------------------------------------------------
  out.push(
    UUID.test(text) || LEAK_TERMS.test(text)
      ? fail(
          'no_internal_details',
          'blocking',
          'The draft exposes internal identifiers or system details',
        )
      : pass('no_internal_details'),
  );

  // --- internal source labels must never reach the customer -----------------------------------------------
  out.push(
    SOURCE_LABEL.test(text)
      ? fail(
          'no_source_labels',
          'blocking',
          'The draft contains an internal source label such as "S1" or "(Source: …)"',
        )
      : pass('no_source_labels'),
  );

  // --- photos ------------------------------------------------------------------------------------------------------
  if (PHOTO_WORD.test(text)) {
    if (!input.customerSentImage && CLAIMS_PHOTO_RECEIVED.test(text)) {
      out.push(
        fail(
          'no_false_photo_claims',
          'blocking',
          'The draft says a photo was received but the customer has not sent one',
        ),
      );
    } else if (input.customerSentImage && ASKS_FOR_PHOTO.test(text)) {
      out.push(
        fail(
          'no_redundant_photo_request',
          'blocking',
          'The draft asks for a photo although the customer already sent one',
        ),
      );
    } else {
      out.push(pass('photo_consistency'));
    }
  } else {
    out.push(pass('photo_consistency'));
  }

  // --- progress: never ask what the customer already answered ----------------------------------------------------
  const answered = new Set(input.answeredTopics ?? []);
  const reasked = new Set<string>();
  for (const t of input.selfReported?.questions_asked ?? []) if (answered.has(t)) reasked.add(t);
  for (const [topic, re] of Object.entries(REASKS))
    if (answered.has(topic) && re.test(text)) reasked.add(topic);
  out.push(
    reasked.size
      ? fail(
          'no_redundant_question',
          'blocking',
          `The draft asks about something the customer already answered: ${[...reasked].join(', ')}. Use the known answer and move the case forward.`,
        )
      : pass('no_redundant_question'),
  );
  if (input.lastAgentReply && !input.allowRepeat) {
    const sim = similarity(text, input.lastAgentReply);
    out.push(
      sim >= 0.85
        ? fail(
            'no_repeated_reply',
            'blocking',
            'The draft repeats the previous agent reply. Acknowledge the new message and move forward.',
          )
        : pass('no_repeated_reply'),
    );
  }
  // Policy facts the customer has already been given are not restated unless they ask for it (advisory).
  if (!input.allowRepeat && input.previouslyStatedFigures?.length) {
    const again = statedFigures(text).filter((f) => input.previouslyStatedFigures!.includes(f));
    if (again.length) {
      out.push(
        fail(
          'repeats_policy_facts',
          'warning',
          `The draft restates policy figures an agent already gave (${again.join(', ')}); lead with the next step instead.`,
        ),
      );
    }
  }

  // --- eligibility must be requested, verified and specific -------------------------------------------------------------
  const claimsReturn = claimsEntitlementTo(text, 'return|exchange');
  const claimsRefund = claimsEntitlementTo(text, 'refund');
  const eligibleKinds = new Set(
    input.eligibility.filter((e) => e.outcome === 'eligible').map((e) => e.kind),
  );
  const damageEligible = eligibleKinds.has('damage');
  const unsupported = [
    claimsReturn && !eligibleKinds.has('return') && !damageEligible ? 'return' : null,
    claimsRefund && !eligibleKinds.has('refund') && !damageEligible ? 'refund' : null,
  ].filter(Boolean);
  out.push(
    unsupported.length
      ? fail(
          'eligibility_claim_supported',
          'blocking',
          `The draft says the customer is eligible for a ${unsupported.join(' / ')} but no verified eligibility check supports it.`,
        )
      : pass('eligibility_claim_supported'),
  );
  if (input.eligibilityTopicOpen === false) {
    const asserted =
      claimsEntitlement(text) ||
      claimsReturn ||
      claimsRefund ||
      /\bwithin (the |our )?\d+[- ]day (return|refund)\b|\b(return|refund) window (ends|closes|is)\b/i.test(
        text,
      );
    out.push(
      asserted
        ? fail(
            'no_unrequested_eligibility',
            'blocking',
            'The customer has only reported a problem and has not asked for a return or refund yet. Do not state eligibility; clarify what happened and what they would like.',
          )
        : pass('no_unrequested_eligibility'),
    );
  }

  // --- procedures must be documented for THIS case ---------------------------------------------------------------
  const unauthorized = findUnauthorizedProcedures(text, input.sources, {
    caseHasDefect: Boolean(input.caseHasDefect),
  });
  out.push(
    unauthorized.length
      ? fail(
          'no_invented_procedure',
          'blocking',
          `The draft describes a procedure the policy does not document for this case: ${unauthorized
            .map((u) =>
              u.reason === 'only_documented_for_defective_items'
                ? `${u.term} (policy applies only to defective or damaged items)`
                : u.term,
            )
            .join(', ')}. Say the team will follow up with instructions instead.`,
        )
      : pass('no_invented_procedure'),
  );

  // --- conversation hygiene ------------------------------------------------------------------------------------------
  if (input.priorAgentMessage && GREETING_START.test(text)) {
    out.push(
      fail(
        'no_repeated_greeting',
        'warning',
        'An agent already greeted the customer earlier in this conversation',
      ),
    );
  }
  if (
    input.expectedLanguage &&
    input.replyLanguage &&
    input.expectedLanguage !== input.replyLanguage
  ) {
    out.push(
      fail(
        'reply_language',
        'warning',
        `Customer wrote in "${input.expectedLanguage}" but the draft is in "${input.replyLanguage}"`,
      ),
    );
  }
  return out;
}

export const hasBlockingFailure = (results: GuardrailResult[]) =>
  results.some((r) => !r.passed && r.severity === 'blocking');
export const blockingMessages = (results: GuardrailResult[]) =>
  results
    .filter((r) => !r.passed && r.severity === 'blocking')
    .map((r) => `${r.check}: ${r.detail ?? ''}`.trim());
