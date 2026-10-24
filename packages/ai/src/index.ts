export * from './config.js';
export * from './embeddings.js';
export * from './retrieval.js';
export * from './policy/dates.js';
export * from './guardrails.js';
export * from './policy/rules.js';
export * from './policy/intent.js';
export * from './ports.js';
export * from './tools.js';
export * from './llm/types.js';
export * from './llm/openai.js';
export * from './llm/mock.js';
export * from './graph/build.js';
export * from './graph/state.js';
export * from './graph/assemble.js';

import type { AiConfig } from './config.js';
import { createMockLlm } from './llm/mock.js';
import { createOpenAiLlm } from './llm/openai.js';
import type { LlmPort } from './llm/types.js';

/** The mock is only returned when explicitly configured (tests/CI); production paths use the real model. */
export function createLlm(config: AiConfig): LlmPort {
  return config.llmMode === 'mock' ? createMockLlm() : createOpenAiLlm(config);
}
export * from './eval/checks.js';
