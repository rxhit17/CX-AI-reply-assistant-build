-- Append-only tables must reject direct UPDATE/DELETE, but still allow the cascade that fires when the
-- parent row (KB entry / generation / brand) is deleted. Cascades run the trigger at depth > 1.
create or replace function public.forbid_mutation() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception '% on % is not allowed (append-only)', tg_op, tg_table_name;
end $$;
