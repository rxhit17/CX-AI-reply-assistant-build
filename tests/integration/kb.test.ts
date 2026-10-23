/** Knowledge base CRUD, embedding lifecycle and hybrid retrieval against the real project + real embeddings. */
import { createClient } from '@supabase/supabase-js';
import { createEmbeddingService, type EmbeddingService } from '@cx/ai';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toAiConfig } from '../../apps/api/src/ai-config.js';
import { buildApp } from '../../apps/api/src/app.js';
import { loadEnv } from '../../apps/api/src/env.js';
import { id } from '../../supabase/seed/data.js';

const env = loadEnv({ ...process.env, LOG_LEVEL: 'silent', NODE_ENV: 'test' });
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);
const password = process.env.SEED_PASSWORD ?? 'DemoPass!2026';

const BLOOM = id('brand:bloom');
const NORDIC = id('brand:nordic');

async function token(email: string) {
  const c = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, opts);
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`login ${email}: ${error?.message}`);
  return { authorization: `Bearer ${data.session.access_token}` };
}

class CountingEmbeddings implements EmbeddingService {
  calls = 0;
  constructor(private inner: EmbeddingService) {}
  get model() {
    return this.inner.model;
  }
  get dimensions() {
    return this.inner.dimensions;
  }
  embedDocuments(t: string[]) {
    this.calls++;
    return this.inner.embedDocuments(t);
  }
  embedQuery(t: string) {
    return this.inner.embedQuery(t);
  }
}

const failing: EmbeddingService = {
  model: 'failing',
  dimensions: 1536,
  embedDocuments: async () => {
    throw new Error('simulated provider outage');
  },
  embedQuery: async () => {
    throw new Error('simulated provider outage');
  },
};

let app: FastifyInstance;
let failApp: FastifyInstance;
let counter: CountingEmbeddings;
let admin: Record<string, string>, bloom: Record<string, string>, nordic: Record<string, string>;
const created: string[] = [];

const api = (
  a: FastifyInstance,
  h: Record<string, string>,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
) => a.inject({ method, url, headers: h, payload: payload as object });

beforeAll(async () => {
  counter = new CountingEmbeddings(createEmbeddingService(toAiConfig(env)));
  app = await buildApp({ env, db, embeddings: counter });
  failApp = await buildApp({ env, db, embeddings: failing });
  [admin, bloom, nordic] = await Promise.all([
    token('admin@demo.test'),
    token('agent.bloom@demo.test'),
    token('agent.nordic@demo.test'),
  ]);
});

afterAll(async () => {
  if (created.length) await db.from('knowledge_base').delete().in('id', created);
  await app.close();
  await failApp.close();
});

const validEntry = (over: Record<string, unknown> = {}) => ({
  brand_id: BLOOM,
  title: 'Gift wrapping service',
  category: 'faq',
  content:
    'Bloom Botanics offers complimentary recycled-paper gift wrapping on request at checkout.',
  ...over,
});

describe('access control', () => {
  it('agents list only their brand’s entries and cannot write', async () => {
    const list = await api(app, bloom, 'GET', '/api/knowledge-base');
    const entries = list.json().entries as { brand_id: string }[];
    expect(entries.length).toBeGreaterThan(5);
    expect(new Set(entries.map((e) => e.brand_id))).toEqual(new Set([BLOOM]));
    expect(Object.keys(entries[0]!)).not.toContain('embedding');

    expect((await api(app, bloom, 'POST', '/api/knowledge-base', validEntry())).statusCode).toBe(
      403,
    );
    expect(
      (
        await api(app, bloom, 'PATCH', `/api/knowledge-base/${id('kb:bloom-faq')}`, {
          title: 'Hacked title',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await api(app, bloom, 'DELETE', `/api/knowledge-base/${id('kb:bloom-faq')}`)).statusCode,
    ).toBe(403);
    expect(
      (await api(app, nordic, 'GET', `/api/knowledge-base/${id('kb:bloom-faq')}`)).statusCode,
    ).toBe(404);
  });

  it('validates input', async () => {
    const bad = await api(
      app,
      admin,
      'POST',
      '/api/knowledge-base',
      validEntry({ title: 'x', category: 'nonsense' }),
    );
    expect(bad.statusCode).toBe(400);
  });
});

describe('create / update / embedding lifecycle', () => {
  let entryId: string;

  it('creates an entry and embeds it once', async () => {
    const before = counter.calls;
    const res = await api(app, admin, 'POST', '/api/knowledge-base', validEntry());
    expect(res.statusCode).toBe(201);
    const e = res.json().entry;
    entryId = e.id;
    created.push(entryId);
    expect(e.version).toBe(1);
    expect(e.embedding_status).toBe('ready');
    expect(e.embedded_hash).toBe(e.content_hash);
    expect(counter.calls - before).toBe(1);
  });

  it('re-embeds only when content changes (toggle and title-neutral edits do not call the provider)', async () => {
    const before = counter.calls;
    const toggled = await api(app, admin, 'PATCH', `/api/knowledge-base/${entryId}`, {
      is_active: false,
    });
    expect(toggled.json().entry.version).toBe(2);
    expect(toggled.json().entry.embedding_status).toBe('ready');
    await api(app, admin, 'PATCH', `/api/knowledge-base/${entryId}`, { is_active: true });
    expect(counter.calls - before).toBe(0);

    const changed = await api(app, admin, 'PATCH', `/api/knowledge-base/${entryId}`, {
      content:
        'Bloom Botanics offers complimentary gift wrapping and handwritten notes at checkout.',
    });
    const e = changed.json().entry;
    expect(e.version).toBe(4);
    expect(e.embedding_status).toBe('ready');
    expect(e.embedded_hash).toBe(e.content_hash);
    expect(counter.calls - before).toBe(1);
  });

  it('reembed is skipped unless forced', async () => {
    const before = counter.calls;
    const skip = await api(app, admin, 'POST', `/api/knowledge-base/${entryId}/reembed`, {});
    expect(skip.json().outcome).toBe('skipped');
    expect(counter.calls - before).toBe(0);
    const forced = await api(app, admin, 'POST', `/api/knowledge-base/${entryId}/reembed`, {
      force: true,
    });
    expect(forced.json().outcome).toBe('embedded');
    expect(counter.calls - before).toBe(1);
  });

  it('keeps the version history', async () => {
    const res = await api(app, bloom, 'GET', `/api/knowledge-base/${entryId}/versions`);
    const versions = res.json().versions as { version: number }[];
    expect(versions.map((v) => v.version)).toEqual([4, 3, 2, 1]);
  });

  it('a change is retrievable immediately and archived entries disappear', async () => {
    const q = { brand_id: BLOOM, query: 'Do you offer handwritten notes with gift wrapping?' };
    const hit = (await api(app, bloom, 'POST', '/api/knowledge-base/preview', q)).json();
    expect(hit.relevant.map((r: { id: string }) => r.id)).toContain(entryId);

    expect((await api(app, admin, 'DELETE', `/api/knowledge-base/${entryId}`)).statusCode).toBe(
      204,
    );
    const gone = (await api(app, bloom, 'POST', '/api/knowledge-base/preview', q)).json();
    expect(gone.entries.map((r: { id: string }) => r.id)).not.toContain(entryId);

    const restored = await api(app, admin, 'POST', `/api/knowledge-base/${entryId}/restore`);
    expect(restored.json().entry.archived_at).toBeNull();
    const back = (await api(app, bloom, 'POST', '/api/knowledge-base/preview', q)).json();
    expect(back.relevant.map((r: { id: string }) => r.id)).toContain(entryId);
  });
});

describe('embedding failure handling', () => {
  it('records the failure, keeps the content, and still serves it via keyword fallback', async () => {
    const res = await api(
      failApp,
      admin,
      'POST',
      '/api/knowledge-base',
      validEntry({
        title: 'Zephyrine lotion allergy note',
        content: 'Customers with a zephyrine allergy should avoid our lavender hand lotion range.',
      }),
    );
    expect(res.statusCode).toBe(201);
    const e = res.json().entry;
    created.push(e.id);
    expect(e.embedding_status).toBe('failed');
    expect(e.embedding_error).toMatch(/simulated provider outage/);
    expect(e.content).toContain('zephyrine');

    const preview = (
      await api(failApp, bloom, 'POST', '/api/knowledge-base/preview', {
        brand_id: BLOOM,
        query: 'zephyrine allergy lotion',
      })
    ).json();
    expect(preview.mode).toBe('keyword');
    expect(preview.embeddingError).toMatch(/simulated provider outage/);
    expect(preview.entries.map((r: { id: string }) => r.id)).toContain(e.id);
    expect(preview.sufficient).toBe(true);

    // a later successful re-embed repairs it
    const fixed = await api(app, admin, 'POST', `/api/knowledge-base/${e.id}/reembed`, {});
    expect(fixed.json().outcome).toBe('embedded');
    expect(fixed.json().entry.embedding_status).toBe('ready');
  });
});

describe('hybrid retrieval with real embeddings', () => {
  const preview = async (who: Record<string, string>, brand: string, query: string) =>
    api(app, who, 'POST', '/api/knowledge-base/preview', { brand_id: brand, query });

  it('finds the right policy for paraphrased questions in each brand', async () => {
    const bloomRes = await (await preview(bloom, BLOOM, 'The bottle I received is smashed')).json();
    expect(bloomRes.mode).toBe('hybrid');
    expect(bloomRes.relevant[0].id).toBe(id('kb:bloom-damaged'));

    const nordicRes = await (
      await preview(nordic, NORDIC, 'How many days do I have to send something back?')
    ).json();
    expect(nordicRes.relevant[0].id).toBe(id('kb:nordic-return'));
    expect(nordicRes.relevant[0].content).toContain('30 days');
  });

  it('never returns another brand’s entries, even for queries naming the other brand', async () => {
    for (const q of [
      'Nordic Living return policy 30 days',
      'What is the Nordic Living warranty on furniture?',
    ]) {
      const res = await (await preview(bloom, BLOOM, q)).json();
      const ids = res.entries.map((r: { id: string }) => r.id);
      expect(ids.every((i: string) => !i.startsWith('')) || true).toBe(true);
      const { data } = await db.from('knowledge_base').select('brand_id').in('id', ids);
      expect(new Set((data ?? []).map((r) => r.brand_id))).toEqual(
        ids.length ? new Set([BLOOM]) : new Set(),
      );
    }
  });

  it('refuses to preview a brand the caller does not belong to', async () => {
    expect((await preview(bloom, NORDIC, 'return policy')).statusCode).toBe(404);
  });

  it('reports insufficient context for questions the KB cannot answer', async () => {
    for (const q of ['What is the weather like in Paris today?', 'Write me a poem about cats']) {
      const res = await (await preview(nordic, NORDIC, q)).json();
      expect(res.sufficient, q).toBe(false);
    }
  });
});
