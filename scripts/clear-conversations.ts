/**
 * Deletes ALL conversations and everything that belongs to them (messages, attachments and their files, AI drafts,
 * draft events and escalation requests). Brands, customers, orders, the knowledge base and users are kept.
 *
 * Usage: pnpm db:clear-chats          (dry run: only shows what would be deleted)
 *        pnpm db:clear-chats --yes    (deletes)
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
const db = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const confirmed = process.argv.includes('--yes');

const TABLES = [
  'conversations',
  'messages',
  'message_attachments',
  'ai_generations',
  'ai_draft_events',
  'escalation_requests',
] as const;

async function counts() {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    const { count, error } = await db.from(t).select('*', { count: 'exact', head: true });
    if (error) throw new Error(`${t}: ${error.message}`);
    out[t] = count ?? 0;
  }
  return out;
}

console.log(`Project: ${url}`);
console.log('Before:', await counts());
if (!confirmed) {
  console.log('Dry run. Nothing was deleted. Run again with --yes to delete.');
  process.exit(0);
}

const { data: files, error: filesErr } = await db
  .from('message_attachments')
  .select('storage_path');
if (filesErr) throw new Error(filesErr.message);
const paths = (files ?? []).map((f) => f.storage_path as string);
for (let i = 0; i < paths.length; i += 100) {
  const { error } = await db.storage.from('attachments').remove(paths.slice(i, i + 100));
  if (error) throw new Error(`storage: ${error.message}`);
}

// Children (messages, attachments, drafts, events, escalations) are removed by ON DELETE CASCADE.
const { error } = await db
  .from('conversations')
  .delete()
  .neq('id', '00000000-0000-0000-0000-000000000000');
if (error) throw new Error(error.message);

console.log('After: ', await counts());
console.log(`Deleted. ${paths.length} attachment file(s) removed from storage.`);
