import type { KbCategory, RetrievedKb } from '@cx/shared';
import type { RetrievalThresholds } from './config.js';
import type { EmbeddingService } from './embeddings.js';

/**
 * Persistence port. The implementation MUST restrict results to `brandId` (the SQL function does);
 * this module never filters by brand itself because isolation has to hold at the data-access boundary.
 */
export interface KbSearchPort {
  search(params: {
    brandId: string;
    queryText: string;
    queryEmbedding: number[] | null;
    categories: KbCategory[] | null;
    topK: number;
    minVectorSimilarity: number;
  }): Promise<RetrievedKb[]>;
}

export interface RetrievalResult {
  entries: RetrievedKb[];
  /** Entries that cleared the relevance thresholds (subset of `entries`, same order). */
  relevant: RetrievedKb[];
  sufficient: boolean;
  mode: 'hybrid' | 'keyword';
  reason: string;
  embeddingError?: string;
}

/**
 * Decides whether a candidate counts as evidence.
 * - hybrid mode (embeddings available): vector similarity must clear the absolute threshold AND be within
 *   within relativeMargin of the best match. Keyword hits only influence ranking: calibration showed
 *   stray word overlap makes unanswerable questions look answerable.
 * - keyword mode (embeddings unavailable): a keyword hit with a fused score above the threshold.
 */
export function isRelevant(
  entry: RetrievedKb,
  t: RetrievalThresholds,
  bestVector: number | null,
  mode: 'hybrid' | 'keyword' = 'hybrid',
): boolean {
  if (mode === 'keyword') {
    return (
      entry.text_score !== null && entry.text_score > 0 && entry.fused_score >= t.minFusedScore
    );
  }
  if (entry.vector_score === null || entry.vector_score < t.minVectorSimilarity) return false;
  return bestVector === null || entry.vector_score >= bestVector - t.relativeMargin;
}

export function bestVectorScore(entries: RetrievedKb[]): number | null {
  const scores = entries.map((e) => e.vector_score).filter((s): s is number => s !== null);
  return scores.length ? Math.max(...scores) : null;
}

export async function retrieveBrandKnowledge(
  deps: {
    search: KbSearchPort;
    embeddings: EmbeddingService | null;
    thresholds: RetrievalThresholds;
  },
  params: { brandId: string; query: string; categories?: KbCategory[] | null },
): Promise<RetrievalResult> {
  const { search, embeddings, thresholds } = deps;
  const query = params.query.trim();
  if (!query) {
    return {
      entries: [],
      relevant: [],
      sufficient: false,
      mode: 'keyword',
      reason: 'Empty search query',
    };
  }

  let queryEmbedding: number[] | null = null;
  let embeddingError: string | undefined;
  if (embeddings) {
    try {
      queryEmbedding = await embeddings.embedQuery(query);
    } catch (err) {
      // Embeddings unavailable: degrade to keyword retrieval rather than failing the request.
      embeddingError = err instanceof Error ? err.message : String(err);
    }
  }

  const entries = await search.search({
    brandId: params.brandId,
    queryText: query,
    queryEmbedding,
    categories: params.categories ?? null,
    // Fetch a wider candidate set than we will use: keyword-boosted rows can outrank the semantically best
    // match in fused order, and relevance is decided after the fact (see isRelevant).
    topK: Math.max(thresholds.topK * 3, 15),
    // Candidates below the threshold are dropped in SQL; keyword hits are still returned alongside.
    minVectorSimilarity: queryEmbedding ? Math.min(thresholds.minVectorSimilarity, 0.2) : 0,
  });

  const best = bestVectorScore(entries);
  const mode = queryEmbedding ? 'hybrid' : 'keyword';
  const relevant = entries
    .filter((e) => isRelevant(e, thresholds, best, mode))
    // primary evidence first: semantic similarity in hybrid mode, fused rank (already ordered) in keyword mode
    .sort((a, b) => (mode === 'hybrid' ? (b.vector_score ?? 0) - (a.vector_score ?? 0) : 0))
    .slice(0, thresholds.topK);
  return {
    entries: entries.slice(0, Math.max(thresholds.topK, relevant.length)),
    relevant,
    sufficient: relevant.length > 0,
    mode,
    embeddingError,
    reason:
      relevant.length > 0
        ? `${relevant.length} relevant knowledge entr${relevant.length === 1 ? 'y' : 'ies'} found (${mode})`
        : entries.length > 0
          ? 'Candidates found but none met the relevance thresholds'
          : 'No knowledge base entries matched',
  };
}
