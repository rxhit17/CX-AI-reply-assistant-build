import { ALLOWED_IMAGE_MIME, MAX_IMAGE_BYTES } from '@cx/shared';

export type ImageMime = (typeof ALLOWED_IMAGE_MIME)[number];

/** Detects the real image type from magic bytes; the client-declared MIME type is never trusted. */
export function sniffImageMime(buf: Uint8Array): ImageMime | null {
  const at = (i: number) => buf[i];
  if (
    buf.length >= 8 &&
    at(0) === 0x89 &&
    at(1) === 0x50 &&
    at(2) === 0x4e &&
    at(3) === 0x47 &&
    at(4) === 0x0d &&
    at(5) === 0x0a &&
    at(6) === 0x1a &&
    at(7) === 0x0a
  ) {
    return 'image/png';
  }
  if (buf.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (buf.length >= 6) {
    const head = String.fromCharCode(...buf.subarray(0, 6));
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  if (buf.length >= 12) {
    const riff = String.fromCharCode(...buf.subarray(0, 4));
    const webp = String.fromCharCode(...buf.subarray(8, 12));
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
  }
  return null;
}

export const EXTENSION: Record<ImageMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export type ImageCheck = { ok: true; mime: ImageMime } | { ok: false; reason: string };

export function validateImage(buf: Uint8Array, declaredMime: string): ImageCheck {
  if (buf.length === 0) return { ok: false, reason: 'File is empty' };
  if (buf.length > MAX_IMAGE_BYTES) return { ok: false, reason: 'File exceeds the 5 MB limit' };
  if (!(ALLOWED_IMAGE_MIME as readonly string[]).includes(declaredMime)) {
    return { ok: false, reason: 'Only PNG, JPEG, WebP and GIF images are allowed' };
  }
  const real = sniffImageMime(buf);
  if (!real) return { ok: false, reason: 'File content is not a supported image' };
  if (real !== declaredMime)
    return { ok: false, reason: 'File content does not match its declared type' };
  return { ok: true, mime: real };
}
