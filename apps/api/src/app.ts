import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { authenticate } from './auth.js';
import type { Deps } from './deps.js';
import type { Env } from './env.js';
import type { EmbeddingService } from '@cx/ai';
import { toAiConfig } from './ai-config.js';
import { aiRoutes } from './routes/ai.js';
import { brandRoutes } from './routes/brands.js';
import { conversationRoutes } from './routes/conversations.js';
import { knowledgeBaseRoutes } from './routes/knowledge-base.js';

export interface ReadinessCheck {
  name: string;
  check: () => Promise<void>;
}

export interface AppOptions {
  env: Env;
  /** Privileged database client; when omitted only the system routes are served. */
  db?: Deps['db'];
  embeddings?: EmbeddingService | null;
  readiness?: ReadinessCheck[];
}

export async function buildApp({
  env,
  db,
  embeddings = null,
  readiness = [],
}: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // never log credentials or session tokens
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    requestTimeout: env.REQUEST_TIMEOUT_MS,
    bodyLimit: 1024 * 1024,
  });

  await app.register(cors, {
    origin: env.CORS_ORIGINS,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: false,
  });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    // authenticated traffic is limited per account, anonymous traffic per IP
    keyGenerator: (req) => req.headers.authorization?.slice(-24) ?? req.ip,
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: err.issues },
      });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    const status = e.statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    return reply.status(status).send({
      error: {
        code: e.code ?? (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
        message: status >= 500 ? 'Internal server error' : (e.message ?? 'Request error'),
      },
    });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async (_req, reply) => {
    const results = await Promise.all(
      readiness.map(async ({ name, check }) => {
        try {
          await check();
          return { name, ok: true };
        } catch {
          return { name, ok: false };
        }
      }),
    );
    const ok = results.every((r) => r.ok);
    return reply
      .status(ok ? 200 : 503)
      .send({ status: ok ? 'ready' : 'not_ready', checks: results });
  });

  if (db) {
    const deps: Deps = { env, db, aiConfig: toAiConfig(env), embeddings };
    await app.register(
      async (api) => {
        api.addHook('onRequest', async (req) => {
          req.user = await authenticate(req, db);
        });
        await api.register(brandRoutes, deps);
        await api.register(conversationRoutes, deps);
        await api.register(knowledgeBaseRoutes, deps);
        await api.register(aiRoutes, deps);
      },
      { prefix: '/api' },
    );
  }

  return app;
}
