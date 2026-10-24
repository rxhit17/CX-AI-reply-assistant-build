import { SUPPORTED_LANGUAGES } from '@cx/shared';

/**
 * Language handling. Supported reply languages: English and Hinglish (Hindi in Roman letters). A customer
 * who writes Hindi (in either script) gets Hinglish. Any other language, French included, is not supported and is
 * answered in English, whatever a stored brand setting says.
 */
export function normalizeLanguage(code: string | null | undefined): string {
  const c = (code ?? '').trim().toLowerCase();
  if (!c) return 'en';
  if (c === 'hinglish' || c === 'hindi' || c === 'hi' || c.startsWith('hi-') || c.startsWith('hi_'))
    return 'hinglish';
  return c.split(/[-_]/)[0] ?? 'en';
}

/** The language to reply in: the customer's if it is supported globally AND by the brand, otherwise English. */
export function pickReplyLanguage(
  customerLanguage: string | null | undefined,
  brandSupported: string[],
): string {
  const wanted = normalizeLanguage(customerLanguage);
  const allowed = new Set<string>(SUPPORTED_LANGUAGES);
  const supported = brandSupported.map(normalizeLanguage).filter((l) => allowed.has(l));
  return supported.includes(wanted) ? wanted : 'en';
}
