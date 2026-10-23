-- Core schema: extensions, tables, constraints, indexes, triggers.
-- RLS policies live in the next migration, but RLS is ENABLED here on every table so that
-- no table is ever created in an exposed-without-RLS state.

create extension if not exists vector with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Generic helpers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Identity & tenancy
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text not null default '',
  role text not null default 'agent' check (role in ('admin', 'agent')),
  created_at timestamptz not null default now()
);

create table public.brands (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9-]+$'),
  created_at timestamptz not null default now()
);

create table public.brand_settings (
  brand_id uuid primary key references public.brands (id) on delete cascade,
  tone text not null,
  communication_style text not null,
  greeting_preference text,
  sign_off text not null default '',
  supported_languages text[] not null default array['en'],
  updated_at timestamptz not null default now(),
  check (cardinality(supported_languages) >= 1)
);
create trigger brand_settings_updated before update on public.brand_settings
  for each row execute function public.set_updated_at();

create table public.brand_memberships (
  user_id uuid not null references public.profiles (id) on delete cascade,
  brand_id uuid not null references public.brands (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, brand_id)
);
create index brand_memberships_brand_idx on public.brand_memberships (brand_id);

-- ---------------------------------------------------------------------------
-- Customers, orders
-- ---------------------------------------------------------------------------
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands (id) on delete cascade,
  name text not null,
  email text not null,
  preferred_language text,
  created_at timestamptz not null default now(),
  unique (brand_id, email),
  unique (id, brand_id) -- target for composite FKs that keep child rows in the same brand
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands (id) on delete cascade,
  customer_id uuid not null,
  order_number text not null,
  status text not null check (status in ('processing', 'shipped', 'in_transit', 'delivered', 'cancelled')),
  total numeric(10, 2) not null check (total >= 0),
  currency text not null default 'USD',
  placed_at timestamptz not null,
  shipped_at timestamptz,
  delivered_at timestamptz,
  estimated_delivery_at timestamptz,
  created_at timestamptz not null default now(),
  unique (brand_id, order_number),
  unique (id, brand_id),
  foreign key (customer_id, brand_id) references public.customers (id, brand_id) on delete cascade,
  check (status <> 'delivered' or delivered_at is not null)
);
create index orders_customer_idx on public.orders (customer_id);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  name text not null,
  quantity integer not null check (quantity > 0),
  unit_price numeric(10, 2) not null check (unit_price >= 0)
);
create index order_items_order_idx on public.order_items (order_id);

-- ---------------------------------------------------------------------------
-- Conversations & messages
-- ---------------------------------------------------------------------------
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands (id) on delete cascade,
  customer_id uuid not null,
  order_id uuid,
  status text not null default 'open' check (status in ('open', 'closed')),
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (id, brand_id),
  foreign key (customer_id, brand_id) references public.customers (id, brand_id) on delete cascade,
  foreign key (order_id, brand_id) references public.orders (id, brand_id) on delete set null (order_id)
);
create index conversations_brand_activity_idx on public.conversations (brand_id, last_message_at desc nulls last);
create index conversations_customer_idx on public.conversations (customer_id);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  conversation_id uuid not null,
  sender_type text not null check (sender_type in ('customer', 'agent', 'system')),
  sender_id uuid references public.profiles (id) on delete set null,
  body text not null default '' check (char_length(body) <= 4000),
  client_message_id text,
  ai_generation_id uuid, -- FK added after ai_generations exists
  delivered_at timestamptz not null default now(),
  read_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (conversation_id, brand_id) references public.conversations (id, brand_id) on delete cascade,
  unique (conversation_id, client_message_id)
);
create index messages_conversation_idx on public.messages (conversation_id, created_at);

create table public.message_attachments (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  conversation_id uuid not null,
  message_id uuid references public.messages (id) on delete cascade,
  uploaded_by uuid references public.profiles (id) on delete set null,
  storage_path text not null unique,
  mime_type text not null check (mime_type in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 5242880),
  created_at timestamptz not null default now(),
  foreign key (conversation_id, brand_id) references public.conversations (id, brand_id) on delete cascade
);
create index message_attachments_message_idx on public.message_attachments (message_id);
create index message_attachments_conversation_idx on public.message_attachments (conversation_id);

create or replace function public.touch_conversation_on_message() returns trigger
language plpgsql as $$
begin
  update public.conversations set last_message_at = new.created_at where id = new.conversation_id;
  return new;
end $$;
create trigger messages_touch_conversation after insert on public.messages
  for each row execute function public.touch_conversation_on_message();

-- ---------------------------------------------------------------------------
-- Knowledge base (+ immutable version snapshots)
-- ---------------------------------------------------------------------------
create table public.knowledge_base (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands (id) on delete cascade,
  title text not null check (char_length(title) between 3 and 200),
  category text not null check (category in (
    'return_policy', 'refund_policy', 'shipping_policy', 'cancellation_policy', 'damaged_products',
    'missing_products', 'delivery_problems', 'payment_issues', 'warranty', 'product_information',
    'faq', 'general_support')),
  content text not null check (char_length(content) between 10 and 8000),
  conditions jsonb,
  content_hash text not null default '',
  version integer not null default 1,
  is_active boolean not null default true,
  archived_at timestamptz,
  embedding extensions.vector(1536),
  embedded_hash text, -- content_hash the current embedding was computed from
  embedding_model text,
  embedding_status text not null default 'pending' check (embedding_status in ('pending', 'ready', 'failed')),
  embedding_error text,
  fts tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B')
  ) stored,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, brand_id)
);
create index knowledge_base_brand_idx on public.knowledge_base (brand_id, category) where archived_at is null;
create index knowledge_base_fts_idx on public.knowledge_base using gin (fts);
-- HNSW: works on an empty table and needs no training step (unlike IVFFlat); fine for thousands of rows.
create index knowledge_base_embedding_idx on public.knowledge_base
  using hnsw (embedding extensions.vector_cosine_ops);

create table public.knowledge_base_versions (
  id uuid primary key default gen_random_uuid(),
  kb_id uuid not null references public.knowledge_base (id) on delete cascade,
  brand_id uuid not null,
  version integer not null,
  title text not null,
  category text not null,
  content text not null,
  conditions jsonb,
  content_hash text not null,
  is_active boolean not null,
  changed_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (kb_id, version)
);

-- Content hash and version are authoritative in the database so they cannot drift from the content.
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
    -- A content change invalidates the stored embedding until it is regenerated.
    if new.content_hash is distinct from old.content_hash then
      if new.embedded_hash is not distinct from old.embedded_hash then
        new.embedding_status := 'pending';
        new.embedding_error := null;
      end if;
    end if;
    new.updated_at := now();
  end if;
  return new;
end $$;
create trigger knowledge_base_before_write before insert or update on public.knowledge_base
  for each row execute function public.kb_before_write();

create or replace function public.kb_snapshot() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.version is distinct from old.version then
    insert into public.knowledge_base_versions
      (kb_id, brand_id, version, title, category, content, conditions, content_hash, is_active, changed_by)
    values
      (new.id, new.brand_id, new.version, new.title, new.category, new.content, new.conditions,
       new.content_hash, new.is_active and new.archived_at is null,
       nullif(current_setting('app.actor_id', true), '')::uuid);
  end if;
  return new;
end $$;
create trigger knowledge_base_snapshot after insert or update on public.knowledge_base
  for each row execute function public.kb_snapshot();

-- Versions are immutable.
create or replace function public.forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% on % is not allowed (append-only)', tg_op, tg_table_name;
end $$;
create trigger knowledge_base_versions_immutable before update or delete on public.knowledge_base_versions
  for each row execute function public.forbid_mutation();

-- ---------------------------------------------------------------------------
-- AI generations, sources, draft events, escalations
-- ---------------------------------------------------------------------------
create table public.ai_generations (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  conversation_id uuid not null,
  trigger_message_id uuid references public.messages (id) on delete set null,
  requested_by uuid references public.profiles (id) on delete set null,
  parent_generation_id uuid references public.ai_generations (id) on delete set null,
  status text not null default 'draft' check (status in
    ('draft', 'edited', 'approved', 'sent', 'discarded', 'superseded', 'withheld', 'failed')),
  intent text,
  language text,
  search_query text,
  original_body text not null default '',
  current_body text not null default '',
  final_message_id uuid references public.messages (id) on delete set null,
  model text,
  prompt_tokens integer,
  completion_tokens integer,
  latency_ms integer,
  error_code text,
  error_message text,
  escalate boolean not null default false,
  guardrails jsonb not null default '[]'::jsonb,
  eligibility jsonb not null default '[]'::jsonb,
  order_facts jsonb,
  image_evidence jsonb,
  graph_trace jsonb not null default '[]'::jsonb,
  approved_by uuid references public.profiles (id) on delete set null,
  approved_at timestamptz,
  sent_by uuid references public.profiles (id) on delete set null,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (conversation_id, brand_id) references public.conversations (id, brand_id) on delete cascade
);
create index ai_generations_conversation_idx on public.ai_generations (conversation_id, created_at desc);
create index ai_generations_brand_idx on public.ai_generations (brand_id, created_at desc);
create trigger ai_generations_updated before update on public.ai_generations
  for each row execute function public.set_updated_at();

alter table public.messages
  add constraint messages_ai_generation_fk foreign key (ai_generation_id)
  references public.ai_generations (id) on delete set null;

create table public.ai_generation_sources (
  generation_id uuid not null references public.ai_generations (id) on delete cascade,
  kb_id uuid not null references public.knowledge_base (id) on delete restrict,
  kb_version integer not null,
  title text not null,
  rank integer not null,
  vector_score double precision,
  text_score double precision,
  fused_score double precision not null,
  primary key (generation_id, kb_id)
);
create index ai_generation_sources_kb_idx on public.ai_generation_sources (kb_id);

create table public.ai_draft_events (
  id uuid primary key default gen_random_uuid(),
  generation_id uuid not null references public.ai_generations (id) on delete cascade,
  brand_id uuid not null references public.brands (id) on delete cascade,
  actor_id uuid references public.profiles (id) on delete set null,
  event_type text not null,
  from_status text,
  to_status text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index ai_draft_events_generation_idx on public.ai_draft_events (generation_id, created_at);
create trigger ai_draft_events_immutable before update or delete on public.ai_draft_events
  for each row execute function public.forbid_mutation();

create table public.escalation_requests (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  conversation_id uuid not null,
  generation_id uuid references public.ai_generations (id) on delete set null,
  reason text not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  foreign key (conversation_id, brand_id) references public.conversations (id, brand_id) on delete cascade
);
create index escalation_requests_brand_idx on public.escalation_requests (brand_id, status);

-- ---------------------------------------------------------------------------
-- RLS on everywhere, from the start (policies are added in the next migration; until then: deny all)
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.brands enable row level security;
alter table public.brand_settings enable row level security;
alter table public.brand_memberships enable row level security;
alter table public.customers enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.message_attachments enable row level security;
alter table public.knowledge_base enable row level security;
alter table public.knowledge_base_versions enable row level security;
alter table public.ai_generations enable row level security;
alter table public.ai_generation_sources enable row level security;
alter table public.ai_draft_events enable row level security;
alter table public.escalation_requests enable row level security;
