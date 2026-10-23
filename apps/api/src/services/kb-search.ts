import type { SupabaseClient } from '@supabase/supabase-js';
import {
  retrieveBrandKnowledge,
  type EmbeddingService,
  type KbSearchPort,
  type RetrievalResult,
} from '@cx/ai';
import type { KbCategory, RetrievedKb } from '@cx/shared';
import type { Deps } from '../deps.js';

/** Search port backed by the match_kb_hybrid SQL function, where brand isolation is enforced. */
export function createKbSearchPort(db: SupabaseClient): KbSearchPort {
  return {
    async search({ brandId, queryText, queryEmbedding, categories, topK, minVectorSimilarity }) {
      const { data, error } = await db.rpc('match_kb_hybrid', {
        p_brand_id: brandId,
        p_query_text: queryText,
        p_query_embedding: queryEmbedding ? `[${queryEmbedding.join(',')}]` : null,
        p_categories: categories,
        p_match_count: topK,
        p_min_vector_similarity: minVectorSimilarity,
      });
      if (error) throw new Error(`KB search failed: ${error.message}`);
      return (data ?? []) as RetrievedKb[];
    },
  };
}

export function retrieve(
  deps: Pick<Deps, 'db' | 'aiConfig'> & { embeddings: EmbeddingService | null },
  params: { brandId: string; query: string; categories?: KbCategory[] | null },
): Promise<RetrievalResult> {
  return retrieveBrandKnowledge(
    {
      search: createKbSearchPort(deps.db),
      embeddings: deps.embeddings,
      thresholds: deps.aiConfig.retrieval,
    },
    params,
  );
}
