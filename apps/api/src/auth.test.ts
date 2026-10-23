import { describe, expect, it } from 'vitest';
import { assertAdmin, assertBrandAccess, bearerToken, canAccessBrand } from './auth.js';
import { HttpError } from './errors.js';

describe('bearerToken', () => {
  it('extracts the token', () => expect(bearerToken('Bearer abc.def')).toBe('abc.def'));
  it('is case-insensitive on the scheme', () => expect(bearerToken('bearer xyz')).toBe('xyz'));
  it.each([undefined, '', 'Basic abc', 'Bearer', 'Bearer a b'])('rejects %s', (h) =>
    expect(bearerToken(h as string | undefined)).toBeNull(),
  );
});

describe('brand access', () => {
  const user = { brandIds: ['a'] };
  it('allows own brand', () => expect(canAccessBrand(user, 'a')).toBe(true));
  it('denies other brands', () => expect(canAccessBrand(user, 'b')).toBe(false));
  it('reports other-brand resources as not found, not forbidden', () => {
    try {
      assertBrandAccess(user, 'b', 'Conversation');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).statusCode).toBe(404);
    }
  });
  it('denies a missing brand id', () => expect(() => assertBrandAccess(user, null)).toThrow());
});

describe('assertAdmin', () => {
  it('rejects agents with 403', () => {
    try {
      assertAdmin({ role: 'agent' });
      expect.unreachable();
    } catch (e) {
      expect((e as HttpError).statusCode).toBe(403);
    }
  });
  it('allows admins', () => expect(() => assertAdmin({ role: 'admin' })).not.toThrow());
});
