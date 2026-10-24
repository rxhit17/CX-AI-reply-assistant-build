-- Embedding lifecycle: the vector of a policy must never outlive the wording it was computed from.
--  * wording (title/category/content/conditions) changes -> the OLD vector is removed in the same statement; the API
--    then computes the NEW one. Until it exists the entry is found by keyword search only (never by a stale vector).
--  * the entry is archived (deleted) -> its vector is removed; restoring it re-embeds it.
-- Callers that store a fresh vector in the same UPDATE (embedded_hash changes) are left alone.
create or replace function public.kb_before_write() returns trigger
language plpgsql as $$
begin
  new.content_hash := encode(extensions.digest(
    convert_to(new.title || E'\x1f' || new.category || E'\x1f' || new.content || E'\x1f' || coalesce(new.conditions::text, ''), 'UTF8'),
    'sha256'), 'hex');
  if tg_op = 'INSERT' then
    new.version := 1;
    new.embedding_status := 'pending';
  else
    -- Any change that can alter what the AI says bumps the version (also activation/archival).
    if new.content_hash is distinct from old.content_hash
       or new.is_active is distinct from old.is_active
       or (new.archived_at is null) is distinct from (old.archived_at is null) then
      new.version := old.version + 1;
    else
      new.version := old.version;
    end if;
    if new.embedded_hash is not distinct from old.embedded_hash then
      if new.content_hash is distinct from old.content_hash
         or (new.archived_at is not null and old.archived_at is null) then
        new.embedding := null;
        new.embedded_hash := null;
        new.embedding_model := null;
        new.embedding_status := 'pending';
        new.embedding_error := null;
      end if;
    end if;
    new.updated_at := now();
  end if;
  return new;
end $$;

-- Existing rows: drop any vector that no longer matches its content, and those of archived entries.
update public.knowledge_base
   set embedding = null, embedded_hash = null, embedding_model = null, embedding_status = 'pending', embedding_error = null
 where embedding is not null
   and (archived_at is not null or embedded_hash is distinct from content_hash);
