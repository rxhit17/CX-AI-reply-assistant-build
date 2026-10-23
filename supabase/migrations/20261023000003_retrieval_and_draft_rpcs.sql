-- Hybrid retrieval and atomic draft lifecycle operations.

-- ---------------------------------------------------------------------------
-- Hybrid KB search. Brand isolation is enforced HERE: the only rows that can ever be returned are
-- active, non-archived entries whose brand_id = p_brand_id. SECURITY INVOKER means that when a
-- signed-in browser user calls it directly, RLS additionally requires brand membership.
-- Vector and full-text rankings are fused with Reciprocal Rank Fusion (k = 60).
-- When p_query_embedding is null (embeddings unavailable) it degrades to keyword-only search.
-- ---------------------------------------------------------------------------
create or replace function public.match_kb_hybrid(
  p_brand_id uuid,
  p_query_text text,
  p_query_embedding extensions.vector(1536) default null,
  p_categories text[] default null,
  p_match_count integer default 5,
  p_min_vector_similarity double precision default 0.0
)
returns table (
  id uuid,
  title text,
  category text,
  version integer,
  content text,
  conditions jsonb,
  vector_score double precision,
  text_score double precision,
  fused_score double precision
)
language sql stable security invoker set search_path = public, extensions as $$
  with eligible as (
    select k.*
    from public.knowledge_base k
    where k.brand_id = p_brand_id
      and k.is_active
      and k.archived_at is null
  ),
  vec as (
    select e.id,
           1 - (e.embedding <=> p_query_embedding) as sim,
           row_number() over (order by e.embedding <=> p_query_embedding) as rnk
    from eligible e
    where p_query_embedding is not null
      and e.embedding is not null
      and 1 - (e.embedding <=> p_query_embedding) >= p_min_vector_similarity
    order by e.embedding <=> p_query_embedding
    limit 20
  ),
  q as (
    select websearch_to_tsquery('english', coalesce(p_query_text, '')) as tsq
  ),
  fts as (
    select e.id,
           ts_rank_cd(e.fts, q.tsq) as rank_score,
           row_number() over (order by ts_rank_cd(e.fts, q.tsq) desc) as rnk
    from eligible e, q
    where q.tsq <> ''::tsquery and e.fts @@ q.tsq
    order by rank_score desc
    limit 20
  ),
  fused as (
    select coalesce(v.id, f.id) as id,
           v.sim as vector_score,
           f.rank_score as text_score,
           coalesce(1.0 / (60 + v.rnk), 0) + coalesce(1.0 / (60 + f.rnk), 0) as rrf
    from vec v
    full outer join fts f on f.id = v.id
  )
  select e.id, e.title, e.category, e.version, e.content, e.conditions,
         fu.vector_score::double precision,
         fu.text_score::double precision,
         (fu.rrf + case when p_categories is not null and e.category = any (p_categories) then 0.005 else 0 end)::double precision as fused_score
  from fused fu
  join eligible e on e.id = fu.id
  order by fused_score desc
  limit greatest(p_match_count, 1);
$$;

revoke all on function public.match_kb_hybrid(uuid, text, extensions.vector, text[], integer, double precision) from public, anon;
grant execute on function public.match_kb_hybrid(uuid, text, extensions.vector, text[], integer, double precision)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Stale-policy detection: which cited KB entries changed (version/activation) since the draft?
-- ---------------------------------------------------------------------------
create or replace function public.draft_stale_sources(p_generation uuid)
returns table (kb_id uuid, cited_version integer, current_version integer, still_active boolean)
language sql stable security definer set search_path = public as $$
  select s.kb_id, s.kb_version, k.version, (k.is_active and k.archived_at is null)
  from public.ai_generation_sources s
  join public.knowledge_base k on k.id = s.kb_id
  where s.generation_id = p_generation
    and (k.version <> s.kb_version or not (k.is_active and k.archived_at is null));
$$;
revoke all on function public.draft_stale_sources(uuid) from public, anon, authenticated;
grant execute on function public.draft_stale_sources(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Persist a finished generation atomically (draft row + sources + audit event).
-- p_payload keys: brand_id, conversation_id, trigger_message_id, requested_by, parent_generation_id,
--   status, intent, language, search_query, body, model, prompt_tokens, completion_tokens, latency_ms,
--   error_code, error_message, escalate, guardrails, eligibility, order_facts, image_evidence,
--   graph_trace, sources[{kb_id,kb_version,title,rank,vector_score,text_score,fused_score}]
-- ---------------------------------------------------------------------------
create or replace function public.fn_save_generation(p_payload jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_status text := coalesce(p_payload ->> 'status', 'draft');
  v_conv uuid := (p_payload ->> 'conversation_id')::uuid;
  v_brand uuid := (p_payload ->> 'brand_id')::uuid;
  v_actor uuid := nullif(p_payload ->> 'requested_by', '')::uuid;
begin
  if not exists (select 1 from public.conversations c where c.id = v_conv and c.brand_id = v_brand) then
    raise exception 'conversation/brand mismatch' using errcode = 'P0002';
  end if;

  -- Only one live draft per conversation: older open drafts become superseded.
  update public.ai_generations
     set status = 'superseded'
   where conversation_id = v_conv and status in ('draft', 'edited', 'approved');

  insert into public.ai_generations (
    brand_id, conversation_id, trigger_message_id, requested_by, parent_generation_id, status, intent,
    language, search_query, original_body, current_body, model, prompt_tokens, completion_tokens,
    latency_ms, error_code, error_message, escalate, guardrails, eligibility, order_facts,
    image_evidence, graph_trace)
  values (
    v_brand, v_conv, nullif(p_payload ->> 'trigger_message_id', '')::uuid, v_actor,
    nullif(p_payload ->> 'parent_generation_id', '')::uuid, v_status, p_payload ->> 'intent',
    p_payload ->> 'language', p_payload ->> 'search_query',
    coalesce(p_payload ->> 'body', ''), coalesce(p_payload ->> 'body', ''), p_payload ->> 'model',
    (p_payload ->> 'prompt_tokens')::int, (p_payload ->> 'completion_tokens')::int,
    (p_payload ->> 'latency_ms')::int, p_payload ->> 'error_code', p_payload ->> 'error_message',
    coalesce((p_payload ->> 'escalate')::boolean, false),
    coalesce(p_payload -> 'guardrails', '[]'::jsonb), coalesce(p_payload -> 'eligibility', '[]'::jsonb),
    p_payload -> 'order_facts', p_payload -> 'image_evidence', coalesce(p_payload -> 'graph_trace', '[]'::jsonb))
  returning id into v_id;

  insert into public.ai_generation_sources
    (generation_id, kb_id, kb_version, title, rank, vector_score, text_score, fused_score)
  select v_id, (s ->> 'kb_id')::uuid, (s ->> 'kb_version')::int, s ->> 'title', (s ->> 'rank')::int,
         (s ->> 'vector_score')::float8, (s ->> 'text_score')::float8, (s ->> 'fused_score')::float8
  from jsonb_array_elements(coalesce(p_payload -> 'sources', '[]'::jsonb)) s;

  insert into public.ai_draft_events (generation_id, brand_id, actor_id, event_type, to_status, payload)
  values (v_id, v_brand, v_actor, 'generated', v_status,
          jsonb_build_object('parent', p_payload ->> 'parent_generation_id'));
  return v_id;
end $$;
revoke all on function public.fn_save_generation(jsonb) from public, anon, authenticated;
grant execute on function public.fn_save_generation(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Draft lifecycle. All take a row lock so concurrent calls serialize; each re-checks brand access.
-- ---------------------------------------------------------------------------
create or replace function public.fn_edit_draft(p_generation uuid, p_actor uuid, p_body text)
returns public.ai_generations
language plpgsql security definer set search_path = public as $$
declare g public.ai_generations;
begin
  select * into g from public.ai_generations where id = p_generation for update;
  if not found then raise exception 'draft not found' using errcode = 'P0002'; end if;
  if not public.user_has_brand_access(p_actor, g.brand_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if g.status not in ('draft', 'edited', 'approved') then
    raise exception 'draft is % and cannot be edited', g.status using errcode = 'P0001';
  end if;
  if char_length(btrim(p_body)) = 0 then raise exception 'body is empty' using errcode = '22023'; end if;

  update public.ai_generations
     set current_body = p_body,
         status = 'edited',
         approved_by = null, approved_at = null -- editing after approval requires re-approval
   where id = p_generation returning * into g;
  insert into public.ai_draft_events (generation_id, brand_id, actor_id, event_type, from_status, to_status, payload)
  values (g.id, g.brand_id, p_actor, 'edited', null, 'edited', jsonb_build_object('length', char_length(p_body)));
  return g;
end $$;

create or replace function public.fn_approve_draft(p_generation uuid, p_actor uuid)
returns public.ai_generations
language plpgsql security definer set search_path = public as $$
declare g public.ai_generations; v_prev text;
begin
  select * into g from public.ai_generations where id = p_generation for update;
  if not found then raise exception 'draft not found' using errcode = 'P0002'; end if;
  if not public.user_has_brand_access(p_actor, g.brand_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if g.status = 'approved' then return g; end if; -- idempotent
  if g.status not in ('draft', 'edited') then
    raise exception 'draft is % and cannot be approved', g.status using errcode = 'P0001';
  end if;
  if exists (select 1 from jsonb_array_elements(g.guardrails) r
             where r ->> 'severity' = 'blocking' and (r ->> 'passed')::boolean = false) then
    raise exception 'draft has blocking guardrail failures' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.draft_stale_sources(p_generation)) then
    raise exception 'STALE_POLICY' using errcode = 'P0001';
  end if;

  v_prev := g.status;
  update public.ai_generations
     set status = 'approved', approved_by = p_actor, approved_at = now()
   where id = p_generation returning * into g;
  insert into public.ai_draft_events (generation_id, brand_id, actor_id, event_type, from_status, to_status)
  values (g.id, g.brand_id, p_actor, 'approved', v_prev, 'approved');
  return g;
end $$;

-- Atomic, idempotent send: approved draft -> one agent message. Replays return the same message.
create or replace function public.fn_send_draft(p_generation uuid, p_actor uuid, p_idempotency_key text)
returns public.messages
language plpgsql security definer set search_path = public as $$
declare g public.ai_generations; m public.messages;
begin
  select * into g from public.ai_generations where id = p_generation for update;
  if not found then raise exception 'draft not found' using errcode = 'P0002'; end if;
  if not public.user_has_brand_access(p_actor, g.brand_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if g.status = 'sent' then
    select * into m from public.messages where id = g.final_message_id;
    return m; -- replay: same message, no duplicate
  end if;
  if g.status <> 'approved' then
    raise exception 'draft is % and must be approved before sending', g.status using errcode = 'P0001';
  end if;
  if exists (select 1 from public.draft_stale_sources(p_generation)) then
    raise exception 'STALE_POLICY' using errcode = 'P0001';
  end if;

  insert into public.messages (brand_id, conversation_id, sender_type, sender_id, body, client_message_id, ai_generation_id)
  values (g.brand_id, g.conversation_id, 'agent', p_actor, g.current_body, p_idempotency_key, g.id)
  on conflict (conversation_id, client_message_id) do update set client_message_id = excluded.client_message_id
  returning * into m;

  update public.ai_generations
     set status = 'sent', sent_by = p_actor, sent_at = now(), final_message_id = m.id
   where id = g.id;
  insert into public.ai_draft_events (generation_id, brand_id, actor_id, event_type, from_status, to_status, payload)
  values (g.id, g.brand_id, p_actor, 'sent', 'approved', 'sent',
          jsonb_build_object('message_id', m.id, 'edited', g.current_body <> g.original_body));
  return m;
end $$;

create or replace function public.fn_discard_draft(p_generation uuid, p_actor uuid)
returns public.ai_generations
language plpgsql security definer set search_path = public as $$
declare g public.ai_generations; v_prev text;
begin
  select * into g from public.ai_generations where id = p_generation for update;
  if not found then raise exception 'draft not found' using errcode = 'P0002'; end if;
  if not public.user_has_brand_access(p_actor, g.brand_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if g.status = 'discarded' then return g; end if;
  if g.status not in ('draft', 'edited', 'approved', 'withheld') then
    raise exception 'draft is % and cannot be discarded', g.status using errcode = 'P0001';
  end if;
  v_prev := g.status;
  update public.ai_generations set status = 'discarded' where id = g.id returning * into g;
  insert into public.ai_draft_events (generation_id, brand_id, actor_id, event_type, from_status, to_status)
  values (g.id, g.brand_id, p_actor, 'discarded', v_prev, 'discarded');
  return g;
end $$;

revoke all on function public.fn_edit_draft(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.fn_approve_draft(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fn_send_draft(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.fn_discard_draft(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_edit_draft(uuid, uuid, text) to service_role;
grant execute on function public.fn_approve_draft(uuid, uuid) to service_role;
grant execute on function public.fn_send_draft(uuid, uuid, text) to service_role;
grant execute on function public.fn_discard_draft(uuid, uuid) to service_role;
