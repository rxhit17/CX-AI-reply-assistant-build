import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { draftEditSchema, generateRequestSchema, sendDraftRequestSchema } from '@cx/shared';
import type { Deps } from '../deps.js';
import { badRequest } from '../errors.js';
import {
  approveDraft,
  createAiRuntime,
  discardDraft,
  editDraft,
  generateDraft,
  getDraft,
  getLog,
  latestDraftForConversation,
  listLogs,
  sendDraft,
} from '../services/ai.js';

const idParam = z.object({ id: z.string().uuid() });
const logQuery = z.object({
  brand_id: z.string().uuid().optional(),
  status: z
    .enum(['draft', 'edited', 'approved', 'sent', 'discarded', 'superseded', 'withheld', 'failed'])
    .optional(),
  agent_id: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function aiRoutes(app: FastifyInstance, deps: Deps) {
  const ctx = { ...deps, runtime: createAiRuntime(deps) };

  // Brand, customer, order and history are loaded server-side from the conversation id alone.
  app.post('/ai/generate', async (req, reply) => {
    const body = generateRequestSchema.parse(req.body);
    return reply.status(201).send(await generateDraft(ctx, req.user, body));
  });

  app.post('/ai/regenerate', async (req, reply) => {
    const body = generateRequestSchema.parse(req.body);
    if (!body.options?.regenerate_of)
      throw badRequest('options.regenerate_of is required', 'MISSING_REGENERATE_OF');
    return reply.status(201).send(await generateDraft(ctx, req.user, body));
  });

  app.get('/conversations/:id/draft', async (req) => {
    const { id } = idParam.parse(req.params);
    return (
      (await latestDraftForConversation(ctx, req.user, id)) ?? {
        draft: null,
        sources: [],
        stale_sources: [],
      }
    );
  });

  app.get('/ai/drafts/:id', async (req) => getDraft(ctx, req.user, idParam.parse(req.params).id));

  app.patch('/ai/drafts/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const { body } = draftEditSchema.parse(req.body);
    return editDraft(ctx, req.user, id, body);
  });

  app.post('/ai/drafts/:id/approve', async (req) =>
    approveDraft(ctx, req.user, idParam.parse(req.params).id),
  );

  app.post('/ai/drafts/:id/send', async (req) => {
    const { id } = idParam.parse(req.params);
    const { idempotency_key } = sendDraftRequestSchema.parse(req.body);
    return sendDraft(ctx, req.user, id, idempotency_key);
  });

  app.post('/ai/drafts/:id/discard', async (req) =>
    discardDraft(ctx, req.user, idParam.parse(req.params).id),
  );

  app.get('/ai/logs', async (req) => ({
    logs: await listLogs(ctx, req.user, logQuery.parse(req.query)),
  }));
  app.get('/ai/logs/:id', async (req) => getLog(ctx, req.user, idParam.parse(req.params).id));
}
