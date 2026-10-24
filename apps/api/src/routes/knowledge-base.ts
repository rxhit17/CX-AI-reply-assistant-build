import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { kbCategorySchema, kbEntryInputSchema, kbEntryUpdateSchema } from '@cx/shared';
import { assertBrandAccess } from '../auth.js';
import type { Deps } from '../deps.js';
import { badRequest } from '../errors.js';
import {
  archiveKbEntry,
  createKbEntry,
  listKbEntries,
  listKbVersions,
  loadKbEntry,
  reembedKbEntry,
  restoreKbEntry,
  updateKbEntry,
} from '../services/kb.js';
import { retrieve } from '../services/kb-search.js';

const idParam = z.object({ id: z.string().uuid() });
const boolish = z.enum(['true', 'false']).transform((v) => v === 'true');
const listQuery = z.object({
  brand_id: z.string().uuid().optional(),
  category: kbCategorySchema.optional(),
  q: z.string().trim().max(100).optional(),
  active: boolish.optional(),
  include_archived: boolish.optional(),
});

export async function knowledgeBaseRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/knowledge-base', async (req) => ({
    entries: await listKbEntries(deps, req.user, listQuery.parse(req.query)),
  }));

  app.get('/knowledge-base/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    return { entry: await loadKbEntry(deps, req.user, id) };
  });

  app.get('/knowledge-base/:id/versions', async (req) => {
    const { id } = idParam.parse(req.params);
    return { versions: await listKbVersions(deps, req.user, id) };
  });

  app.post('/knowledge-base', async (req, reply) => {
    const input = kbEntryInputSchema.parse(req.body);
    return reply.status(201).send(await createKbEntry(deps, req.user, input));
  });

  app.patch('/knowledge-base/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const patch = kbEntryUpdateSchema.parse(req.body);
    if (Object.keys(patch).length === 0) throw badRequest('No changes supplied');
    return updateKbEntry(deps, req.user, id, patch);
  });

  // DELETE archives (soft delete) so past drafts keep their cited sources.
  app.delete('/knowledge-base/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await archiveKbEntry(deps, req.user, id);
    return reply.status(204).send();
  });

  app.post('/knowledge-base/:id/restore', async (req) => {
    const { id } = idParam.parse(req.params);
    return { entry: await restoreKbEntry(deps, req.user, id) };
  });

  app.post(
    '/knowledge-base/:id/reembed',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const { id } = idParam.parse(req.params);
      const { force } = z.object({ force: z.boolean().default(false) }).parse(req.body ?? {});
      return reembedKbEntry(deps, req.user, id, force);
    },
  );

  // Shows exactly what the AI would retrieve for a query, with scores. Read-only, brand-scoped.
  app.post(
    '/knowledge-base/preview',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const body = z
        .object({ brand_id: z.string().uuid(), query: z.string().trim().min(2).max(500) })
        .parse(req.body);
      assertBrandAccess(req.user, body.brand_id, 'Brand');
      const result = await retrieve(deps, { brandId: body.brand_id, query: body.query });
      return { ...result, thresholds: deps.aiConfig.retrieval };
    },
  );
}
