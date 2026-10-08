-- Inbound as three Postgres functions, so a channel workflow in n8n needs one
-- call per step instead of a node for every table:
--
--   namici_inbound(...)    save a message, read the handoff flag and history
--   namici_bot_reply(...)  save the bot's reply, optionally hand off
--   namici_ping()          health check for the n8n replay poller
--
-- They run inside Supabase, not the Next.js app, so the bot keeps working
-- while the inbox is down. n8n calls them through PostgREST with the service
-- role key: POST /rest/v1/rpc/<name> with the arguments as a JSON object.
--
-- source_ref makes a message idempotent. n8n buffers messages it could not
-- save (Supabase unreachable) and replays them later; a replay that already
-- got through once is skipped instead of saved twice.

alter table messages add column if not exists source_ref text;
create unique index if not exists messages_source_ref on messages (source_ref) where source_ref is not null;

-- ---------------------------------------------------------------------------

create or replace function namici_inbound(
  p_channel          text,
  p_external_chat_id text,
  p_text             text        default '',
  p_kind             text        default 'text',
  p_media_url        text        default null,
  p_contact_name     text        default null,
  p_contact_handle   text        default null,
  p_role             text        default 'customer',   -- 'ai' when replaying a buffered bot reply
  p_received_at      timestamptz default null,         -- original time when replaying
  p_source_ref       text        default null,
  p_history          int         default 20
) returns jsonb
language plpgsql as $$
declare
  v_at        timestamptz := coalesce(p_received_at, now());
  v_kind      text := case when coalesce(p_media_url, '') <> '' then 'image' else coalesce(nullif(p_kind, ''), 'text') end;
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

  v_preview := left(case when v_kind = 'image'
                         then case when coalesce(p_text, '') <> '' then '📷 ' || p_text else '📷 Photo' end
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
    insert into messages (conversation_id, role, kind, body, media_url, created_at, source_ref)
    values (v_convo.id, p_role, v_kind, coalesce(p_text, ''), nullif(p_media_url, ''), v_at, p_source_ref)
    returning id into v_msg_id;

    -- A replayed message older than what the inbox already shows must not
    -- replace the preview or jump the conversation to the top.
    update conversations c
       set unread          = c.unread + case when p_role = 'customer' then 1 else 0 end,
           last_preview    = case when v_at >= c.last_message_at then v_preview else c.last_preview end,
           last_message_at = greatest(c.last_message_at, v_at)
     where c.id = v_convo.id
    returning * into v_convo;
  end if;

  -- The handoff flag: newest active row. An expired one is closed here, so
  -- the bot takes the chat back on the next message.
  select * into v_handoff
    from chat_handoffs h
   where h.chat_id = v_convo.id::text and h.status = 'active'
   order by h.started_at desc
   limit 1;

  if found then
    if v_handoff.expires_at is not null and v_handoff.expires_at <= now() then
      update chat_handoffs set status = 'expired' where id = v_handoff.id;
      update conversations c set mode = 'ai' where c.id = v_convo.id returning * into v_convo;
      v_state := 'expired';
    else
      v_state := 'active';
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('role', h.role, 'kind', h.kind, 'body', h.body, 'at', h.created_at) order by h.created_at), '[]'::jsonb)
    into v_history
    from (select m.role, m.kind, m.body, m.created_at
            from messages m
           where m.conversation_id = v_convo.id and m.id <> v_msg_id
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

-- ---------------------------------------------------------------------------

create or replace function namici_bot_reply(
  p_conversation_id uuid,
  p_text            text,
  p_handoff_reason  text        default null,   -- set it and the chat goes to a human
  p_handoff_hours   int         default 24,
  p_source_ref      text        default null
) returns jsonb
language plpgsql as $$
declare
  v_msg_id bigint;
  v_opened boolean := false;
begin
  if p_source_ref is not null then
    select m.id into v_msg_id from messages m where m.source_ref = p_source_ref;
  end if;

  if v_msg_id is null then
    insert into messages (conversation_id, role, kind, body, source_ref)
    values (p_conversation_id, 'ai', 'text', coalesce(p_text, ''), p_source_ref)
    returning id into v_msg_id;

    update conversations c
       set last_preview = left(coalesce(p_text, ''), 140), last_message_at = now()
     where c.id = p_conversation_id;
  end if;

  if coalesce(p_handoff_reason, '') <> '' then
    insert into chat_handoffs (chat_id, status, reason, expires_at)
    values (p_conversation_id::text, 'active', left(p_handoff_reason, 300),
            case when p_handoff_hours > 0 then now() + make_interval(hours => p_handoff_hours) end);
    update conversations c set mode = 'human' where c.id = p_conversation_id;
    v_opened := true;
  end if;

  return jsonb_build_object('message_id', v_msg_id, 'handoff_opened', v_opened);
end $$;

-- ---------------------------------------------------------------------------

create or replace function namici_ping() returns jsonb
language sql stable as $$
  select jsonb_build_object('ok', true, 'at', now(), 'conversations', (select count(*) from conversations))
$$;

-- Service role only. The browser has no business calling these.
revoke all on function namici_inbound(text, text, text, text, text, text, text, text, timestamptz, text, int) from public, anon, authenticated;
revoke all on function namici_bot_reply(uuid, text, text, int, text) from public, anon, authenticated;
revoke all on function namici_ping() from public, anon, authenticated;
grant execute on function namici_inbound(text, text, text, text, text, text, text, text, timestamptz, text, int) to service_role;
grant execute on function namici_bot_reply(uuid, text, text, int, text) to service_role;
grant execute on function namici_ping() to service_role;
