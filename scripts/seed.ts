/**
 * Idempotent demo seed. Safe to run repeatedly: every row has a deterministic id and is upserted.
 * KB embeddings are never overwritten (columns omitted from the upsert payload).
 *
 * Usage: pnpm db:seed
 * Refuses to run against a non-local Supabase URL unless SEED_ALLOW_REMOTE=true and SEED_PASSWORD is set,
 * because it creates accounts with a known password.
 */
import { createClient } from '@supabase/supabase-js';
import {
  brands,
  conversations,
  customers,
  DEMO_PASSWORD,
  id,
  knowledgeBase,
  orders,
  users,
} from '../supabase/seed/data.js';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');

const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url);
if (!isLocal && !(process.env.SEED_ALLOW_REMOTE === 'true' && process.env.SEED_PASSWORD)) {
  throw new Error(
    'Refusing to seed a non-local Supabase project. Set SEED_ALLOW_REMOTE=true and a strong SEED_PASSWORD to override.',
  );
}

const db = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const now = Date.now();
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(now - d * DAY).toISOString();
const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();

function must<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

async function ensureUsers(): Promise<Map<string, string>> {
  const userIds = new Map<string, string>();
  const { data: existing, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(`listUsers: ${error.message}`);
  for (const u of users) {
    let uid = existing.users.find((x) => x.email === u.email)?.id;
    if (!uid) {
      const created = await db.auth.admin.createUser({
        email: u.email,
        password: DEMO_PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: u.full_name },
      });
      if (created.error || !created.data.user)
        throw new Error(`createUser ${u.email}: ${created.error?.message}`);
      uid = created.data.user.id;
    }
    userIds.set(u.key, uid);
    must(
      await db
        .from('profiles')
        .upsert({ id: uid, email: u.email, full_name: u.full_name, role: u.role }),
      `profile ${u.email}`,
    );
  }
  return userIds;
}

async function main() {
  const userIds = await ensureUsers();

  must(
    await db
      .from('brands')
      .upsert(brands.map((b) => ({ id: id(`brand:${b.key}`), name: b.name, slug: b.slug }))),
    'brands',
  );
  must(
    await db
      .from('brand_settings')
      .upsert(brands.map((b) => ({ brand_id: id(`brand:${b.key}`), ...b.settings }))),
    'brand_settings',
  );
  const memberships = users.flatMap((u) =>
    u.brands.map((b) => ({ user_id: userIds.get(u.key)!, brand_id: id(`brand:${b}`) })),
  );
  must(await db.from('brand_memberships').upsert(memberships), 'memberships');

  must(
    await db.from('customers').upsert(
      customers.map((c) => ({
        id: id(`customer:${c.key}`),
        brand_id: id(`brand:${c.brand}`),
        name: c.name,
        email: c.email,
        preferred_language: c.lang,
      })),
    ),
    'customers',
  );

  must(
    await db.from('orders').upsert(
      orders.map((o) => ({
        id: id(`order:${o.key}`),
        brand_id: id(`brand:${o.brand}`),
        customer_id: id(`customer:${o.customer}`),
        order_number: o.number,
        status: o.status,
        total: o.total,
        currency: 'USD',
        placed_at: daysAgo(o.placedDaysAgo),
        shipped_at: o.shippedDaysAgo !== undefined ? daysAgo(o.shippedDaysAgo) : null,
        delivered_at: o.deliveredDaysAgo !== undefined ? daysAgo(o.deliveredDaysAgo) : null,
        estimated_delivery_at: o.etaInDays !== undefined ? daysAgo(-o.etaInDays) : null,
      })),
    ),
    'orders',
  );
  must(
    await db.from('order_items').upsert(
      orders.flatMap((o) =>
        o.items.map((it, i) => ({
          id: id(`item:${o.key}:${i}`),
          order_id: id(`order:${o.key}`),
          ...it,
        })),
      ),
    ),
    'order_items',
  );

  // Embedding columns are intentionally absent so a re-seed never discards generated embeddings.
  must(
    await db.from('knowledge_base').upsert(
      knowledgeBase.map((k) => ({
        id: id(`kb:${k.key}`),
        brand_id: id(`brand:${k.brand}`),
        title: k.title,
        category: k.category,
        content: k.content,
        conditions: k.conditions ?? null,
        is_active: true,
      })),
    ),
    'knowledge_base',
  );

  must(
    await db.from('conversations').upsert(
      conversations.map((c) => {
        const customer = customers.find((x) => x.key === c.customer)!;
        const lastMin = Math.min(...c.messages.map((m) => m.minutesAgo));
        return {
          id: id(`conversation:${c.key}`),
          brand_id: id(`brand:${customer.brand}`),
          customer_id: id(`customer:${c.customer}`),
          order_id: c.order ? id(`order:${c.order}`) : null,
          status: c.status,
          created_at: minutesAgo(Math.max(...c.messages.map((m) => m.minutesAgo)) + 5),
          closed_at: c.status === 'closed' ? minutesAgo(lastMin) : null,
        };
      }),
    ),
    'conversations',
  );

  const agentFor = (brand: string) =>
    userIds.get(brand === 'bloom' ? 'bloom-agent' : 'nordic-agent')!;
  must(
    await db.from('messages').upsert(
      conversations.flatMap((c) => {
        const customer = customers.find((x) => x.key === c.customer)!;
        return c.messages.map((m, i) => ({
          id: id(`message:${c.key}:${i}`),
          brand_id: id(`brand:${customer.brand}`),
          conversation_id: id(`conversation:${c.key}`),
          sender_type: m.from,
          sender_id: m.from === 'agent' ? agentFor(customer.brand) : null,
          body: m.body,
          client_message_id: `seed-${c.key}-${i}`,
          created_at: minutesAgo(m.minutesAgo),
          delivered_at: minutesAgo(m.minutesAgo),
        }));
      }),
      { onConflict: 'id' },
    ),
    'messages',
  );

  console.log(
    `Seeded: ${brands.length} brands, ${users.length} users, ${customers.length} customers, ` +
      `${orders.length} orders, ${knowledgeBase.length} KB entries, ${conversations.length} conversations.`,
  );
  console.log(
    `Demo logins (password from SEED_PASSWORD or default): ${users.map((u) => u.email).join(', ')}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
