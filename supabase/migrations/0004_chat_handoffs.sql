-- Which chats a human owns. n8n reads the newest 'active' row for a
-- conversation before running the bot; no row, or one past expires_at, means
-- the bot answers.
--
-- chat_id holds conversations.id, not the platform's chat id: Telegram gives a
-- user the same chat id with every bot, so two bots sharing this table would
-- otherwise read each other's handoffs.
--
-- A row is appended per handoff rather than upserted, so the history survives.
-- Handing back sets status to 'closed'; n8n sets 'expired' when expires_at
-- passes. Operator takeovers have no expiry.

create table if not exists chat_handoffs (
  id          bigserial primary key,
  chat_id     text not null,
  status      text not null default 'active',
  reason      text,
  operator_id text,
  started_at  timestamptz not null default now(),
  expires_at  timestamptz
);

create index if not exists chat_handoffs_lookup on chat_handoffs (chat_id, started_at desc);

-- The inbox opens and closes handoffs from the browser with the anon key, so
-- staff need their own policies. n8n uses the service role and bypasses these.
alter table chat_handoffs enable row level security;

drop policy if exists "staff read handoffs" on chat_handoffs;
create policy "staff read handoffs" on chat_handoffs for select to authenticated using (true);

drop policy if exists "staff open handoffs" on chat_handoffs;
create policy "staff open handoffs" on chat_handoffs for insert to authenticated with check (true);

drop policy if exists "staff close handoffs" on chat_handoffs;
create policy "staff close handoffs" on chat_handoffs for update to authenticated using (true) with check (true);
