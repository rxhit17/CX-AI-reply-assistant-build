/**
 * Reads the text of one string field out of a JSON document that is still being streamed
 * (`{"reply_body":"Hello wor` -> `Hello wor`). Returns what has arrived so far, or null before the field starts.
 * Only used for the live preview; the final value always comes from parsing the complete document.
 */
export function partialJsonString(partial: string, field: string): string | null {
  const key = `"${field}"`;
  const at = partial.indexOf(key);
  if (at < 0) return null;
  let i = at + key.length;
  while (i < partial.length && /\s/.test(partial[i]!)) i++;
  if (partial[i] !== ':') return null;
  i++;
  while (i < partial.length && /\s/.test(partial[i]!)) i++;
  if (partial[i] !== '"') return null;
  i++;

  let out = '';
  while (i < partial.length) {
    const ch = partial[i]!;
    if (ch === '"') return out; // closing quote: the field is complete
    if (ch !== '\\') {
      out += ch;
      i++;
      continue;
    }
    const next = partial[i + 1];
    if (next === undefined) break; // escape sequence cut off mid-way
    if (next === 'u') {
      const hex = partial.slice(i + 2, i + 6);
      if (hex.length < 4) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 6;
      continue;
    }
    const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
    out += simple[next] ?? next;
    i += 2;
  }
  return out;
}
