import { describe, expect, it } from 'vitest';
import { partialJsonString } from './partial-json.js';

describe('partialJsonString', () => {
  it('returns null until the field has started', () => {
    expect(partialJsonString('', 'reply_body')).toBeNull();
    expect(partialJsonString('{"reply_b', 'reply_body')).toBeNull();
    expect(partialJsonString('{"reply_body":', 'reply_body')).toBeNull();
    expect(partialJsonString('{"other":"x"}', 'reply_body')).toBeNull();
  });

  it('returns the text received so far', () => {
    expect(partialJsonString('{"reply_body":"', 'reply_body')).toBe('');
    expect(partialJsonString('{"reply_body":"Hello wor', 'reply_body')).toBe('Hello wor');
    expect(partialJsonString('{ "reply_body" : "Hi', 'reply_body')).toBe('Hi');
  });

  it('stops at the closing quote and ignores later fields', () => {
    expect(
      partialJsonString('{"reply_body":"Done.","cited_source_ids":["S1"]}', 'reply_body'),
    ).toBe('Done.');
  });

  it('decodes escapes and never emits a half escape', () => {
    expect(partialJsonString('{"reply_body":"a\\nb \\"q\\" \\\\ c', 'reply_body')).toBe(
      'a\nb "q" \\ c',
    );
    expect(partialJsonString('{"reply_body":"ab\\', 'reply_body')).toBe('ab');
    expect(partialJsonString('{"reply_body":"ab\\u00', 'reply_body')).toBe('ab');
    expect(partialJsonString('{"reply_body":"caf\\u00e9', 'reply_body')).toBe('café');
  });

  it('matches what JSON.parse gives for the complete document', () => {
    const doc = JSON.stringify({ reply_body: 'Line one\nLine "two" — ok ✓', x: 1 });
    expect(partialJsonString(doc, 'reply_body')).toBe(JSON.parse(doc).reply_body);
    for (let n = 1; n < doc.length; n++) {
      const part = partialJsonString(doc.slice(0, n), 'reply_body');
      if (part !== null) expect(JSON.parse(doc).reply_body.startsWith(part)).toBe(true);
    }
  });
});
