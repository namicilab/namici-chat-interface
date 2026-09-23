-- Messages can carry an image as well as text.

alter table messages add column if not exists kind text not null default 'text';
alter table messages add column if not exists media_url text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'messages_kind_check') then
    alter table messages add constraint messages_kind_check check (kind in ('text', 'image'));
  end if;
end $$;

-- Bucket the inbox uploads to.
--
-- It is PUBLIC on purpose: Telegram and WhatsApp fetch an image by URL when
-- sending it, so the link has to be reachable without a token. Signed URLs
-- would be more private but expire, which would break every image already in
-- the thread. Do not put anything confidential in here.

insert into storage.buckets (id, name, public)
values ('chat-media', 'chat-media', true)
on conflict (id) do nothing;

drop policy if exists "staff upload chat media" on storage.objects;
create policy "staff upload chat media" on storage.objects
  for insert to authenticated with check (bucket_id = 'chat-media');

drop policy if exists "anyone reads chat media" on storage.objects;
create policy "anyone reads chat media" on storage.objects
  for select to public using (bucket_id = 'chat-media');
