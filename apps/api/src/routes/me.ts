import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';

export async function meRoutes(app: FastifyInstance, { db }: Deps) {
  app.get('/me', async (req) => {
    const { data: profile } = await db
      .from('profiles')
      .select('full_name')
      .eq('id', req.user.id)
      .single();
    return {
      user: {
        id: req.user.id,
        email: req.user.email,
        role: req.user.role,
        full_name: profile?.full_name ?? '',
        brand_ids: req.user.brandIds,
      },
    };
  });

  // Customers (with their orders) of the caller's brands, for starting a conversation.
  app.get('/customers', async (req) => {
    const { brand_id } = z.object({ brand_id: z.string().uuid().optional() }).parse(req.query);
    const brandIds = brand_id ? req.user.brandIds.filter((b) => b === brand_id) : req.user.brandIds;
    if (brandIds.length === 0) return { customers: [] };
    const { data, error } = await db
      .from('customers')
      .select('id, brand_id, name, email, preferred_language, orders(id, order_number, status)')
      .in('brand_id', brandIds)
      .order('name');
    if (error) throw new Error(error.message);
    return { customers: data ?? [] };
  });
}
