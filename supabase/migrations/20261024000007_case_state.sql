-- Conversation-aware case state: what the customer has told us so far (confirmed facts, desired resolution,
-- corrections) plus the derived workflow decision (stage, next action, missing information).
-- It is a cache of facts extracted from the message history: messages stay authoritative and every run re-derives
-- the state from them, using this value only to preserve facts that fall outside the history window.
alter table public.ai_generations add column if not exists case_state jsonb;

create index if not exists ai_generations_case_state_idx
  on public.ai_generations (conversation_id, created_at desc) where case_state is not null;

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
    image_evidence, graph_trace, case_state)
  values (
    v_brand, v_conv, nullif(p_payload ->> 'trigger_message_id', '')::uuid, v_actor,
    nullif(p_payload ->> 'parent_generation_id', '')::uuid, v_status, p_payload ->> 'intent',
    p_payload ->> 'language', p_payload ->> 'search_query',
    coalesce(p_payload ->> 'body', ''), coalesce(p_payload ->> 'body', ''), p_payload ->> 'model',
    (p_payload ->> 'prompt_tokens')::int, (p_payload ->> 'completion_tokens')::int,
    (p_payload ->> 'latency_ms')::int, p_payload ->> 'error_code', p_payload ->> 'error_message',
    coalesce((p_payload ->> 'escalate')::boolean, false),
    coalesce(p_payload -> 'guardrails', '[]'::jsonb), coalesce(p_payload -> 'eligibility', '[]'::jsonb),
    p_payload -> 'order_facts', p_payload -> 'image_evidence', coalesce(p_payload -> 'graph_trace', '[]'::jsonb),
    case when jsonb_typeof(p_payload -> 'case_state') = 'object' then p_payload -> 'case_state' end)
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
