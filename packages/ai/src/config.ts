export interface AiConfig {
  llmMode: 'openai' | 'mock';
  openaiApiKey?: string;
  chatModel: string;
  visionModel: string;
  embeddingModel: string;
  embeddingDimensions: number;
  retrieval: RetrievalThresholds;
  /** Per-call network timeout for model requests. */
  timeoutMs: number;
}

export interface RetrievalThresholds {
  /** Minimum cosine similarity for a vector match to count as relevant evidence. */
  minVectorSimilarity: number;
  /** Minimum fused (RRF) score for a keyword-only match to count as relevant evidence. */
  minFusedScore: number;
  /**
   * A vector match must also be within this distance of the best vector match for the query. Needed because
   * every entry in a small brand KB is moderately similar to any support question.
   */
  relativeMargin: number;
  topK: number;
}
