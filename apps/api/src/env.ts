import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_CHAT_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_VISION_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),
  LLM_MODE: z.enum(['openai', 'mock']).default('openai'),

  RETRIEVAL_MIN_VECTOR_SIMILARITY: z.coerce.number().min(0).max(1).default(0.3),
  RETRIEVAL_MIN_FUSED_SCORE: z.coerce.number().min(0).default(0.015),
  RETRIEVAL_TOP_K: z.coerce.number().int().min(1).max(20).default(5),

  RATE_LIMIT_AI_PER_AGENT_PER_MIN: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_AI_PER_CONVERSATION_PER_MIN: z.coerce.number().int().positive().default(5),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  LANGSMITH_TRACING: bool.default(false),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  if (env.LLM_MODE === 'openai' && env.NODE_ENV === 'production' && !env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required in production when LLM_MODE=openai');
  }
  return env;
}
