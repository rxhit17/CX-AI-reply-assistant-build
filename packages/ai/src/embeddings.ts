import { createHash } from 'node:crypto';
import { OpenAIEmbeddings } from '@langchain/openai';
import type { AiConfig } from './config.js';

export interface EmbeddingService {
  readonly model: string;
  readonly dimensions: number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

/** Text that represents a KB entry in the vector index. */
export function kbEmbeddingText(entry: {
  title: string;
  category: string;
  content: string;
}): string {
  return `${entry.title}\n${entry.category.replace(/_/g, ' ')}\n${entry.content}`;
}

class OpenAiEmbeddingService implements EmbeddingService {
  private readonly client: OpenAIEmbeddings;
  constructor(
    readonly model: string,
    readonly dimensions: number,
    apiKey: string,
    timeoutMs: number,
  ) {
    this.client = new OpenAIEmbeddings({
      model,
      dimensions,
      apiKey,
      timeout: timeoutMs,
      maxRetries: 2,
    });
  }
  embedDocuments(texts: string[]) {
    return this.client.embedDocuments(texts);
  }
  embedQuery(text: string) {
    return this.client.embedQuery(text);
  }
}

/**
 * Deterministic bag-of-words hashing embedding. TEST/CI ONLY (LLM_MODE=mock): it gives repeatable vectors in
 * which texts sharing words are close, so retrieval plumbing can be tested without network access.
 */
export class MockEmbeddingService implements EmbeddingService {
  readonly model = 'mock-hash-embedding';
  constructor(readonly dimensions: number) {}
  private vector(text: string): number[] {
    const v = new Array<number>(this.dimensions).fill(0);
    for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      const h = createHash('sha1').update(word).digest();
      v[h.readUInt16BE(0) % this.dimensions]! += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
  async embedDocuments(texts: string[]) {
    return texts.map((t) => this.vector(t));
  }
  async embedQuery(text: string) {
    return this.vector(text);
  }
}

export function createEmbeddingService(config: AiConfig): EmbeddingService {
  if (config.llmMode === 'mock') return new MockEmbeddingService(config.embeddingDimensions);
  if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY is required for embeddings');
  return new OpenAiEmbeddingService(
    config.embeddingModel,
    config.embeddingDimensions,
    config.openaiApiKey,
    config.timeoutMs,
  );
}
