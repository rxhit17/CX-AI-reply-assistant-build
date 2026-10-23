const MS_PER_DAY = 86_400_000;

/** Whole calendar days elapsed from `from` to `to` (UTC calendar days; negative if `to` is earlier). */
export function daysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / MS_PER_DAY);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

function isWeekend(d: Date): boolean {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

/** Adds business days (Mon–Fri, UTC), skipping weekends and any ISO dates (YYYY-MM-DD) in `holidays`. */
export function addBusinessDays(start: Date, businessDays: number, holidays: string[] = []): Date {
  if (!Number.isInteger(businessDays) || businessDays < 0) {
    throw new RangeError('businessDays must be a non-negative integer');
  }
  const skip = new Set(holidays);
  let cursor = new Date(start.getTime());
  let remaining = businessDays;
  while (remaining > 0) {
    cursor = addDays(cursor, 1);
    if (!isWeekend(cursor) && !skip.has(cursor.toISOString().slice(0, 10))) remaining -= 1;
  }
  return cursor;
}
