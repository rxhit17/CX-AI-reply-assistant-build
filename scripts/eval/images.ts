/**
 * Synthetic test images (no external downloads). They are drawings, not photographs, so image cases measure
 * the pipeline's behaviour (use evidence, never over-claim, never re-ask) rather than vision accuracy on
 * real-world photos. Real photos should be added to the evaluation before relying on image results.
 */
import { crc32, deflateSync } from 'node:zlib';

const W = 256;
const H = 256;
type RGB = [number, number, number];

function png(pixels: Uint8Array): Buffer {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    Buffer.from(pixels.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function canvas(bg: RGB) {
  const px = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) px.set(bg, i * 3);
  const set = (x: number, y: number, c: RGB) => {
    if (x >= 0 && x < W && y >= 0 && y < H) px.set(c, (y * W + x) * 3);
  };
  const rect = (x0: number, y0: number, x1: number, y1: number, c: RGB) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y, c);
  };
  const line = (x0: number, y0: number, x1: number, y1: number, c: RGB, t = 2) => {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= n; i++) {
      const x = Math.round(x0 + ((x1 - x0) * i) / n);
      const y = Math.round(y0 + ((y1 - y0) * i) / n);
      for (let dx = -t; dx <= t; dx++) for (let dy = -t; dy <= t; dy++) set(x + dx, y + dy, c);
    }
  };
  return { px, rect, line };
}

function bottle(cracked: boolean) {
  const c = canvas([236, 232, 224]);
  c.rect(0, 220, W, H, [190, 170, 140]); // table
  c.rect(92, 100, 168, 226, [70, 150, 170]); // body
  c.rect(118, 44, 142, 100, [90, 165, 185]); // neck
  c.rect(114, 34, 146, 46, [40, 40, 40]); // cap
  c.rect(100, 112, 110, 200, [150, 210, 225]); // highlight
  if (cracked) {
    const dark: RGB = [15, 15, 15];
    c.line(118, 104, 150, 146, dark);
    c.line(150, 146, 124, 176, dark);
    c.line(124, 176, 160, 218, dark);
    c.line(150, 146, 168, 130, dark, 1);
    c.line(124, 176, 96, 190, dark, 1);
    for (const [x, y] of [[170, 226], [184, 232], [74, 232]] as const) c.rect(x, y, x + 8, y + 6, [90, 165, 185]); // shards on the table
  }
  return png(c.px);
}

function plain() {
  const c = canvas([200, 210, 230]);
  for (let y = 0; y < H; y++) c.line(0, y, W - 1, y, [200 - Math.floor(y / 4), 210 - Math.floor(y / 5), 230], 0);
  return png(c.px);
}

export const IMAGES = { cracked: bottle(true), intact: bottle(false), unrelated: plain() };
export type ImageKind = keyof typeof IMAGES;
