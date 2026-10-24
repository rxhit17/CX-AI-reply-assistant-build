import type { KbCategory, PolicyConditions } from '@cx/shared';

/**
 * Keeps the structured numbers that drive the deterministic eligibility rules in step with the wording of a policy.
 * An admin edits the policy text only; on save the figures are read back out of it:
 *
 *   return / refund      "within 30 days of delivery"            -> window_days, window_anchor
 *   damaged products     "report it within 48 hours" / "14 days" -> report_within_days, requires_photo
 *   shipping             "free on orders over $50", "3-5 business days" -> free_shipping_threshold, delivery_business_days
 *   cancellation         "only while ... Processing"             -> cancellable_until
 *   refund / damaged     "case by case", "reviewed individually" -> discretionary_review
 *
 * A figure that is simply not found keeps its previous value and is reported as a warning (the admin may have
 * reworded the sentence); a yes/no flag that is no longer stated is switched off. Categories with no structured
 * figures (FAQ, warranty, ...) are returned untouched.
 */
export interface DerivedConditions {
  conditions: PolicyConditions | null;
  /** Human-readable list of what changed, e.g. "Return/refund window: 7 → 30 days". */
  changes: string[];
  /** Figures the text no longer states clearly; the previous value was kept. */
  warnings: string[];
}

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

export function deriveConditions(
  category: KbCategory,
  content: string,
  existing: PolicyConditions | null | undefined,
): DerivedConditions {
  const before: PolicyConditions = { ...(existing ?? {}) };
  const next: PolicyConditions = { ...before };
  const changes: string[] = [];
  const warnings: string[] = [];

  const setNumber = (
    key: 'window_days' | 'report_within_days' | 'free_shipping_threshold',
    found: number | null,
    label: string,
    unit: string,
  ) => {
    if (found === null) {
      if (before[key] !== undefined)
        warnings.push(
          `${label}: the text no longer states a clear figure, so the previous value (${before[key]}${unit}) was kept`,
        );
      return;
    }
    if (before[key] !== found) {
      changes.push(
        `${label}: ${before[key] === undefined ? 'not set' : before[key] + unit} → ${found}${unit}`,
      );
    }
    next[key] = found;
  };
  const setFlag = (key: 'requires_photo' | 'discretionary_review', on: boolean, label: string) => {
    if (Boolean(before[key]) !== on) changes.push(`${label}: ${on ? 'yes' : 'no'}`);
    if (on) next[key] = true;
    else delete next[key];
  };

  switch (category) {
    case 'return_policy':
    case 'refund_policy': {
      const m = WINDOW_OF_EVENT.exec(content);
      const named = m ? null : WINDOW_NAMED.exec(content);
      const days = m ? Number(m[1]) : named ? Number(named[1]) : null;
      setNumber('window_days', days, 'Return/refund window', ' days');
      if (days !== null) {
        const anchor = m
          ? /^(order|purchase)/i.test(m[2]!)
            ? 'order'
            : 'delivery'
          : (before.window_anchor ?? 'delivery');
        if (before.window_anchor !== anchor && before.window_anchor !== undefined)
          changes.push(`Window counted from: ${before.window_anchor} → ${anchor}`);
        next.window_anchor = anchor;
      }
      setFlag('discretionary_review', DISCRETION.test(content), 'Exceptions may be reviewed');
      break;
    }
    case 'damaged_products': {
      const m = REPORT_WITHIN.exec(content);
      const days = m ? (/^hour/i.test(m[2]!) ? Math.ceil(Number(m[1]) / 24) : Number(m[1])) : null;
      setNumber('report_within_days', days, 'Damage report window', ' days');
      setFlag('requires_photo', PHOTO.test(content), 'Photo evidence required');
      setFlag('discretionary_review', DISCRETION.test(content), 'Exceptions may be reviewed');
      break;
    }
    case 'shipping_policy': {
      const f = FREE_OVER.exec(content);
      setNumber('free_shipping_threshold', f ? Number(f[1]) : null, 'Free shipping threshold', '');
      const d = BUSINESS_DAYS.exec(content);
      if (d) {
        const range: [number, number] = [Number(d[1]), Number(d[2])];
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
      const until =
        /\bprocessing\s+or\s+shipped\b|\bhanded\s+(?:over\s+)?to\s+the\s+carrier\b/i.test(content)
          ? 'shipped'
          : /\bprocessing\b/i.test(content)
            ? 'processing'
            : null;
      if (until === null) {
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
