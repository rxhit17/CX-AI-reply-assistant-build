/** API-level integration tests (Fastify inject) against the real Supabase project. */
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/app.js';
import { loadEnv } from '../../apps/api/src/env.js';
import { id } from '../../supabase/seed/data.js';

const env = loadEnv({ ...process.env, LOG_LEVEL: 'silent', NODE_ENV: 'test' });
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);
const password = process.env.SEED_PASSWORD ?? 'DemoPass!2026';

const BLOOM = id('brand:bloom');
const NORDIC = id('brand:nordic');
const MAYA = id('conversation:maya');
const EMMA = id('conversation:emma');

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function token(email: string): Promise<string> {
  const c = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, opts);
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`login ${email}: ${error?.message}`);
  return data.session.access_token;
}

let app: FastifyInstance;
let bloom: { authorization: string };
let nordic: { authorization: string };
let admin: { authorization: string };
const createdMessageKeys: string[] = [];

beforeAll(async () => {
  app = await buildApp({ env, db });
  const [b, n, a] = await Promise.all([
    token('agent.bloom@demo.test'),
    token('agent.nordic@demo.test'),
    token('admin@demo.test'),
  ]);
  bloom = { authorization: `Bearer ${b}` };
  nordic = { authorization: `Bearer ${n}` };
  admin = { authorization: `Bearer ${a}` };
});

afterAll(async () => {
  await db.from('messages').delete().in('client_message_id', createdMessageKeys);
  await app.close();
});

const call = (
  headers: Record<string, string> | undefined,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
) => app.inject({ method, url, headers, payload: payload as object });

describe('authentication', () => {
  it('rejects missing and garbage tokens with 401', async () => {
    expect((await call(undefined, 'GET', '/api/conversations')).statusCode).toBe(401);
    expect(
      (await call({ authorization: 'Bearer nope' }, 'GET', '/api/conversations')).statusCode,
    ).toBe(401);
  });
});

describe('identity & customers', () => {
  it('/me reports the caller’s role and brands from the database', async () => {
    const res = await call(bloom, 'GET', '/api/me');
    expect(res.json().user).toMatchObject({
      email: 'agent.bloom@demo.test',
      role: 'agent',
      brand_ids: [BLOOM],
    });
    expect((await call(admin, 'GET', '/api/me')).json().user.role).toBe('admin');
  });
  it('/customers lists only the caller’s brand customers with their orders', async () => {
    const rows = (await call(bloom, 'GET', '/api/customers')).json().customers as {
      brand_id: string;
      orders: unknown[];
    }[];
    expect(rows.length).toBe(4);
    expect(new Set(rows.map((r) => r.brand_id))).toEqual(new Set([BLOOM]));
    expect(
      (await call(bloom, 'GET', `/api/customers?brand_id=${NORDIC}`)).json().customers,
    ).toEqual([]);
  });
});

describe('brands & conversation access', () => {
  it('lists only the caller’s brands', async () => {
    const res = await call(bloom, 'GET', '/api/brands');
    expect(res.statusCode).toBe(200);
    expect(res.json().brands.map((b: { id: string }) => b.id)).toEqual([BLOOM]);
  });

  it('conversation list is scoped to the agent’s brand', async () => {
    const res = await call(bloom, 'GET', '/api/conversations');
    const rows = res.json().conversations as { brand_id: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.brand_id))).toEqual(new Set([BLOOM]));
  });

  it('requesting another brand’s conversation yields 404, and filtering by that brand yields nothing', async () => {
    expect((await call(bloom, 'GET', `/api/conversations/${EMMA}`)).statusCode).toBe(404);
    expect((await call(bloom, 'GET', `/api/conversations/${EMMA}/order`)).statusCode).toBe(404);
    const filtered = await call(bloom, 'GET', `/api/conversations?brand_id=${NORDIC}`);
    expect(filtered.json().conversations).toEqual([]);
  });

  it('returns conversation detail with customer, brand voice, messages and order', async () => {
    const res = await call(bloom, 'GET', `/api/conversations/${MAYA}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.customer.name).toBe('Maya Patel');
    expect(body.brand.name).toBe('Bloom Botanics');
    expect(body.messages.length).toBeGreaterThan(0);
    const order = (await call(bloom, 'GET', `/api/conversations/${MAYA}/order`)).json().order;
    expect(order.order_number).toBe('BB-10041');
    expect(order.items.length).toBe(2);
  });

  it('search filters the inbox', async () => {
    const res = await call(bloom, 'GET', '/api/conversations?q=maya');
    const names = res.json().conversations.map((c: { customer_name: string }) => c.customer_name);
    expect(names).toEqual(['Maya Patel']);
  });
});

describe('messaging', () => {
  it('sends customer and agent messages and de-duplicates by client_message_id', async () => {
    const key = `it-${randomUUID()}`;
    createdMessageKeys.push(key);
    const payload = { body: 'Integration hello', sender_type: 'customer', client_message_id: key };
    const [a, b, c] = await Promise.all([
      call(bloom, 'POST', `/api/conversations/${MAYA}/messages`, payload),
      call(bloom, 'POST', `/api/conversations/${MAYA}/messages`, payload),
      call(bloom, 'POST', `/api/conversations/${MAYA}/messages`, payload),
    ]);
    for (const r of [a, b, c]) expect([200, 201]).toContain(r.statusCode);
    expect(new Set([a, b, c].map((r) => r.json().message.id)).size).toBe(1);
    expect([a, b, c].filter((r) => r.statusCode === 201).length).toBe(1);
    const { count } = await db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('client_message_id', key);
    expect(count).toBe(1);

    const agentKey = `it-${randomUUID()}`;
    createdMessageKeys.push(agentKey);
    const agent = await call(bloom, 'POST', `/api/conversations/${MAYA}/messages`, {
      body: 'Manual agent reply',
      sender_type: 'agent',
      client_message_id: agentKey,
    });
    expect(agent.statusCode).toBe(201);
    expect(agent.json().message.sender_type).toBe('agent');
    expect(agent.json().message.ai_generation_id).toBeNull();
  });

  it('validates input and enforces brand scope', async () => {
    const empty = await call(bloom, 'POST', `/api/conversations/${MAYA}/messages`, {
      body: '',
      sender_type: 'agent',
      client_message_id: randomUUID(),
    });
    expect(empty.statusCode).toBe(400);
    const cross = await call(bloom, 'POST', `/api/conversations/${EMMA}/messages`, {
      body: 'sneaky',
      sender_type: 'agent',
      client_message_id: randomUUID(),
    });
    expect(cross.statusCode).toBe(404);
    const spoofedBrand = await call(bloom, 'POST', `/api/conversations/${MAYA}/messages`, {
      body: 'x',
      sender_type: 'agent',
      client_message_id: randomUUID(),
      brand_id: NORDIC,
    });
    // unknown keys are ignored; brand always derives from the conversation row
    expect([200, 201, 400]).toContain(spoofedBrand.statusCode);
    if (spoofedBrand.statusCode === 201) {
      createdMessageKeys.push(spoofedBrand.json().message.client_message_id);
      expect(spoofedBrand.json().message.conversation_id).toBe(MAYA);
    }
  });

  it('marks customer messages read for the agent view', async () => {
    const res = await call(bloom, 'POST', `/api/conversations/${MAYA}/read`, { reader: 'agent' });
    expect(res.statusCode).toBe(204);
    const { data } = await db
      .from('messages')
      .select('read_at')
      .eq('conversation_id', MAYA)
      .eq('sender_type', 'customer');
    expect(data?.every((m) => m.read_at !== null)).toBe(true);
  });
});

describe('attachments', () => {
  function multipartBody(filename: string, mime: string, content: Buffer) {
    const boundary = '----cxboundary' + randomUUID();
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
  }
  const upload = (
    who: Record<string, string>,
    convId: string,
    f: ReturnType<typeof multipartBody>,
  ) =>
    app.inject({
      method: 'POST',
      url: `/api/conversations/${convId}/attachments`,
      headers: { ...who, ...f.headers },
      payload: f.body,
    });

  it('uploads a PNG, signs a URL, and attaches it to a message', async () => {
    const res = await upload(bloom, MAYA, multipartBody('photo.png', 'image/png', PNG));
    expect(res.statusCode).toBe(201);
    const att = res.json().attachment;
    expect(att.url).toMatch(/^https?:\/\//);
    expect(att.storage_path.startsWith(`brand/${BLOOM}/conversation/${MAYA}/`)).toBe(true);

    const fetched = await fetch(att.url);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-type')).toContain('image/png');

    const key = `it-${randomUUID()}`;
    createdMessageKeys.push(key);
    const msg = await call(bloom, 'POST', `/api/conversations/${MAYA}/messages`, {
      body: '',
      sender_type: 'customer',
      client_message_id: key,
      attachment_ids: [att.id],
    });
    expect(msg.statusCode).toBe(201);
    expect(msg.json().message.attachments).toHaveLength(1);

    // an attachment cannot be reused for a second message
    const reuse = await call(bloom, 'POST', `/api/conversations/${MAYA}/messages`, {
      body: 'again',
      sender_type: 'customer',
      client_message_id: `it-${randomUUID()}`,
      attachment_ids: [att.id],
    });
    expect(reuse.statusCode).toBe(400);

    await db.storage.from('attachments').remove([att.storage_path]);
  });

  it('rejects spoofed, wrong-type, and cross-brand uploads', async () => {
    const fake = await upload(
      bloom,
      MAYA,
      multipartBody('x.png', 'image/png', Buffer.from('<html>not an image</html>')),
    );
    expect(fake.statusCode).toBe(400);
    const svg = await upload(
      bloom,
      MAYA,
      multipartBody('x.svg', 'image/svg+xml', Buffer.from('<svg/>')),
    );
    expect(svg.statusCode).toBe(400);
    const cross = await upload(nordic, MAYA, multipartBody('p.png', 'image/png', PNG));
    expect(cross.statusCode).toBe(404);
  });

  it('rejects files over 5 MB', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 10, 1);
    PNG.copy(big);
    const res = await upload(bloom, MAYA, multipartBody('big.png', 'image/png', big));
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});

describe('brand settings (admin only)', () => {
  it('forbids agents and lets admins update, then restores', async () => {
    const denied = await call(bloom, 'PATCH', `/api/brands/${BLOOM}/settings`, {
      tone: 'hacked tone',
    });
    expect(denied.statusCode).toBe(403);

    const before = (await call(admin, 'GET', `/api/brands/${BLOOM}`)).json().brand.settings;
    const ok = await call(admin, 'PATCH', `/api/brands/${BLOOM}/settings`, {
      sign_off: 'Test sign-off',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().settings.sign_off).toBe('Test sign-off');
    await call(admin, 'PATCH', `/api/brands/${BLOOM}/settings`, { sign_off: before.sign_off });

    const bad = await call(admin, 'PATCH', `/api/brands/${BLOOM}/settings`, { unknown_field: 1 });
    expect(bad.statusCode).toBe(400);
  });
});
