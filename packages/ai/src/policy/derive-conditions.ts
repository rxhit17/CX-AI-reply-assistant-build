import type { KbCategory, PolicyConditions } from '@cx/shared';
import type { PolicyFigures } from '../llm/types.js';

/**
 * Keeps the structured numbers that drive the deterministic eligibility rules in step with the wording of a policy.
 * An admin edits the policy text only; on save the figures are read back out of it:
 *
 *   return / refund      window (days) and what it is counted from, whether exceptions may be reviewed
 *   damaged products     report window (hours or days), whether photo evidence is required, exceptions
 *   shipping             free-shipping threshold, delivery time in business days
 *   cancellation         the last order status in which cancelling is still allowed
 *
 * Two readers cooperate:
 *  1. a language model understands any phrasing ("two weeks", "no later than 72 hours", "orders above $75"...);
 *  2. a deterministic pattern reader covers the common phrasings and is the fallback when no model is available.
 *
 * A model answer is never trusted blindly: every number must appear in the policy text and its quoted evidence must
 * be a verbatim excerpt, otherwise that figure is discarded (see `validateFigures`). A figure that cannot be found
 * keeps its previous value and is reported as a warning; a yes/no flag that is no longer stated is switched off.
 * Categories with no structured figures (FAQ, warranty, ...) are returned untouched.
 */
export interface DerivedConditions {
  conditions: PolicyConditions | null;
  /** Human-readable list of what changed, e.g. "Return/refund window: 7 → 30 days". */
  changes: string[];
  /** Figures the text no longer states clearly; the previous value was kept. */
  warnings: string[];
}

/** Figures read from a policy; `undefined` means "not stated". */
export interface FoundFigures {
  window_days?: number;
  window_anchor?: 'delivery' | 'order';
  report_within_days?: number;
  free_shipping_threshold?: number;
  delivery_business_days?: [number, number];
  cancellable_until?: 'processing' | 'shipped';
  requires_photo?: boolean;
  discretionary_review?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Numbers written as words
// ---------------------------------------------------------------------------------------------
const UNITS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
  fortnight: 14,
  dozen: 12,
};

/** Every number a text states, as digits or as words ("thirty", "twenty-one"), including fortnights and weeks. */
export function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/\d+(?:\.\d+)?/g)) out.add(Number(m[0]));
  const words = lower.match(/[a-z]+/g) ?? [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (!(w in UNITS)) continue;
    let n = UNITS[w]!;
    const nextWord = words[i + 1];
    if (n >= 20 && n < 100 && nextWord && nextWord in UNITS && UNITS[nextWord]! < 10)
      n += UNITS[nextWord]!;
    out.add(n);
  }
  // "2 weeks" / "two weeks" / "a week" -> days; a month is counted as 30 days
  for (const m of lower.matchAll(/(\d+|[a-z]+)[- ](week|month)s?\b/g)) {
    const v = /^\d+$/.test(m[1]!) ? Number(m[1]) : m[1] === 'a' || m[1] === 'an' ? 1 : UNITS[m[1]!];
    if (v) out.add(v * (m[2] === 'week' ? 7 : 30));
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------------------------
// Reader 1: deterministic patterns (common phrasings)
// ---------------------------------------------------------------------------------------------
const WINDOW_OF_EVENT =
  /\bwithin\s+(\d{1,3})\s*[- ]?\s*days?\s+(?:of|from|after)\s+(?:the\s+|your\s+)?(delivery|deliver\w*|receiv\w*|order\w*|purchase)/i;
const WINDOW_NAMED = /\b(\d{1,3})[- ]day\s+(?:return|refund|exchange)?\s*(?:window|period)\b/i;
const REPORT_WITHIN = /\b(?:within|in)\s+(\d{1,3})\s*(hours?|days?)\b/i;
const FREE_OVER =
  /\b(?:free|complimentary)\b[^.]*?\b(?:over|above|exceeding)\s*\$\s?(\d+(?:\.\d+)?)/i;
const BUSINESS_DAYS = /\b(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+business\s+days\b/i;
const PHOTO = /\bphoto(?:graph)?s?\b|\bpictures?\b/i;
const DISCRETION =
  /\b(?:case[- ]by[- ]case|individually|exceptional (?:cases|circumstances)|on a case basis)\b/i;

export function patternFigures(category: KbCategory, content: string): FoundFigures {
  const f: FoundFigures = {};
  switch (category) {
    case 'return_policy':
    case 'refund_policy': {
      const m = WINDOW_OF_EVENT.exec(content);
      const named = m ? null : WINDOW_NAMED.exec(content);
      if (m || named) f.window_days = Number((m ?? named)![1]);
      if (m) f.window_anchor = /^(order|purchase)/i.test(m[2]!) ? 'order' : 'delivery';
      f.discretionary_review = DISCRETION.test(content);
      break;
    }
    case 'damaged_products': {
      const m = REPORT_WITHIN.exec(content);
      if (m)
        f.report_within_days = /^hour/i.test(m[2]!) ? Math.ceil(Number(m[1]) / 24) : Number(m[1]);
      f.requires_photo = PHOTO.test(content);
      f.discretionary_review = DISCRETION.test(content);
      break;
    }
    case 'shipping_policy': {
      const t = FREE_OVER.exec(content);
      if (t) f.free_shipping_threshold = Number(t[1]);
      const d = BUSINESS_DAYS.exec(content);
      if (d) f.delivery_business_days = [Number(d[1]), Number(d[2])];
      break;
    }
    case 'cancellation_policy': {
      if (
        /\bprocessing\s+or\s+shipped\b|\bhanded\s+(?:over\s+)?to\s+the\s+carrier\b/i.test(content)
      )
        f.cancellable_until = 'shipped';
      else if (/\bprocessing\b/i.test(content)) f.cancellable_until = 'processing';
      break;
    }
    default:
      break;
  }
  return f;
}

// ---------------------------------------------------------------------------------------------
// Reader 2: the model's answer, verified against the text
// ---------------------------------------------------------------------------------------------
/**
 * Keeps only the model's figures that the policy text actually supports: the number must occur in the text and the
 * quoted evidence must be a verbatim excerpt that contains that number. Anything else is discarded.
 */
export function validateFigures(
  category: KbCategory,
  content: string,
  f: PolicyFigures,
): FoundFigures {
  const text = norm(content);
  const numbers = numbersIn(content);
  const quoted = (quote: string | null, ...values: number[]) => {
    if (!quote) return false;
    const q = norm(quote);
    if (q.length < 3 || !text.includes(q)) return false;
    const inQuote = numbersIn(quote);
    return values.every((v) => inQuote.has(v));
  };
  const out: FoundFigures = {};

  switch (category) {
    case 'return_policy':
    case 'refund_policy': {
      // a window of N days may be written as weeks, so check the quote only for digits/words of the same value
      if (
        f.window_days &&
        f.window_days > 0 &&
        numbers.has(f.window_days) &&
        quoted(f.window_quote, f.window_days)
      ) {
        out.window_days = f.window_days;
        if (f.window_anchor) out.window_anchor = f.window_anchor;
      }
      out.discretionary_review = f.discretionary_review;
      break;
    }
    case 'damaged_products': {
      if (
        f.report_within &&
        f.report_unit &&
        numbers.has(f.report_within) &&
        quoted(f.report_quote, f.report_within)
      ) {
        out.report_within_days =
          f.report_unit === 'hours' ? Math.ceil(f.report_within / 24) : f.report_within;
      }
      out.requires_photo = f.requires_photo && /photo|picture|image|evidence|proof/i.test(content);
      out.discretionary_review = f.discretionary_review;
      break;
    }
    case 'shipping_policy': {
      if (
        f.free_shipping_threshold !== null &&
        numbers.has(f.free_shipping_threshold) &&
        quoted(f.threshold_quote, f.free_shipping_threshold)
      )
        out.free_shipping_threshold = f.free_shipping_threshold;
      if (
        f.delivery_days_min &&
        f.delivery_days_max &&
        f.delivery_days_min <= f.delivery_days_max &&
        quoted(f.delivery_quote, f.delivery_days_min, f.delivery_days_max)
      )
        out.delivery_business_days = [f.delivery_days_min, f.delivery_days_max];
      break;
    }
    case 'cancellation_policy': {
      // the quote must be a verbatim excerpt of the policy; the model's reading of it is then trusted
      if (
        f.cancellable_until !== null &&
        f.cancel_quote &&
        text.includes(norm(f.cancel_quote)) &&
        norm(f.cancel_quote).length >= 3
      )
        out.cancellable_until = f.cancellable_until;
      break;
    }
    default:
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Merge and apply
// ---------------------------------------------------------------------------------------------
/**
 * @param modelFigures the model's reading of the text, or null when no model was available / it failed. A verified
 *   model figure wins over the pattern reader; the pattern reader fills whatever the model did not confirm.
 */
export function deriveConditions(
  category: KbCategory,
  content: string,
  existing: PolicyConditions | null | undefined,
  modelFigures?: PolicyFigures | null,
): DerivedConditions {
  const before: PolicyConditions = { ...(existing ?? {}) };
  const next: PolicyConditions = { ...before };
  const changes: string[] = [];
  const warnings: string[] = [];

  const pattern = patternFigures(category, content);
  const model = modelFigures ? validateFigures(category, content, modelFigures) : null;
  // yes/no flags: the model decides when it answered (it understands "no photo is needed"); otherwise patterns
  const found: FoundFigures = { ...pattern, ...stripUndefined(model ?? {}) };

  const setNumber = (
    key: 'window_days' | 'report_within_days' | 'free_shipping_threshold',
    value: number | undefined,
    label: string,
    unit: string,
  ) => {
    if (value === undefined) {
      if (before[key] !== undefined)
        warnings.push(
          `${label}: the text no longer states a clear figure, so the previous value (${before[key]}${unit}) was kept`,
        );
      return;
    }
    if (before[key] !== value)
      changes.push(
        `${label}: ${before[key] === undefined ? 'not set' : before[key] + unit} → ${value}${unit}`,
      );
    next[key] = value;
  };
  const setFlag = (key: 'requires_photo' | 'discretionary_review', on: boolean, label: string) => {
    if (Boolean(before[key]) !== on) changes.push(`${label}: ${on ? 'yes' : 'no'}`);
    if (on) next[key] = true;
    else delete next[key];
  };

  switch (category) {
    case 'return_policy':
    case 'refund_policy': {
      setNumber('window_days', found.window_days, 'Return/refund window', ' days');
      if (found.window_days !== undefined) {
        const anchor = found.window_anchor ?? before.window_anchor ?? 'delivery';
        if (before.window_anchor !== undefined && before.window_anchor !== anchor)
          changes.push(`Window counted from: ${before.window_anchor} → ${anchor}`);
        next.window_anchor = anchor;
      }
      setFlag(
        'discretionary_review',
        Boolean(found.discretionary_review),
        'Exceptions may be reviewed',
      );
      break;
    }
    case 'damaged_products': {
      setNumber('report_within_days', found.report_within_days, 'Damage report window', ' days');
      setFlag('requires_photo', Boolean(found.requires_photo), 'Photo evidence required');
      setFlag(
        'discretionary_review',
        Boolean(found.discretionary_review),
        'Exceptions may be reviewed',
      );
      break;
    }
    case 'shipping_policy': {
      setNumber(
        'free_shipping_threshold',
        found.free_shipping_threshold,
        'Free shipping threshold',
        '',
      );
      const range = found.delivery_business_days;
      if (range) {
        if (before.delivery_business_days?.join('-') !== range.join('-'))
          changes.push(
            `Delivery time: ${before.delivery_business_days?.join('-') ?? 'not set'} → ${range.join('-')} business days`,
          );
        next.delivery_business_days = range;
      } else if (before.delivery_business_days) {
        warnings.push(
          'Delivery time: the text no longer states a clear range, so the previous value was kept',
        );
      }
      break;
    }
    case 'cancellation_policy': {
      const until = found.cancellable_until;
      if (until === undefined) {
        if (before.cancellable_until)
          warnings.push(
            `Cancellation cut-off: the text no longer states it, so the previous value (${before.cancellable_until}) was kept`,
          );
      } else {
        if (before.cancellable_until !== until)
          changes.push(
            `Cancellation allowed until: ${before.cancellable_until ?? 'not set'} → ${until}`,
          );
        next.cancellable_until = until;
      }
      break;
    }
    default:
      return { conditions: existing ?? null, changes, warnings };
  }
  return { conditions: Object.keys(next).length > 0 ? next : null, changes, warnings };
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
