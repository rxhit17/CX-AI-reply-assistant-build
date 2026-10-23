import { describe, expect, it, vi } from 'vitest';
import type { RetrievedKb } from '@cx/shared';
import { MockEmbeddingService } from './embeddings.js';
import { isRelevant, retrieveBrandKnowledge, type KbSearchPort } from './retrieval.js';

const thresholds = { minVectorSimilarity: 0.4, minFusedScore: 0.015, relativeMargin: 0.1, topK: 5 };
const entry = (over: Partial<RetrievedKb>): RetrievedKb => ({
  id: '11111111-1111-4111-8111-111111111111',
  title: 't',
  category: 'faq',
  version: 1,
  content: 'c',
  vector_score: null,
  text_score: null,
  fused_score: 0,
  ...over,
});

describe('isRelevant (hybrid)', () => {
  it('accepts a vector match above the threshold', () => {
    expect(isRelevant(entry({ vector_score: 0.5 }), thresholds, 0.5)).toBe(true);
  });
  it('rejects a vector match below the threshold', () => {
    expect(isRelevant(entry({ vector_score: 0.3, fused_score: 0.02 }), thresholds, 0.3)).toBe(
      false,
    );
  });
  it('ignores keyword-only evidence in hybrid mode', () => {
    expect(isRelevant(entry({ text_score: 0.5, fused_score: 0.0164 }), thresholds, null)).toBe(
      false,
    );
  });
  it('drops matches far below the best match even if above the absolute threshold', () => {
    expect(isRelevant(entry({ vector_score: 0.45 }), thresholds, 0.7)).toBe(false);
    expect(isRelevant(entry({ vector_score: 0.65 }), thresholds, 0.7)).toBe(true);
  });
});

describe('isRelevant (keyword mode)', () => {
  it('accepts a strong keyword hit', () => {
    expect(
      isRelevant(entry({ text_score: 0.2, fused_score: 0.0164 }), thresholds, null, 'keyword'),
    ).toBe(true);
  });
  it('rejects a weak keyword hit', () => {
    expect(
      isRelevant(entry({ text_score: 0.2, fused_score: 0.005 }), thresholds, null, 'keyword'),
    ).toBe(false);
  });
});

describe('retrieveBrandKnowledge', () => {
  const port = (rows: RetrievedKb[]): KbSearchPort & { search: ReturnType<typeof vi.fn> } => ({
    search: vi.fn().mockResolvedValue(rows),
  });

  it('passes the brand id to the search port and reports sufficiency', async () => {
    const p = port([entry({ vector_score: 0.7, fused_score: 0.03 })]);
    const r = await retrieveBrandKnowledge(
      { search: p, embeddings: new MockEmbeddingService(16), thresholds },
      { brandId: 'brand-a', query: 'can I return this' },
    );
    expect(p.search).toHaveBeenCalledWith(expect.objectContaining({ brandId: 'brand-a' }));
    expect(r.mode).toBe('hybrid');
    expect(r.sufficient).toBe(true);
  });

  it('orders relevant entries by semantic similarity, not fused rank, and widens the candidate fetch', async () => {
    const a = entry({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      vector_score: 0.5,
      fused_score: 0.032,
    });
    const b = entry({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      vector_score: 0.55,
      fused_score: 0.016,
    });
    const p = port([a, b]);
    const r = await retrieveBrandKnowledge(
      { search: p, embeddings: new MockEmbeddingService(16), thresholds },
      { brandId: 'b', query: 'q' },
    );
    expect(r.relevant.map((e) => e.id)).toEqual([b.id, a.id]);
    expect(p.search).toHaveBeenCalledWith(expect.objectContaining({ topK: 15 }));
  });

  it('returns an explicit insufficient result when nothing matches', async () => {
    const r = await retrieveBrandKnowledge(
      { search: port([]), embeddings: null, thresholds },
      { brandId: 'b', query: 'do you sell cars' },
    );
    expect(r.sufficient).toBe(false);
    expect(r.reason).toMatch(/No knowledge base entries/);
  });

  it('is insufficient when candidates exist but none are relevant', async () => {
    const r = await retrieveBrandKnowledge(
      {
        search: port([entry({ vector_score: 0.1, fused_score: 0.01 })]),
        embeddings: null,
        thresholds,
      },
      { brandId: 'b', query: 'x' },
    );
    expect(r.sufficient).toBe(false);
    expect(r.entries).toHaveLength(1);
    expect(r.relevant).toHaveLength(0);
  });

  it('falls back to keyword mode when the embedding call fails', async () => {
    const failing = {
      model: 'x',
      dimensions: 4,
      embedDocuments: vi.fn(),
      embedQuery: vi.fn().mockRejectedValue(new Error('quota exceeded')),
    };
    const p = port([entry({ text_score: 0.3, fused_score: 0.0164 })]);
    const r = await retrieveBrandKnowledge(
      { search: p, embeddings: failing, thresholds },
      { brandId: 'b', query: 'refund' },
    );
    expect(r.mode).toBe('keyword');
    expect(r.embeddingError).toBe('quota exceeded');
    expect(p.search).toHaveBeenCalledWith(expect.objectContaining({ queryEmbedding: null }));
    expect(r.sufficient).toBe(true);
  });

  it('short-circuits on an empty query without searching', async () => {
    const p = port([]);
    const r = await retrieveBrandKnowledge(
      { search: p, embeddings: null, thresholds },
      { brandId: 'b', query: '  ' },
    );
    expect(p.search).not.toHaveBeenCalled();
    expect(r.sufficient).toBe(false);
  });
});

describe('MockEmbeddingService', () => {
  it('is deterministic and places similar texts closer than unrelated ones', async () => {
    const m = new MockEmbeddingService(256);
    const [a, b, c] = await m.embedDocuments([
      'refund policy window',
      'refund window days',
      'ceramic planter sand',
    ]);
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(dot(a!, b!)).toBeGreaterThan(dot(a!, c!));
    expect(await m.embedQuery('refund policy window')).toEqual(a);
  });
});
