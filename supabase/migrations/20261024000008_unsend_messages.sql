-- Unsend: a message can be withdrawn by its sender. The row stays as a tombstone (so the conversation keeps its
-- shape and the other side sees "unsent"), but its text and attachments are removed.
alter table public.messages
  add column unsent_at timestamptz,
  add column unsent_by uuid references public.profiles (id) on delete set null;

-- The inbox preview and unread badge must ignore unsent messages.
create or replace view public.conversation_list with (security_invoker = true) as
select c.id,
       c.brand_id,
       b.name as brand_name,
       c.customer_id,
       cu.name as customer_name,
       c.order_id,
       c.status,
       c.created_at,
       lm.body as last_message_body,
       lm.sender_type as last_message_sender,
       coalesce(c.last_message_at, c.created_at) as last_activity_at,
       c.last_message_at,
       (select count(*) from public.messages m
         where m.conversation_id = c.id and m.sender_type = 'customer' and m.read_at is null
           and m.unsent_at is null) as unread_count
from public.conversations c
join public.brands b on b.id = c.brand_id
join public.customers cu on cu.id = c.customer_id
left join lateral (
  select m.body, m.sender_type from public.messages m
  where m.conversation_id = c.id and m.unsent_at is null order by m.created_at desc limit 1
) lm on true;

revoke all on public.conversation_list from anon;
grant select on public.conversation_list to authenticated, service_role;
