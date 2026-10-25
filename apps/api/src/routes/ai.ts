import type { OutgoingHttpHeaders } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { draftEditSchema, generateRequestSchema, sendDraftRequestSchema } from '@cx/shared';
import type { Deps } from '../deps.js';
import { badRequest, HttpError } from '../errors.js';
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

  /**
   * Same as generate/regenerate, but streamed as server-sent events so the UI can show real progress and the reply
   * text as it is written: `step` (a workflow stage started), `draft_text` (reply so far, a preview), `draft_reset`
   * (preview rejected by the safety checks, rewriting), then `done` (the saved draft) or `error`.
   * Request validation errors are ordinary JSON errors; anything after the stream opens arrives as an `error` event.
   */
  const stream = async (req: FastifyRequest, reply: FastifyReply, regenerate: boolean) => {
    const body = generateRequestSchema.parse(req.body);
    if (regenerate && !body.options?.regenerate_of)
      throw badRequest('options.regenerate_of is required', 'MISSING_REGENERATE_OF');

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      ...(reply.getHeaders() as OutgoingHttpHeaders), // keeps the CORS headers set by the plugin
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: string, data: unknown) => {
      if (!res.writableEnded && !res.destroyed)
        res.write(`event: ${event}
data: ${JSON.stringify(data)}

`);
    };
    try {
      const draft = await generateDraft(ctx, req.user, body, {
        onProgress: (e) => send(e.type, e),
      });
      send('done', draft);
    } catch (err) {
      if (err instanceof HttpError) {
        send('error', { status: err.statusCode, code: err.code, message: err.message });
      } else {
        req.log.error({ err }, 'streamed generation failed');
        send('error', {
          status: 500,
          code: 'GENERATION_FAILED',
          message: 'The reply could not be generated',
        });
      }
    } finally {
      res.end();
    }
  };
  app.post('/ai/generate/stream', (req, reply) => stream(req, reply, false));
  app.post('/ai/regenerate/stream', (req, reply) => stream(req, reply, true));

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
