-- Fixes found by integration tests:
--  1. Keyword search must use OR semantics (AND made any multi-word query match nothing); ranking
--     decides relevance.
--  2. Browser roles cannot read the raw embedding column, so the function runs as definer and enforces
--     brand access itself: service_role (the API, which has already authorized the caller) or a user
--     with membership in p_brand_id. Anyone else gets zero rows.
drop function if exists public.match_kb_hybrid(uuid, text, extensions.vector, text[], integer, double precision);

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
language sql stable security definer set search_path = public, extensions as $$
  with eligible as (
    select k.id, k.title, k.category, k.version, k.content, k.conditions, k.embedding, k.fts
    from public.knowledge_base k
    where k.brand_id = p_brand_id               -- brand isolation: enforced here, in SQL
      and k.is_active
      and k.archived_at is null
      and (auth.role() = 'service_role' or public.has_brand_access(p_brand_id))
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
    select nullif(replace(plainto_tsquery('english', coalesce(p_query_text, ''))::text, ' & ', ' | '), '')::tsquery as tsq
  ),
  fts as (
    select e.id,
           ts_rank_cd(e.fts, q.tsq) as rank_score,
           row_number() over (order by ts_rank_cd(e.fts, q.tsq) desc) as rnk
    from eligible e, q
    where q.tsq is not null and e.fts @@ q.tsq
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
