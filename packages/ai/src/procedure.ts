/**
 * Procedural grounding. An operational instruction in a reply ("we will arrange a collection", "use the return
 * portal", "send it to this address") is only allowed when an APPLICABLE policy sentence documents it.
 *
 * "Applicable" is stricter than "the word appears somewhere in a retrieved policy":
 *  - the check is per sentence of the policy, so a sentence's own conditions travel with the term;
 *  - a sentence scoped to defective/damaged goods (or any sentence of a damage/warranty policy) only authorises
 *    the procedure for a case that actually involves a defect or damage;
 *  - a customer-side mistake (they ordered the wrong item) therefore never inherits the remedy for a faulty item.
 */

export interface ProcedureSource {
  category?: string;
  content: string;
}

/** Operational terms that describe how something is done. */
const TERM_PATTERNS: [string, RegExp][] = [
  ['return label', /\b(return|shipping|prepaid|postage)\s+label\b/i],
  ['rma', /\b(rma|return authori[sz]ation|return (number|reference|id))\b/i],
  ['return portal', /\b(return|returns|customer)\s+(portal|form|page)\b/i],
  ['drop-off', /\bdrop[- ]?off\b|\bdrop (it|them) (off|at)\b/i],
  ['pick-up', /\bpick[- ]?up\b|\bwe(?:'ll| will) collect\b|\bcollect(?:ed)? from you\b/i],
  ['collection', /\b(prepaid |free |complimentary )?collection\b/i],
  ['courier', /\bcourier\b|\bcarrier will\b/i],
  ['qr code', /\bqr[- ]code\b/i],
  ['return address', /\breturn address\b|\bsend (it|them|the item) (to|back to)\b/i],
  ['tracking number', /\btracking (number|code|link)\b/i],
  [
    'street address',
    /\b\d{1,5}\s+[A-Z][\w.]*(?:\s+[A-Z][\w.]*)?\s+(street|st\.?|road|rd\.?|avenue|ave\.?|lane|ln\.?|drive|dr\.?|boulevard|blvd\.?)\b|\bp\.?o\.? box\b/i,
  ],
  [
    'packaging supplied',
    /\bwe(?:'ll| will) (send|provide|supply) you (a |the )?(box|bag|packaging|packing)\b/i,
  ],
];

/** A source sentence only applies to defective/damaged goods. */
const DEFECT_SCOPE =
  /\b(defective|defect|damaged|damage|faulty|fault|broken|arrived (damaged|broken))\b/i;
const DEFECT_CATEGORIES = new Set(['damaged_products', 'warranty']);
/** An instruction to contact the brand counts as a documented (human) procedure. */
const CONTACT = /\b(contact|email|write to|call|reach out to|get in touch)\b/i;

export const splitSentences = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Procedure terms used in a piece of text (normalised names). */
export function procedureTermsIn(text: string): string[] {
  return TERM_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

interface Authority {
  term: string;
  sentenceScopedToDefect: boolean;
}

function authorities(sources: ProcedureSource[]): Authority[] {
  const out: Authority[] = [];
  for (const src of sources) {
    const categoryScoped = src.category !== undefined && DEFECT_CATEGORIES.has(src.category);
    for (const sentence of splitSentences(src.content)) {
      const scoped = categoryScoped || DEFECT_SCOPE.test(sentence);
      for (const term of procedureTermsIn(sentence))
        out.push({ term, sentenceScopedToDefect: scoped });
    }
  }
  return out;
}

export interface ProcedureViolation {
  term: string;
  reason: 'not_documented' | 'only_documented_for_defective_items';
}

/** Procedure terms in `reply` that no applicable source sentence authorises. */
export function findUnauthorizedProcedures(
  reply: string,
  sources: ProcedureSource[],
  opts: { caseHasDefect: boolean },
): ProcedureViolation[] {
  const known = authorities(sources);
  const violations: ProcedureViolation[] = [];
  for (const term of new Set(procedureTermsIn(reply))) {
    const matching = known.filter((a) => a.term === term);
    if (matching.length === 0) {
      violations.push({ term, reason: 'not_documented' });
    } else if (!opts.caseHasDefect && matching.every((a) => a.sentenceScopedToDefect)) {
      violations.push({ term, reason: 'only_documented_for_defective_items' });
    }
  }
  return violations;
}

/**
 * Do the sources document a next step that applies to this case? A sentence with a procedure term, or an
 * instruction to contact the brand, counts, subject to the same defect scoping as above.
 */
export function hasDocumentedProcedure(
  sources: ProcedureSource[],
  opts: { caseHasDefect: boolean },
): boolean {
  for (const src of sources) {
    const categoryScoped = src.category !== undefined && DEFECT_CATEGORIES.has(src.category);
    for (const sentence of splitSentences(src.content)) {
      const scoped = categoryScoped || DEFECT_SCOPE.test(sentence);
      if (scoped && !opts.caseHasDefect) continue;
      if (procedureTermsIn(sentence).length > 0 || CONTACT.test(sentence)) return true;
    }
  }
  return false;
}
