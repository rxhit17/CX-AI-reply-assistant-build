-- Refines 20261024000009: the vector depends only on the text that is embedded (title, category, content).
--  * title/category/content changed  -> drop the OLD vector now; the API creates the NEW one.
--  * only the structured figures (conditions) changed -> the vector is still valid and stays "ready"; it is simply
--    re-labelled with the new content_hash so it is not re-embedded for nothing.
--  * archived -> vector dropped (restoring re-embeds).
-- Callers that store a fresh vector in the same UPDATE (embedded_hash changes) are left alone.
create or replace function public.kb_before_write() returns trigger
language plpgsql as $$
declare
  text_changed boolean;
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
      text_changed := new.title is distinct from old.title
                   or new.category is distinct from old.category
                   or new.content is distinct from old.content;
      if text_changed or (new.archived_at is not null and old.archived_at is null) then
        new.embedding := null;
        new.embedded_hash := null;
        new.embedding_model := null;
        new.embedding_status := 'pending';
        new.embedding_error := null;
      elsif new.content_hash is distinct from old.content_hash
            and old.embedded_hash is not distinct from old.content_hash
            and old.embedding is not null then
        -- figures only: the existing vector is still correct
        new.embedded_hash := new.content_hash;
      end if;
    end if;
    new.updated_at := now();
  end if;
  return new;
end $$;

-- Entries whose vector was dropped by the previous version of the trigger are re-embedded by the API sweep
-- (at start-up and every 10 minutes) or with "pnpm embed:kb".
