-- The conversation list shows the latest message under each name. Storing it
-- on the row avoids one query per conversation every time the inbox renders.

alter table conversations add column if not exists last_preview text;
