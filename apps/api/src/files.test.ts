import { describe, expect, it } from 'vitest';
import { sniffImageMime, validateImage } from './files.js';

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const gif = Uint8Array.from(Buffer.from('GIF89a....'));
const webp = Uint8Array.from(Buffer.from('RIFF\0\0\0\0WEBPVP8 '));

describe('sniffImageMime', () => {
  it('detects supported formats from magic bytes', () => {
    expect(sniffImageMime(png)).toBe('image/png');
    expect(sniffImageMime(jpeg)).toBe('image/jpeg');
    expect(sniffImageMime(gif)).toBe('image/gif');
    expect(sniffImageMime(webp)).toBe('image/webp');
  });
  it('rejects non-images', () => {
    expect(sniffImageMime(Buffer.from('<svg onload=alert(1)>'))).toBeNull();
    expect(sniffImageMime(Buffer.from('%PDF-1.7 ....'))).toBeNull();
    expect(sniffImageMime(new Uint8Array())).toBeNull();
  });
});

describe('validateImage', () => {
  it('accepts a matching declared type', () => {
    expect(validateImage(png, 'image/png')).toEqual({ ok: true, mime: 'image/png' });
  });
  it('rejects spoofed content types', () => {
    const r = validateImage(Buffer.from('<script>alert(1)</script>'), 'image/png');
    expect(r.ok).toBe(false);
  });
  it('rejects a declared type that disagrees with the content', () => {
    expect(validateImage(jpeg, 'image/png').ok).toBe(false);
  });
  it('rejects disallowed declared types such as SVG', () => {
    expect(validateImage(png, 'image/svg+xml').ok).toBe(false);
  });
  it('rejects empty and oversized files', () => {
    expect(validateImage(new Uint8Array(), 'image/png').ok).toBe(false);
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(png);
    expect(validateImage(big, 'image/png')).toEqual({
      ok: false,
      reason: 'File exceeds the 5 MB limit',
    });
  });
  it('accepts a file of exactly 5 MB', () => {
    const exact = new Uint8Array(5 * 1024 * 1024);
    exact.set(png);
    expect(validateImage(exact, 'image/png').ok).toBe(true);
  });
});
