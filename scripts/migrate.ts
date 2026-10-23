/**
 * Applies supabase/migrations/*.sql to DATABASE_URL in order, once each, each inside a transaction.
 * Applied files are tracked in public._migrations (name + checksum). A changed, already-applied file
 * is an error: add a new migration instead of editing history.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const dir = join(import.meta.dirname, '..', 'supabase', 'migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query(`create table if not exists public._migrations (
    name text primary key, checksum text not null, applied_at timestamptz not null default now())`);
  await client.query('alter table public._migrations enable row level security');
  const applied = new Map(
    (await client.query<{ name: string; checksum: string }>('select name, checksum from public._migrations')).rows.map(
      (r) => [r.name, r.checksum],
    ),
  );
  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const prev = applied.get(file);
    if (prev) {
      if (prev !== checksum) throw new Error(`Migration ${file} was modified after being applied`);
      console.log(`skip   ${file}`);
      continue;
    }
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('insert into public._migrations (name, checksum) values ($1, $2)', [file, checksum]);
      await client.query('commit');
      console.log(`apply  ${file}`);
    } catch (err) {
      await client.query('rollback');
      throw new Error(`${file}: ${err instanceof Error ? err.message : err}`);
    }
  }
} finally {
  await client.end();
}
