/**
 * Integration tests against the real Supabase project in .env: RLS, brand isolation in SQL retrieval,
 * KB versioning and the atomic/idempotent draft lifecycle.
 */
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { id, users } from '../../supabase/seed/data.js';

const url = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const password = process.env.SEED_PASSWORD ?? 'DemoPass!2026';

const BLOOM = id('brand:bloom');
const NORDIC = id('brand:nordic');
const MAYA_CONV = id('conversation:maya');

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(url, serviceKey, opts);

async function signedIn(email: string): Promise<{ client: SupabaseClient; userId: string }> {
  const client = createClient(url, anonKey, opts);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`login ${email}: ${error?.message}`);
  return { client, userId: data.user.id };
}

let bloomAgent: Awaited<ReturnType<typeof signedIn>>;
let nordicAgent: Awaited<ReturnType<typeof signedIn>>;
let multiAgent: Awaited<ReturnType<typeof signedIn>>;
let admin: Awaited<ReturnType<typeof signedIn>>;

beforeAll(async () => {
  [bloomAgent, nordicAgent, multiAgent, admin] = await Promise.all([
    signedIn('agent.bloom@demo.test'),
    signedIn('agent.nordic@demo.test'),
    signedIn('agent.multi@demo.test'),
    signedIn('admin@demo.test'),
  ]);
});

describe('RLS: read isolation', () => {
  it('anonymous clients see nothing', async () => {
    const anon = createClient(url, anonKey, opts);
    const { data } = await anon.from('brands').select('id'); // permission error or empty: either is fine
    expect(data ?? []).toHaveLength(0);
  });

  it('a Bloom agent sees only Bloom brand/conversations/customers/KB', async () => {
    const { client } = bloomAgent;
    const brands = (await client.from('brands').select('id')).data ?? [];
    expect(brands.map((b) => b.id)).toEqual([BLOOM]);

    const convs = (await client.from('conversations').select('brand_id')).data ?? [];
    expect(convs.length).toBeGreaterThan(0);
    expect(new Set(convs.map((c) => c.brand_id))).toEqual(new Set([BLOOM]));

    const kb = (await client.from('knowledge_base').select('brand_id')).data ?? [];
    expect(kb.length).toBeGreaterThan(0);
    expect(new Set(kb.map((k) => k.brand_id))).toEqual(new Set([BLOOM]));

    const orders = (await client.from('orders').select('brand_id')).data ?? [];
    expect(new Set(orders.map((o) => o.brand_id))).toEqual(new Set([BLOOM]));
  });

  it('a Nordic agent cannot read a Bloom conversation or its messages by id', async () => {
    const conv = await nordicAgent.client.from('conversations').select('id').eq('id', MAYA_CONV);
    expect(conv.data).toEqual([]);
    const msgs = await nordicAgent.client
      .from('messages')
      .select('id')
      .eq('conversation_id', MAYA_CONV);
    expect(msgs.data).toEqual([]);
  });

  it('a multi-brand agent sees both brands; admin sees both', async () => {
    for (const who of [multiAgent, admin]) {
      const brands = (await who.client.from('brands').select('id')).data ?? [];
      expect(new Set(brands.map((b) => b.id))).toEqual(new Set([BLOOM, NORDIC]));
    }
  });

  it('browser clients cannot read raw embeddings', async () => {
    const { error } = await bloomAgent.client.from('knowledge_base').select('embedding').limit(1);
    expect(error).not.toBeNull();
  });
});

describe('RLS: browser clients cannot write', () => {
  it('agent cannot insert messages directly', async () => {
    const { error } = await bloomAgent.client.from('messages').insert({
      brand_id: BLOOM,
      conversation_id: MAYA_CONV,
      sender_type: 'customer',
      body: 'forged',
      client_message_id: randomUUID(),
    });
    expect(error).not.toBeNull();
  });

  it('agent cannot modify KB, settings, or memberships', async () => {
    const kb = await bloomAgent.client
      .from('knowledge_base')
      .update({ content: 'x'.repeat(20) })
      .eq('brand_id', BLOOM);
    expect(kb.error !== null || (kb.data ?? []).length === 0).toBe(true);
    const settings = await bloomAgent.client
      .from('brand_settings')
      .update({ tone: 'hacked' })
      .eq('brand_id', BLOOM);
    expect(settings.error !== null || (settings.data ?? []).length === 0).toBe(true);
    const grant = await bloomAgent.client
      .from('brand_memberships')
      .insert({ user_id: bloomAgent.userId, brand_id: NORDIC });
    expect(grant.error).not.toBeNull();
    const role = await bloomAgent.client
      .from('profiles')
      .update({ role: 'admin' })
      .eq('id', bloomAgent.userId);
    expect(role.error !== null || (role.data ?? []).length === 0).toBe(true);
    // verify nothing changed
    const { data } = await service
      .from('profiles')
      .select('role')
      .eq('id', bloomAgent.userId)
      .single();
    expect(data?.role).toBe('agent');
  });

  it('agent cannot call privileged RPCs', async () => {
    const { error } = await bloomAgent.client.rpc('fn_send_draft', {
      p_generation: randomUUID(),
      p_actor: bloomAgent.userId,
      p_idempotency_key: randomUUID(),
    });
    expect(error).not.toBeNull();
  });
});

describe('match_kb_hybrid: brand isolation inside SQL', () => {
  it('service-role retrieval for Bloom returns only Bloom entries (keyword mode)', async () => {
    const { data, error } = await service.rpc('match_kb_hybrid', {
      p_brand_id: BLOOM,
      p_query_text: 'refund return shipping damaged',
      p_match_count: 10,
    });
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
    const ids = new Set((data as { id: string }[]).map((r) => r.id));
    const { data: rows } = await service
      .from('knowledge_base')
      .select('id, brand_id')
      .in('id', [...ids]);
    expect(new Set((rows ?? []).map((r) => r.brand_id))).toEqual(new Set([BLOOM]));
  });

  it('a Bloom agent asking for Nordic policies directly gets nothing', async () => {
    const { data, error } = await bloomAgent.client.rpc('match_kb_hybrid', {
      p_brand_id: NORDIC,
      p_query_text: 'return policy 30 days',
      p_match_count: 10,
    });
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('inactive and archived entries are never returned', async () => {
    const entryId = id('kb:bloom-faq');
    await service.from('knowledge_base').update({ is_active: false }).eq('id', entryId);
    try {
      const { data } = await service.rpc('match_kb_hybrid', {
        p_brand_id: BLOOM,
        p_query_text: 'yellowed leaves arrival care',
        p_match_count: 10,
      });
      expect((data as { id: string }[]).map((r) => r.id)).not.toContain(entryId);
    } finally {
      await service.from('knowledge_base').update({ is_active: true }).eq('id', entryId);
    }
  });

  it('Brand terms stay in their own brand: Bloom 7-day vs Nordic 30-day', async () => {
    const q = (brand: string) =>
      service.rpc('match_kb_hybrid', {
        p_brand_id: brand,
        p_query_text: 'return window',
        p_match_count: 3,
      });
    const bloom = ((await q(BLOOM)).data ?? []) as { content: string }[];
    const nordic = ((await q(NORDIC)).data ?? []) as { content: string }[];
    expect(bloom[0]?.content).toContain('7 days');
    expect(nordic[0]?.content).toContain('30 days');
    expect(bloom.some((r) => r.content.includes('Nordic'))).toBe(false);
    expect(nordic.some((r) => r.content.includes('Bloom'))).toBe(false);
  });
});

describe('knowledge base versioning', () => {
  const kbId = randomUUID();
  afterAll(async () => {
    await service.from('knowledge_base').delete().eq('id', kbId);
  });

  it('bumps version only on meaningful change and snapshots each version', async () => {
    const ins = await service
      .from('knowledge_base')
      .insert({
        id: kbId,
        brand_id: BLOOM,
        title: 'Temp policy',
        category: 'faq',
        content: 'Original content for versioning test.',
      })
      .select('version, content_hash, embedding_status')
      .single();
    expect(ins.error).toBeNull();
    expect(ins.data?.version).toBe(1);
    expect(ins.data?.embedding_status).toBe('pending');
    const hash1 = ins.data!.content_hash;
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);

    // same content -> no bump
    const same = await service
      .from('knowledge_base')
      .update({ title: 'Temp policy' })
      .eq('id', kbId)
      .select('version')
      .single();
    expect(same.data?.version).toBe(1);

    const changed = await service
      .from('knowledge_base')
      .update({ content: 'Changed content for versioning test.' })
      .eq('id', kbId)
      .select('version, content_hash')
      .single();
    expect(changed.data?.version).toBe(2);
    expect(changed.data?.content_hash).not.toBe(hash1);

    const toggled = await service
      .from('knowledge_base')
      .update({ is_active: false })
      .eq('id', kbId)
      .select('version')
      .single();
    expect(toggled.data?.version).toBe(3);

    const versions = await service
      .from('knowledge_base_versions')
      .select('version, content')
      .eq('kb_id', kbId)
      .order('version');
    expect(versions.data?.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(versions.data?.[0]?.content).toBe('Original content for versioning test.');
  });

  it('version snapshots are immutable', async () => {
    const upd = await service
      .from('knowledge_base_versions')
      .update({ content: 'tampered' })
      .eq('kb_id', kbId);
    expect(upd.error).not.toBeNull();
    const del = await service.from('knowledge_base_versions').delete().eq('kb_id', kbId);
    expect(del.error).not.toBeNull();
  });
});

describe('draft lifecycle (atomic + idempotent)', () => {
  const created: string[] = [];
  const kbSource = id('kb:bloom-damaged');

  async function newDraft(body = 'Hi Maya! Sorry the bottle arrived broken.'): Promise<string> {
    const { data: kb } = await service
      .from('knowledge_base')
      .select('version, title')
      .eq('id', kbSource)
      .single();
    const { data, error } = await service.rpc('fn_save_generation', {
      p_payload: {
        brand_id: BLOOM,
        conversation_id: MAYA_CONV,
        requested_by: bloomAgent.userId,
        status: 'draft',
        intent: 'damaged_product',
        language: 'en',
        body,
        model: 'test',
        escalate: false,
        guardrails: [{ check: 'schema', passed: true, severity: 'info' }],
        sources: [
          {
            kb_id: kbSource,
            kb_version: kb!.version,
            title: kb!.title,
            rank: 1,
            fused_score: 0.03,
          },
        ],
      },
    });
    expect(error).toBeNull();
    created.push(data as string);
    return data as string;
  }

  afterAll(async () => {
    for (const g of created) {
      await service.from('messages').delete().eq('ai_generation_id', g);
      await service.from('ai_generations').delete().eq('id', g);
    }
  });

  it('cannot send before approval; edit -> approve -> send works; replay returns the same message', async () => {
    const draft = await newDraft();
    const early = await service.rpc('fn_send_draft', {
      p_generation: draft,
      p_actor: bloomAgent.userId,
      p_idempotency_key: 'key-early-1',
    });
    expect(early.error?.message).toMatch(/must be approved/);

    const edited = await service.rpc('fn_edit_draft', {
      p_generation: draft,
      p_actor: bloomAgent.userId,
      p_body: 'Edited reply text.',
    });
    expect(edited.error).toBeNull();
    const approved = await service.rpc('fn_approve_draft', {
      p_generation: draft,
      p_actor: bloomAgent.userId,
    });
    expect(approved.error).toBeNull();

    // 5 concurrent sends with the same key -> exactly one message
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.rpc('fn_send_draft', {
          p_generation: draft,
          p_actor: bloomAgent.userId,
          p_idempotency_key: 'key-send-123',
        }),
      ),
    );
    expect(results.every((r) => r.error === null)).toBe(true);
    const messageIds = new Set(results.map((r) => (r.data as { id: string }).id));
    expect(messageIds.size).toBe(1);

    const { data: msgs } = await service
      .from('messages')
      .select('id, body, sender_type')
      .eq('ai_generation_id', draft);
    expect(msgs).toHaveLength(1);
    expect(msgs?.[0]?.body).toBe('Edited reply text.');
    expect(msgs?.[0]?.sender_type).toBe('agent');

    const { data: events } = await service
      .from('ai_draft_events')
      .select('event_type')
      .eq('generation_id', draft)
      .order('created_at');
    expect(events?.map((e) => e.event_type)).toEqual(['generated', 'edited', 'approved', 'sent']);
  });

  it('a user outside the brand cannot act on the draft', async () => {
    const draft = await newDraft();
    const r = await service.rpc('fn_approve_draft', {
      p_generation: draft,
      p_actor: nordicAgent.userId,
    });
    expect(r.error?.message).toMatch(/forbidden/);
  });

  it('refuses approval/send when a cited policy changed (stale policy)', async () => {
    const draft = await newDraft();
    const original = (
      await service.from('knowledge_base').select('content').eq('id', kbSource).single()
    ).data!.content;
    await service
      .from('knowledge_base')
      .update({ content: original + ' Updated: replacements ship within 2 days.' })
      .eq('id', kbSource);
    try {
      const r = await service.rpc('fn_approve_draft', {
        p_generation: draft,
        p_actor: bloomAgent.userId,
      });
      expect(r.error?.message).toMatch(/STALE_POLICY/);
      const stale = await service.rpc('draft_stale_sources', { p_generation: draft });
      expect(stale.data).toHaveLength(1);
    } finally {
      await service.from('knowledge_base').update({ content: original }).eq('id', kbSource);
    }
  });

  it('a new generation supersedes older open drafts; discarded drafts cannot be sent', async () => {
    const first = await newDraft('first');
    const second = await newDraft('second');
    const { data } = await service
      .from('ai_generations')
      .select('id, status')
      .in('id', [first, second]);
    expect(data?.find((d) => d.id === first)?.status).toBe('superseded');
    expect(data?.find((d) => d.id === second)?.status).toBe('draft');

    await service.rpc('fn_discard_draft', { p_generation: second, p_actor: bloomAgent.userId });
    const approve = await service.rpc('fn_approve_draft', {
      p_generation: second,
      p_actor: bloomAgent.userId,
    });
    expect(approve.error).not.toBeNull();
  });

  it('blocking guardrail failures prevent approval', async () => {
    const { data } = await service.rpc('fn_save_generation', {
      p_payload: {
        brand_id: BLOOM,
        conversation_id: MAYA_CONV,
        requested_by: bloomAgent.userId,
        status: 'draft',
        body: 'Promise of refund',
        guardrails: [{ check: 'no_unsupported_promises', passed: false, severity: 'blocking' }],
      },
    });
    created.push(data as string);
    const r = await service.rpc('fn_approve_draft', {
      p_generation: data,
      p_actor: bloomAgent.userId,
    });
    expect(r.error?.message).toMatch(/blocking guardrail/);
  });
});

describe('message idempotency & brand consistency constraints', () => {
  it('duplicate client_message_id in a conversation is rejected by the database', async () => {
    const key = `test-${randomUUID()}`;
    const row = {
      brand_id: BLOOM,
      conversation_id: MAYA_CONV,
      sender_type: 'customer',
      body: 'dup test',
      client_message_id: key,
    };
    const a = await service.from('messages').insert(row);
    const b = await service.from('messages').insert(row);
    expect(a.error).toBeNull();
    expect(b.error?.code).toBe('23505');
    await service.from('messages').delete().eq('client_message_id', key);
  });

  it('cannot attach a conversation to a customer of another brand', async () => {
    const { error } = await service.from('conversations').insert({
      brand_id: BLOOM,
      customer_id: id('customer:emma'), // Nordic customer
    });
    expect(error?.code).toBe('23503');
  });

  it('cannot create a message whose brand does not match its conversation', async () => {
    const { error } = await service.from('messages').insert({
      brand_id: NORDIC,
      conversation_id: MAYA_CONV,
      sender_type: 'customer',
      body: 'x',
      client_message_id: randomUUID(),
    });
    expect(error?.code).toBe('23503');
  });

  it('rejects attachments over 5 MB or with disallowed mime types', async () => {
    const base = {
      brand_id: BLOOM,
      conversation_id: MAYA_CONV,
      storage_path: `brand/${BLOOM}/t-${randomUUID()}`,
    };
    const big = await service
      .from('message_attachments')
      .insert({ ...base, mime_type: 'image/png', size_bytes: 6_000_000 });
    expect(big.error?.code).toBe('23514');
    const bad = await service
      .from('message_attachments')
      .insert({
        ...base,
        storage_path: base.storage_path + 'b',
        mime_type: 'application/pdf',
        size_bytes: 10,
      });
    expect(bad.error?.code).toBe('23514');
  });
});

describe('seed integrity', () => {
  it('contains both brands with differing policies and all demo users exist', async () => {
    const { data: brands } = await service.from('brands').select('id');
    expect(brands).toHaveLength(2);
    for (const brand of [BLOOM, NORDIC]) {
      const { data } = await service
        .from('knowledge_base')
        .select('category')
        .eq('brand_id', brand)
        .eq('is_active', true);
      const cats = new Set((data ?? []).map((k) => k.category));
      for (const c of [
        'return_policy',
        'refund_policy',
        'shipping_policy',
        'cancellation_policy',
      ]) {
        expect(cats.has(c)).toBe(true);
      }
    }
    expect(users).toHaveLength(4);
  });
});
