-- namici-ci : channel-agnostic chat interface for n8n workflows
-- Single tenant. Everyone who can log in is staff; customers live on
-- Telegram/WhatsApp/etc and never touch this database directly.

create table conversations (
  id               uuid primary key default gen_random_uuid(),
  channel          text not null,               -- telegram | whatsapp | web | ...
  external_chat_id text not null,               -- the id that platform uses
  contact_name     text,
  contact_handle   text,                        -- @username, phone, etc
  mode             text not null default 'ai'   -- ai | human
                   check (mode in ('ai','human')),
  last_message_at  timestamptz not null default now(),
  unread           integer not null default 0,
  created_at       timestamptz not null default now(),
  unique (channel, external_chat_id)
);

create table messages (
  id              bigserial primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  role            text not null check (role in ('customer','ai','agent')),
  body            text not null,
  created_at      timestamptz not null default now()
);

create index on conversations (last_message_at desc);
create index on messages (conversation_id, created_at);

-- Row level security -------------------------------------------------------
-- n8n talks to this database only through the API routes, which use the
-- service role key and bypass RLS. The browser only ever holds the anon key,
-- so these policies are what stand between a logged-out visitor and the inbox.

alter table conversations enable row level security;
alter table messages      enable row level security;

create policy "staff read conversations"  on conversations for select to authenticated using (true);
create policy "staff write conversations" on conversations for update to authenticated using (true) with check (true);
create policy "staff read messages"       on messages      for select to authenticated using (true);

-- Live updates for the list and the open chat window
alter publication supabase_realtime add table messages;
alter publication supabase_realtime add table conversations;
