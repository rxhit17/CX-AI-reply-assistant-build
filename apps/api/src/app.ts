import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import type { Env } from './env.js';

export interface ReadinessCheck {
  name: string;
  check: () => Promise<void>;
}

export interface AppOptions {
  env: Env;
  readiness?: ReadinessCheck[];
}

export async function buildApp({ env, readiness = [] }: AppOptions): Promise<FastifyInstance> {
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
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });

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

  return app;
}
