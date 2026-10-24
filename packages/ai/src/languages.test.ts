import { describe, expect, it } from 'vitest';
import { normalizeLanguage, pickReplyLanguage } from './languages.js';

describe('normalizeLanguage', () => {
  it('maps Hindi in any form to hinglish', () => {
    for (const c of ['hi', 'HI', 'hi-IN', 'hi_Latn', 'hindi', 'hinglish'])
      expect(normalizeLanguage(c)).toBe('hinglish');
  });
  it('keeps the base language of other codes and defaults to English', () => {
    expect(normalizeLanguage('es-MX')).toBe('es');
    expect(normalizeLanguage('en-US')).toBe('en');
    expect(normalizeLanguage('fr')).toBe('fr');
    expect(normalizeLanguage('')).toBe('en');
    expect(normalizeLanguage(null)).toBe('en');
  });
});

describe('pickReplyLanguage', () => {
  const brand = ['en', 'hinglish'];
  it('replies in the customer language when the brand supports it', () => {
    expect(pickReplyLanguage('hinglish', brand)).toBe('hinglish');
  });
  it('Hindi speakers (ISO "hi", e.g. Devanagari input) get Hinglish', () => {
    expect(pickReplyLanguage('hi', brand)).toBe('hinglish');
  });
  it('Spanish and French are not supported: the reply is English', () => {
    expect(pickReplyLanguage('fr', brand)).toBe('en');
    expect(pickReplyLanguage('es', brand)).toBe('en');
  });
  it('a stale stored setting cannot re-enable French', () => {
    expect(pickReplyLanguage('fr', ['en', 'fr', 'es'])).toBe('en');
    expect(pickReplyLanguage('hinglish', ['en', 'hi', 'fr'])).toBe('hinglish'); // legacy "hi" still maps to Hinglish
  });
  it('falls back to English when the brand does not list the language', () => {
    expect(pickReplyLanguage('hinglish', ['en'])).toBe('en');
  });
});
