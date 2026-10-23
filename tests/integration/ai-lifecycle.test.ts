/**
 * Draft lifecycle through the HTTP API against the real database. The LLM is the deterministic mock
 * (LLM_MODE=mock) so the lifecycle, authorization, idempotency and audit behaviour is tested without
 * model variance; real-model behaviour is covered by the evaluation suite.
 */
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/app.js';
import { loadEnv } from '../../apps/api/src/env.js';
import { id } from '../../supabase/seed/data.js';

const env = loadEnv({
  ...process.env,
  LOG_LEVEL: 'silent',
  NODE_ENV: 'test',
  LLM_MODE: 'mock',
  RATE_LIMIT_AI_PER_AGENT_PER_MIN: '1000',
  RATE_LIMIT_AI_PER_CONVERSATION_PER_MIN: '1000',
});
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);
const password = process.env.SEED_PASSWORD ?? 'DemoPass!2026';

const MAYA = id('conversation:maya');
const EMMA = id('conversation:emma');
const LIAM = id('conversation:liam');
const BLOOM_DAMAGED = id('kb:bloom-damaged');

async function token(email: string) {
  const c = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, opts);
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`login ${email}: ${error?.message}`);
  return { authorization: `Bearer ${data.session.access_token}` };
}

let app: FastifyInstance;
let bloom: Record<string, string>, nordic: Record<string, string>, admin: Record<string, string>;
const generations: string[] = [];

const call = (
  h: Record<string, string>,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
) => app.inject({ method, url, headers: h, payload: payload as object });

async function generate(h = bloom, conversation_id = MAYA, options?: object) {
  const res = await call(h, 'POST', '/api/ai/generate', { conversation_id, options });
  if (res.statusCode === 201) generations.push(res.json().draft.id);
  return res;
}

beforeAll(async () => {
  app = await buildApp({ env, db, embeddings: null });
  [bloom, nordic, admin] = await Promise.all([
    token('agent.bloom@demo.test'),
    token('agent.nordic@demo.test'),
    token('admin@demo.test'),
  ]);
});

afterAll(async () => {
  await db.from('escalation_requests').delete().in('generation_id', generations);
  await db.from('messages').delete().in('ai_generation_id', generations);
  await db.from('ai_generations').delete().in('id', generations);
  await app.close();
});

describe('generate', () => {
  it('creates a draft that is NOT sent, with sources, eligibility and guardrails', async () => {
    const res = await generate();
    expect(res.statusCode).toBe(201);
    const { draft, sources } = res.json();
    expect(draft.status).toBe('draft');
    expect(draft.intent).toBe('damaged_product');
    expect(draft.original_body).toBe(draft.current_body);
    expect(draft.original_body).toContain('Hi Maya!');
    expect(draft.original_body).toContain('Happy growing, The Bloom Botanics Team');
    expect(draft.sent_at).toBeNull();
    expect(sources.map((s: { kb_id: string }) => s.kb_id)).toContain(BLOOM_DAMAGED);
    expect(draft.eligibility[0]).toMatchObject({ kind: 'damage' });
    expect(draft.guardrails.length).toBeGreaterThan(3);
    expect(draft.latency_ms).toBeGreaterThanOrEqual(0);
    // nothing was delivered to the customer
    const { count } = await db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('ai_generation_id', draft.id);
    expect(count).toBe(0);
  });

  it('refuses other brands’ conversations and unauthenticated calls', async () => {
    expect((await generate(nordic, MAYA)).statusCode).toBe(404);
    expect((await generate(bloom, EMMA)).statusCode).toBe(404);
    expect((await call({}, 'POST', '/api/ai/generate', { conversation_id: MAYA })).statusCode).toBe(
      401,
    );
  });

  it('ignores client-supplied brand/user ids: only conversation_id is accepted', async () => {
    const res = await call(bloom, 'POST', '/api/ai/generate', {
      conversation_id: MAYA,
      brand_id: id('brand:nordic'),
      user_id: randomUUID(),
    });
    expect(res.statusCode).toBe(201);
    generations.push(res.json().draft.id);
    expect(res.json().draft.brand_id).toBe(id('brand:bloom'));
    expect(res.json().draft.requested_by).not.toBeNull();
  });

  it('uses the refund window rule for the 20-days-ago refund scenario', async () => {
    const res = await generate(bloom, LIAM);
    expect(res.statusCode).toBe(201);
    const e = res.json().draft.eligibility.find((x: { kind: string }) => x.kind === 'refund');
    expect(e).toMatchObject({ outcome: 'ineligible' });
    expect(e.details.days_since_anchor).toBe(20);
    expect(res.json().draft.current_body).not.toMatch(/we will refund|i have refunded/i);
  });

  it('Nordic’s 30-day policy makes a 12-day-old delivery returnable', async () => {
    const res = await call(nordic, 'POST', '/api/ai/generate', { conversation_id: EMMA });
    expect(res.statusCode).toBe(201);
    generations.push(res.json().draft.id);
    expect(res.json().draft.eligibility[0]).toMatchObject({ kind: 'return', outcome: 'eligible' });
    expect(res.json().draft.original_body).toContain('Dear Emma,');
    expect(res.json().draft.original_body).toContain('Nordic Living Customer Care');
  });

  it('regenerating supersedes the previous draft and links the new one to it', async () => {
    const first = (await generate()).json().draft;
    const res = await call(bloom, 'POST', '/api/ai/regenerate', {
      conversation_id: MAYA,
      options: { regenerate_of: first.id },
    });
    expect(res.statusCode).toBe(201);
    generations.push(res.json().draft.id);
    expect(res.json().draft.parent_generation_id).toBe(first.id);
    const old = await call(bloom, 'GET', `/api/ai/drafts/${first.id}`);
    expect(old.json().draft.status).toBe('superseded');
    const latest = await call(bloom, 'GET', `/api/conversations/${MAYA}/draft`);
    expect(latest.json().draft.id).toBe(res.json().draft.id);
  });

  it('validates regenerate_of belongs to the conversation', async () => {
    const other = (await call(nordic, 'POST', '/api/ai/generate', { conversation_id: EMMA })).json()
      .draft.id;
    generations.push(other);
    const res = await call(bloom, 'POST', '/api/ai/regenerate', {
      conversation_id: MAYA,
      options: { regenerate_of: other },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('edit → approve → send', () => {
  it('requires an explicit approval and a separate send; preserves original, edit, and final text', async () => {
    const created = (await generate()).json().draft;

    const early = await call(bloom, 'POST', `/api/ai/drafts/${created.id}/send`, {
      idempotency_key: 'early-send-key-1',
    });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('NOT_APPROVED');

    const edited = await call(bloom, 'PATCH', `/api/ai/drafts/${created.id}`, {
      body: 'Hi Maya! Sorry about the bottle. Could you send a photo? Happy growing, The Bloom Botanics Team',
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().draft.status).toBe('edited');
    expect(edited.json().draft.original_body).toBe(created.original_body);

    const approved = await call(bloom, 'POST', `/api/ai/drafts/${created.id}/approve`);
    expect(approved.json().draft.status).toBe('approved');
    expect(approved.json().draft.approved_by).not.toBeNull();
    // approval alone does not deliver anything
    expect(
      (await db.from('messages').select('id').eq('ai_generation_id', created.id)).data,
    ).toHaveLength(0);

    // editing after approval requires approving again
    const reedit = await call(bloom, 'PATCH', `/api/ai/drafts/${created.id}`, {
      body: 'Hi Maya! Quick update. Happy growing, The Bloom Botanics Team',
    });
    expect(reedit.json().draft.status).toBe('edited');
    await call(bloom, 'POST', `/api/ai/drafts/${created.id}/approve`);

    const key = `send-${randomUUID()}`;
    const sends = await Promise.all(
      Array.from({ length: 4 }, () =>
        call(bloom, 'POST', `/api/ai/drafts/${created.id}/send`, { idempotency_key: key }),
      ),
    );
    for (const s of sends) expect(s.statusCode).toBe(200);
    expect(new Set(sends.map((s) => s.json().message.id)).size).toBe(1);

    const { data: msgs } = await db
      .from('messages')
      .select('body, sender_type, ai_generation_id')
      .eq('ai_generation_id', created.id);
    expect(msgs).toHaveLength(1);
    expect(msgs![0]).toMatchObject({
      sender_type: 'agent',
      body: 'Hi Maya! Quick update. Happy growing, The Bloom Botanics Team',
    });

    const final = await call(bloom, 'GET', `/api/ai/drafts/${created.id}`);
    expect(final.json().draft).toMatchObject({
      status: 'sent',
      original_body: created.original_body,
      current_body: msgs![0]!.body,
    });

    // can't edit or discard after sending
    expect(
      (await call(bloom, 'PATCH', `/api/ai/drafts/${created.id}`, { body: 'late edit' }))
        .statusCode,
    ).toBe(409);
    expect((await call(bloom, 'POST', `/api/ai/drafts/${created.id}/discard`)).statusCode).toBe(
      409,
    );
  });

  it('a stale policy blocks approval and sending, with a clear code', async () => {
    const created = (await generate()).json().draft;
    const original = (
      await db.from('knowledge_base').select('content').eq('id', BLOOM_DAMAGED).single()
    ).data!.content as string;
    await db
      .from('knowledge_base')
      .update({ content: original + ' Updated for the stale test.' })
      .eq('id', BLOOM_DAMAGED);
    try {
      const view = await call(bloom, 'GET', `/api/ai/drafts/${created.id}`);
      expect(view.json().draft.stale_policy).toBe(true);
      expect(view.json().stale_sources.length).toBeGreaterThan(0);
      const approve = await call(bloom, 'POST', `/api/ai/drafts/${created.id}/approve`);
      expect(approve.statusCode).toBe(409);
      expect(approve.json().error.code).toBe('STALE_POLICY');
    } finally {
      await db.from('knowledge_base').update({ content: original }).eq('id', BLOOM_DAMAGED);
    }
    // regenerating yields a fresh, approvable draft
    const fresh = (await generate()).json().draft;
    expect((await call(bloom, 'POST', `/api/ai/drafts/${fresh.id}/approve`)).statusCode).toBe(200);
  });

  it('other brands cannot touch the draft', async () => {
    const created = (await generate()).json().draft;
    for (const [method, url, payload] of [
      ['GET', `/api/ai/drafts/${created.id}`, undefined],
      ['PATCH', `/api/ai/drafts/${created.id}`, { body: 'nope' }],
      ['POST', `/api/ai/drafts/${created.id}/approve`, undefined],
      ['POST', `/api/ai/drafts/${created.id}/send`, { idempotency_key: 'cross-brand-key-1' }],
      ['POST', `/api/ai/drafts/${created.id}/discard`, undefined],
    ] as const) {
      expect((await call(nordic, method, url, payload)).statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('discard works and the audit events list every step in order', async () => {
    const created = (await generate()).json().draft;
    await call(bloom, 'PATCH', `/api/ai/drafts/${created.id}`, { body: 'Edited then discarded.' });
    expect(
      (await call(bloom, 'POST', `/api/ai/drafts/${created.id}/discard`)).json().draft.status,
    ).toBe('discarded');
    const log = await call(bloom, 'GET', `/api/ai/logs/${created.id}`);
    expect(log.json().events.map((e: { event_type: string }) => e.event_type)).toEqual([
      'generated',
      'edited',
      'discarded',
    ]);
  });
});

describe('logs', () => {
  it('lists generations with the fields the Logs page needs, scoped to the agent’s brand', async () => {
    const res = await call(bloom, 'GET', '/api/ai/logs?limit=20');
    expect(res.statusCode).toBe(200);
    const logs = res.json().logs as Record<string, unknown>[];
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) {
      expect(l.brand_id).toBe(id('brand:bloom'));
      for (const k of [
        'intent',
        'status',
        'model',
        'latency_ms',
        'prompt_tokens',
        'guardrails',
        'created_at',
        'ai_generation_sources',
        'trigger',
        'conversations',
      ]) {
        expect(l, k).toHaveProperty(k);
      }
    }
    expect(JSON.stringify(logs)).not.toMatch(/system prompt|sb_secret|OPENAI/i);
  });

  it('filters by status and brand, and admins can see both brands', async () => {
    const sent = (await call(bloom, 'GET', '/api/ai/logs?status=sent')).json().logs as {
      status: string;
    }[];
    expect(sent.every((l) => l.status === 'sent')).toBe(true);
    const adminAll = (await call(admin, 'GET', '/api/ai/logs?limit=200')).json().logs as {
      brand_id: string;
    }[];
    expect(new Set(adminAll.map((l) => l.brand_id)).size).toBe(2);
    const filtered = (
      await call(admin, 'GET', `/api/ai/logs?brand_id=${id('brand:nordic')}&limit=200`)
    ).json().logs as { brand_id: string }[];
    expect(filtered.every((l) => l.brand_id === id('brand:nordic'))).toBe(true);
    expect(
      (await call(bloom, 'GET', `/api/ai/logs?brand_id=${id('brand:nordic')}`)).json().logs,
    ).toEqual([]);
  });
});

describe('abuse protection', () => {
  it('rate-limits generation per conversation', async () => {
    const limited = await buildApp({
      env: { ...env, RATE_LIMIT_AI_PER_CONVERSATION_PER_MIN: 2 },
      db,
      embeddings: null,
    });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await limited.inject({
          method: 'POST',
          url: '/api/ai/generate',
          headers: bloom,
          payload: { conversation_id: LIAM },
        });
        if (r.statusCode === 201) generations.push(r.json().draft.id);
        codes.push(r.statusCode);
      }
      expect(codes.slice(0, 2)).toEqual([201, 201]);
      expect(codes.slice(2)).toEqual([429, 429]);
    } finally {
      await limited.close();
    }
  });

  it('rejects a second concurrent generation for the same conversation', async () => {
    const results = await Promise.all([generate(bloom, LIAM), generate(bloom, LIAM)]);
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409]);
  });
});
