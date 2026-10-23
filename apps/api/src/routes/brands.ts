import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { brandSettingsUpdateSchema } from '@cx/shared';
import { assertAdmin, assertBrandAccess } from '../auth.js';
import type { Deps } from '../deps.js';
import { badRequest } from '../errors.js';

const idParam = z.object({ id: z.string().uuid() });

export async function brandRoutes(app: FastifyInstance, { db }: Deps) {
  app.get('/brands', async (req) => {
    if (req.user.brandIds.length === 0) return { brands: [] };
    const { data, error } = await db
      .from('brands')
      .select('id, name, slug, settings:brand_settings(*)')
      .in('id', req.user.brandIds)
      .order('name');
    if (error) throw new Error(error.message);
    return { brands: data ?? [] };
  });

  app.get('/brands/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    assertBrandAccess(req.user, id, 'Brand');
    const { data, error } = await db
      .from('brands')
      .select('id, name, slug, settings:brand_settings(*)')
      .eq('id', id)
      .single();
    if (error) throw new Error(error.message);
    return { brand: data };
  });

  app.patch('/brands/:id/settings', async (req) => {
    assertAdmin(req.user);
    const { id } = idParam.parse(req.params);
    assertBrandAccess(req.user, id, 'Brand');
    const patch = brandSettingsUpdateSchema.parse(req.body);
    if (Object.keys(patch).length === 0) throw badRequest('No changes supplied');
    const { data, error } = await db
      .from('brand_settings')
      .update(patch)
      .eq('brand_id', id)
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    return { settings: data };
  });
}
