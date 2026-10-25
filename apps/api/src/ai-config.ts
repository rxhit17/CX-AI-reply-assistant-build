import type { AiConfig } from '@cx/ai';
import type { Env } from './env.js';

export function toAiConfig(env: Env): AiConfig {
  return {
    llmMode: env.LLM_MODE,
    openaiApiKey: env.OPENAI_API_KEY,
    chatModel: env.OPENAI_CHAT_MODEL,
    visionModel: env.OPENAI_VISION_MODEL,
    judgeModel: env.OPENAI_JUDGE_MODEL,
    embeddingModel: env.OPENAI_EMBEDDING_MODEL,
    embeddingDimensions: env.EMBEDDING_DIMENSIONS,
    timeoutMs: env.REQUEST_TIMEOUT_MS,
    orderGate: { enabled: env.ORDER_GATE_ENABLED, maxAttempts: env.ORDER_GATE_MAX_ATTEMPTS },
    retrieval: {
      minVectorSimilarity: env.RETRIEVAL_MIN_VECTOR_SIMILARITY,
      minFusedScore: env.RETRIEVAL_MIN_FUSED_SCORE,
      relativeMargin: env.RETRIEVAL_RELATIVE_MARGIN,
      topK: env.RETRIEVAL_TOP_K,
    },
  };
}
