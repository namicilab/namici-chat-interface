-- Inbox upgrades: who sent what, delivery status, assignment, resolve,
-- internal notes, more message types, saved replies, push subscriptions.
--
-- Run after 0005_inbound_rpc.sql. Safe to run again.

-- ── Messages ────────────────────────────────────────────────────────────────

-- Which staff member wrote an agent message or note. Email rather than a
-- foreign key to auth.users, so a deleted login keeps its history readable.
alter table messages add column if not exists sent_by    text;
alter table messages add column if not exists sent_by_id uuid;

-- Delivery as the whole team sees it, not one browser. null on rows from
-- before this migration and on customer/bot messages.
--   pending → sent (n8n accepted) → delivered → read  (the last two only if
--   the channel workflow reports them through namici_message_status)
--   failed  (n8n refused it; the inbox offers Retry)
alter table messages add column if not exists delivery_status text;
alter table messages add column if not exists delivery_error  text;
-- The platform's id for a reply we sent, so a delivered/read receipt from
-- Telegram or WhatsApp can be matched back to the row.
alter table messages add column if not exists external_message_id text;
-- Original file name and type for audio, video and file messages.
alter table messages add column if not exists media_name text;
alter table messages add column if not exists media_mime text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'messages_delivery_status_check') then
    alter table messages add constraint messages_delivery_status_check
      check (delivery_status in ('pending', 'sent', 'delivered', 'read', 'failed'));
  end if;
end $$;

-- 'note' is an internal note: staff see it in the thread, the customer and
-- the bot never do.
alter table messages drop constraint if exists messages_kind_check;
alter table messages add constraint messages_kind_check
  check (kind in ('text', 'image', 'audio', 'video', 'file', 'location', 'note'));

create index if not exists messages_created_at_idx on messages (created_at);
create index if not exists messages_external_id_idx on messages (external_message_id)
  where external_message_id is not null;

-- ── Conversations ───────────────────────────────────────────────────────────

alter table conversations add column if not exists status       text not null default 'open';
alter table conversations add column if not exists resolved_at  timestamptz;
alter table conversations add column if not exists assigned_to  text;          -- staff email
alter table conversations add column if not exists last_customer_at timestamptz; -- waiting time, WhatsApp 24h window
alter table conversations add column if not exists tags         text[] not null default '{}';
alter table conversations add column if not exists contact_note text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'conversations_status_check') then
    alter table conversations add constraint conversations_status_check check (status in ('open', 'resolved'));
  end if;
end $$;

update conversations c
   set last_customer_at = m.at
  from (select conversation_id, max(created_at) as at from messages where role = 'customer' group by 1) m
 where m.conversation_id = c.id and c.last_customer_at is null;

create index if not exists conversations_status_idx   on conversations (status, last_message_at desc);
create index if not exists conversations_assigned_idx on conversations (assigned_to, last_message_at desc);

-- The thread shows why the bot handed over; it reads the newest handoff.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and tablename = 'chat_handoffs') then
    alter publication supabase_realtime add table chat_handoffs;
  end if;
end $$;

-- ── Saved replies ───────────────────────────────────────────────────────────

create table if not exists saved_replies (
  id         bigserial primary key,
  shortcut   text not null,          -- typed after "/" in the composer
  body       text not null,          -- {name} becomes the contact's first name
  created_by text,
  created_at timestamptz not null default now()
);

alter table saved_replies enable row level security;

drop policy if exists "staff manage saved replies" on saved_replies;
create policy "staff manage saved replies" on saved_replies
  for all to authenticated using (true) with check (true);

-- ── Push subscriptions ──────────────────────────────────────────────────────
-- One row per browser that turned alerts on. The server reads them with the
-- service role to send Web Push; staff only ever see their own.

create table if not exists push_subscriptions (
  id         bigserial primary key,
  user_id    uuid not null default auth.uid(),
  email      text,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);

alter table push_subscriptions enable row level security;

drop policy if exists "own push subscriptions" on push_subscriptions;
create policy "own push subscriptions" on push_subscriptions
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── Inbound, again ──────────────────────────────────────────────────────────
-- Same as 0005, plus:
--   * internal notes are left out of the history handed to the bot
--   * p_kind is honoured (audio, video, file, location), with p_media_name
--   * a customer message reopens a resolved conversation and records
--     last_customer_at
--   * an expired handoff also releases the assignee
--
-- Dropped first because the argument list grew: two overloads would make
-- PostgREST's named-argument call ambiguous.

drop function if exists namici_inbound(text, text, text, text, text, text, text, text, timestamptz, text, int);

create or replace function namici_inbound(
  p_channel          text,
  p_external_chat_id text,
  p_text             text        default '',
  p_kind             text        default 'text',
  p_media_url        text        default null,
  p_contact_name     text        default null,
  p_contact_handle   text        default null,
  p_role             text        default 'customer',
  p_received_at      timestamptz default null,
  p_source_ref       text        default null,
  p_history          int         default 20,
  p_media_name       text        default null
) returns jsonb
language plpgsql as $$
declare
  v_at        timestamptz := coalesce(p_received_at, now());
  v_kind      text;
  v_preview   text;
  v_convo     conversations;
  v_msg_id    bigint;
  v_duplicate boolean := false;
  v_handoff   chat_handoffs;
  v_state     text := 'none';
  v_history   jsonb;
begin
  if coalesce(p_channel, '') = '' or coalesce(p_external_chat_id, '') = '' then
    raise exception 'p_channel and p_external_chat_id are required';
  end if;
  if p_role not in ('customer', 'ai') then
    raise exception 'p_role must be customer or ai';
  end if;

  v_kind := coalesce(nullif(p_kind, ''), 'text');
  if v_kind = 'text' and coalesce(p_media_url, '') <> '' then v_kind := 'image'; end if;
  if v_kind not in ('text', 'image', 'audio', 'video', 'file', 'location') then v_kind := 'text'; end if;

  v_preview := left(case v_kind
                      when 'image'    then '📷 ' || coalesce(nullif(p_text, ''), 'Photo')
                      when 'audio'    then '🎤 ' || coalesce(nullif(p_text, ''), 'Voice message')
                      when 'video'    then '🎬 ' || coalesce(nullif(p_text, ''), 'Video')
                      when 'file'     then '📎 ' || coalesce(nullif(p_text, ''), p_media_name, 'File')
                      when 'location' then '📍 ' || coalesce(nullif(p_text, ''), 'Location')
                      else coalesce(p_text, '') end, 140);

  insert into conversations as c (channel, external_chat_id, contact_name, contact_handle, last_message_at)
  values (p_channel, p_external_chat_id, p_contact_name, p_contact_handle, v_at)
  on conflict (channel, external_chat_id) do update
    set contact_name   = coalesce(excluded.contact_name, c.contact_name),
        contact_handle = coalesce(nullif(excluded.contact_handle, ''), c.contact_handle)
  returning * into v_convo;

  if p_source_ref is not null then
    select m.id into v_msg_id from messages m where m.source_ref = p_source_ref;
    v_duplicate := v_msg_id is not null;
  end if;

  if not v_duplicate then
    insert into messages (conversation_id, role, kind, body, media_url, media_name, created_at, source_ref)
    values (v_convo.id, p_role, v_kind, coalesce(p_text, ''), nullif(p_media_url, ''), nullif(p_media_name, ''),
            v_at, p_source_ref)
    returning id into v_msg_id;

    -- A replayed message older than what the inbox already shows must not
    -- replace the preview or jump the conversation to the top.
    update conversations c
       set unread           = c.unread + case when p_role = 'customer' then 1 else 0 end,
           last_preview     = case when v_at >= c.last_message_at then v_preview else c.last_preview end,
           last_message_at  = greatest(c.last_message_at, v_at),
           last_customer_at = case when p_role = 'customer'
                                   then greatest(coalesce(c.last_customer_at, v_at), v_at)
                                   else c.last_customer_at end,
           status           = case when p_role = 'customer' then 'open' else c.status end,
           resolved_at      = case when p_role = 'customer' then null else c.resolved_at end
     where c.id = v_convo.id
    returning * into v_convo;
  end if;

  select * into v_handoff
    from chat_handoffs h
   where h.chat_id = v_convo.id::text and h.status = 'active'
   order by h.started_at desc
   limit 1;

  if found then
    if v_handoff.expires_at is not null and v_handoff.expires_at <= now() then
      update chat_handoffs set status = 'expired' where id = v_handoff.id;
      update conversations c set mode = 'ai', assigned_to = null where c.id = v_convo.id returning * into v_convo;
      v_state := 'expired';
    else
      v_state := 'active';
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('role', h.role, 'kind', h.kind, 'body', h.body, 'at', h.created_at) order by h.created_at), '[]'::jsonb)
    into v_history
    from (select m.role, m.kind, m.body, m.created_at
            from messages m
           where m.conversation_id = v_convo.id and m.id <> v_msg_id and m.kind <> 'note'
           order by m.created_at desc
           limit greatest(p_history, 0)) h;

  return jsonb_build_object(
    'conversation_id',   v_convo.id,
    'message_id',        v_msg_id,
    'duplicate',         v_duplicate,
    'mode',              v_convo.mode,
    'handoff_state',     v_state,
    'bot_should_answer', v_state <> 'active' and p_role = 'customer' and not v_duplicate,
    'history',           v_history
  );
end $$;

-- ── Delivery receipts from the channel ──────────────────────────────────────
-- n8n calls this when Telegram/WhatsApp reports a reply as delivered or read.
-- Identify the message by our id, or by channel + the platform's message id
-- (the outbound webhook can return it as externalMessageId). Status only
-- moves forward: a late "delivered" never overwrites "read".

create or replace function namici_message_status(
  p_status              text,
  p_message_id          bigint default null,
  p_channel             text   default null,
  p_external_message_id text   default null,
  p_error               text   default null
) returns jsonb
language plpgsql as $$
declare
  v_rank   int := case p_status when 'pending' then 0 when 'sent' then 1 when 'failed' then 1
                                when 'delivered' then 2 when 'read' then 3 end;
  v_count  int;
begin
  if v_rank is null then raise exception 'p_status must be pending, sent, delivered, read or failed'; end if;

  update messages m
     set delivery_status = p_status,
         delivery_error  = case when p_status = 'failed' then left(p_error, 300) else null end
    from conversations c
   where c.id = m.conversation_id
     and m.role = 'agent'
     and (  (p_message_id is not null and m.id = p_message_id)
         or (p_message_id is null and m.external_message_id = p_external_message_id
             and (p_channel is null or c.channel = p_channel)))
     and coalesce(case m.delivery_status when 'pending' then 0 when 'sent' then 1 when 'failed' then 1
                                         when 'delivered' then 2 when 'read' then 3 end, 0) <= v_rank;
  get diagnostics v_count = row_count;
  return jsonb_build_object('updated', v_count);
end $$;

revoke all on function namici_inbound(text, text, text, text, text, text, text, text, timestamptz, text, int, text) from public, anon, authenticated;
revoke all on function namici_message_status(text, bigint, text, text, text) from public, anon, authenticated;
grant execute on function namici_inbound(text, text, text, text, text, text, text, text, timestamptz, text, int, text) to service_role;
grant execute on function namici_message_status(text, bigint, text, text, text) to service_role;
