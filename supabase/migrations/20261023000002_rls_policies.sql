-- Authorization model
--   * admin  : full access to every brand.
--   * agent  : access to brands they are a member of.
--   * Browser clients (role `authenticated`) get SELECT only. Every mutation goes through the
--     Fastify API, which authorizes explicitly and then writes with the service role.
--   * `anon` has no access to anything.

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin');
$$;

create or replace function public.user_is_admin(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = p_user and p.role = 'admin');
$$;

create or replace function public.user_has_brand_access(p_user uuid, p_brand uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.user_is_admin(p_user)
      or exists (select 1 from public.brand_memberships m where m.user_id = p_user and m.brand_id = p_brand);
$$;

create or replace function public.has_brand_access(p_brand uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.user_has_brand_access(auth.uid(), p_brand);
$$;

-- Helper functions are executable by signed-in users (needed by policies) but not by anon.
revoke all on function public.is_admin() from public, anon;
revoke all on function public.has_brand_access(uuid) from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.has_brand_access(uuid) to authenticated;
-- The (user, brand) variants take an arbitrary user id => service role only.
revoke all on function public.user_is_admin(uuid) from public, anon, authenticated;
revoke all on function public.user_has_brand_access(uuid, uuid) from public, anon, authenticated;
grant execute on function public.user_is_admin(uuid) to service_role;
grant execute on function public.user_has_brand_access(uuid, uuid) to service_role;

-- Table privileges: authenticated may only read; the policies below narrow rows further.
revoke all on all tables in schema public from anon, authenticated;
grant select on
  public.profiles, public.brands, public.brand_settings, public.brand_memberships, public.customers,
  public.orders, public.order_items, public.conversations, public.messages, public.message_attachments,
  public.knowledge_base, public.knowledge_base_versions, public.ai_generations,
  public.ai_generation_sources, public.ai_draft_events, public.escalation_requests
to authenticated;
-- Never let the browser read raw embeddings (large, not needed).
revoke select on public.knowledge_base from authenticated;
grant select (id, brand_id, title, category, content, conditions, content_hash, version, is_active,
  archived_at, embedding_status, embedding_error, embedded_hash, embedding_model, created_by,
  created_at, updated_at) on public.knowledge_base to authenticated;
grant all on all tables in schema public to service_role;
alter default privileges in schema public revoke all on tables from anon, authenticated;

create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());

create policy brands_select on public.brands for select to authenticated
  using (public.has_brand_access(id));
create policy brand_settings_select on public.brand_settings for select to authenticated
  using (public.has_brand_access(brand_id));
create policy brand_memberships_select on public.brand_memberships for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy customers_select on public.customers for select to authenticated
  using (public.has_brand_access(brand_id));
create policy orders_select on public.orders for select to authenticated
  using (public.has_brand_access(brand_id));
create policy order_items_select on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and public.has_brand_access(o.brand_id)));

create policy conversations_select on public.conversations for select to authenticated
  using (public.has_brand_access(brand_id));
create policy messages_select on public.messages for select to authenticated
  using (public.has_brand_access(brand_id));
create policy message_attachments_select on public.message_attachments for select to authenticated
  using (public.has_brand_access(brand_id));

create policy knowledge_base_select on public.knowledge_base for select to authenticated
  using (public.has_brand_access(brand_id));
create policy knowledge_base_versions_select on public.knowledge_base_versions for select to authenticated
  using (public.has_brand_access(brand_id));

create policy ai_generations_select on public.ai_generations for select to authenticated
  using (public.has_brand_access(brand_id));
create policy ai_generation_sources_select on public.ai_generation_sources for select to authenticated
  using (exists (select 1 from public.ai_generations g where g.id = generation_id and public.has_brand_access(g.brand_id)));
create policy ai_draft_events_select on public.ai_draft_events for select to authenticated
  using (public.has_brand_access(brand_id));
create policy escalation_requests_select on public.escalation_requests for select to authenticated
  using (public.has_brand_access(brand_id));

-- ---------------------------------------------------------------------------
-- Realtime: stream new messages / draft changes to authorized clients (RLS is applied to each event)
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.ai_generations;

-- ---------------------------------------------------------------------------
-- Storage: private bucket; path = brand/<brand_id>/conversation/<conversation_id>/<file>
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attachments', 'attachments', false, 5242880,
        array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = false, file_size_limit = 5242880,
      allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

create or replace function public.storage_path_brand(p_name text) returns uuid
language sql immutable as $$
  select case when p_name ~ '^brand/[0-9a-f-]{36}/' then split_part(p_name, '/', 2)::uuid end;
$$;

create policy attachments_select on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and public.has_brand_access(public.storage_path_brand(name)));
-- No insert/update/delete policies for clients: uploads are performed by the API after validation.
