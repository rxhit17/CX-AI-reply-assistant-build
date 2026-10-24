import { deriveConditions, kbEmbeddingText } from '@cx/ai';
import type { KbCategory, KbEntryInput, PolicyConditions } from '@cx/shared';
import { assertAdmin, assertBrandAccess, type AuthUser } from '../auth.js';
import type { Deps } from '../deps.js';
import { notFound } from '../errors.js';

// Everything except the raw embedding vector.
const KB_COLUMNS =
  'id, brand_id, title, category, content, conditions, content_hash, version, is_active, archived_at, ' +
  'embedding_status, embedding_error, embedded_hash, embedding_model, created_at, updated_at';

type KbDeps = Pick<Deps, 'db' | 'embeddings' | 'aiConfig'>;

export async function loadKbEntry(deps: KbDeps, user: AuthUser, id: string) {
  const { data, error } = await deps.db
    .from('knowledge_base')
    .select(KB_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw notFound('Knowledge base entry');
  const row = data as unknown as { brand_id: string };
  assertBrandAccess(user, row.brand_id, 'Knowledge base entry');
  return data as unknown as KbRow;
}

interface KbRow {
  id: string;
  brand_id: string;
  title: string;
  category: KbCategory;
  content: string;
  conditions: PolicyConditions | null;
  content_hash: string;
  version: number;
  embedded_hash: string | null;
  embedding_status: 'pending' | 'ready' | 'failed';
  is_active: boolean;
  archived_at: string | null;
}

export async function listKbEntries(
  deps: KbDeps,
  user: AuthUser,
  f: {
    brand_id?: string;
    category?: KbCategory;
    q?: string;
    active?: boolean;
    include_archived?: boolean;
  },
) {
  const brandIds = f.brand_id ? user.brandIds.filter((b) => b === f.brand_id) : user.brandIds;
  if (brandIds.length === 0) return [];
  let query = deps.db
    .from('knowledge_base')
    .select(KB_COLUMNS)
    .in('brand_id', brandIds)
    .order('category')
    .order('title')
    .limit(500);
  if (!f.include_archived) query = query.is('archived_at', null);
  if (f.category) query = query.eq('category', f.category);
  if (f.active !== undefined) query = query.eq('is_active', f.active);
  if (f.q) {
    const term = f.q.replace(/[%,()*\\]/g, ' ').trim();
    if (term) query = query.or(`title.ilike.%${term}%,content.ilike.%${term}%`);
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * Generates and stores the embedding for an entry when needed. Content that was already embedded
 * (embedded_hash === content_hash) is skipped unless `force` is set, avoiding repeat API calls.
 * Failures are recorded on the row and never lose or roll back the KB content itself.
 */
export async function embedEntry(
  deps: KbDeps,
  entry: KbRow,
  force = false,
): Promise<'embedded' | 'skipped' | 'failed'> {
  const { db, embeddings } = deps;
  if (!force && entry.embedded_hash === entry.content_hash && entry.embedding_status === 'ready')
    return 'skipped';
  if (!embeddings) {
    await db
      .from('knowledge_base')
      .update({ embedding_status: 'failed', embedding_error: 'No embedding provider configured' })
      .eq('id', entry.id);
    return 'failed';
  }
  try {
    const [vector] = await embeddings.embedDocuments([kbEmbeddingText(entry)]);
    if (!vector || vector.length !== embeddings.dimensions)
      throw new Error('Unexpected embedding size');
    // Guard with content_hash: if the entry was edited while we were embedding, keep it pending.
    const { error } = await db
      .from('knowledge_base')
      .update({
        embedding: `[${vector.join(',')}]`,
        embedded_hash: entry.content_hash,
        embedding_model: embeddings.model,
        embedding_status: 'ready',
        embedding_error: null,
      })
      .eq('id', entry.id)
      .eq('content_hash', entry.content_hash);
    if (error) throw new Error(error.message);
    return 'embedded';
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    await db
      .from('knowledge_base')
      .update({ embedding_status: 'failed', embedding_error: message })
      .eq('id', entry.id);
    return 'failed';
  }
}

export async function createKbEntry(deps: KbDeps, user: AuthUser, input: KbEntryInput) {
  assertAdmin(user);
  assertBrandAccess(user, input.brand_id, 'Brand');
  // The figures that drive eligibility are read from the policy wording, so the text is the single source.
  const sync = deriveConditions(input.category, input.content, input.conditions);
  const { data, error } = await deps.db
    .from('knowledge_base')
    .insert({ ...input, conditions: sync.conditions, created_by: user.id })
    .select(KB_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  await embedEntry(deps, data as unknown as KbRow);
  return {
    entry: await loadKbEntry(deps, user, (data as unknown as KbRow).id),
    conditions_sync: { changes: sync.changes, warnings: sync.warnings },
  };
}

export async function updateKbEntry(
  deps: KbDeps,
  user: AuthUser,
  id: string,
  patch: Record<string, unknown>,
) {
  assertAdmin(user);
  const current = await loadKbEntry(deps, user, id);
  // Re-read the figures whenever the wording or category changes (or conditions are supplied explicitly).
  let sync = { changes: [] as string[], warnings: [] as string[] };
  if ('content' in patch || 'category' in patch || 'conditions' in patch) {
    const derived = deriveConditions(
      (patch.category as KbCategory | undefined) ?? current.category,
      (patch.content as string | undefined) ?? current.content,
      'conditions' in patch ? (patch.conditions as PolicyConditions | null) : current.conditions,
    );
    patch = { ...patch, conditions: derived.conditions };
    sync = { changes: derived.changes, warnings: derived.warnings };
  }
  const { data, error } = await deps.db
    .from('knowledge_base')
    .update(patch)
    .eq('id', id)
    .select(KB_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  // No-ops when the content hash is unchanged (e.g. toggling is_active only).
  await embedEntry(deps, data as unknown as KbRow);
  return { entry: await loadKbEntry(deps, user, id), conditions_sync: sync };
}

/** Soft delete: the row stays for audit (drafts reference it); it just stops being retrievable. */
export async function archiveKbEntry(deps: KbDeps, user: AuthUser, id: string) {
  assertAdmin(user);
  await loadKbEntry(deps, user, id);
  const { error } = await deps.db
    .from('knowledge_base')
    .update({ archived_at: new Date().toISOString(), is_active: false })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

export async function restoreKbEntry(deps: KbDeps, user: AuthUser, id: string) {
  assertAdmin(user);
  await loadKbEntry(deps, user, id);
  const { error } = await deps.db
    .from('knowledge_base')
    .update({ archived_at: null, is_active: true })
    .eq('id', id);
  if (error) throw new Error(error.message);
  return loadKbEntry(deps, user, id);
}

export async function reembedKbEntry(deps: KbDeps, user: AuthUser, id: string, force: boolean) {
  assertAdmin(user);
  const entry = await loadKbEntry(deps, user, id);
  const outcome = await embedEntry(deps, entry, force);
  return { outcome, entry: await loadKbEntry(deps, user, id) };
}

export async function listKbVersions(deps: KbDeps, user: AuthUser, id: string) {
  await loadKbEntry(deps, user, id);
  const { data, error } = await deps.db
    .from('knowledge_base_versions')
    .select(
      'id, version, title, category, content, conditions, content_hash, is_active, changed_by, created_at',
    )
    .eq('kb_id', id)
    .order('version', { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}
