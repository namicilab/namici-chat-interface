# namici-ci

A chat inbox for n8n workflows. Your bot answers in n8n; when a person needs to
step in, they take the conversation over from here and reply **in the same chat
window the customer is already using** — same Telegram thread, same WhatsApp
conversation, no second contact.

It is channel-agnostic on purpose. namici-ci never talks to Telegram or
WhatsApp itself; n8n does. So it works with any chat platform your workflow
already supports, and adding a platform means changing the workflow, not this.

Free and MIT. If you would rather not install it, we host it for you.

---

## How it fits together

```
Customer on Telegram / WhatsApp / …
        │
        ▼
   n8n workflow  ──writes──▶  Supabase  ──Realtime──▶  namici-ci inbox
        │                    (conversation, message,
        │                     preview, unread; reads mode)
        ▼
   mode = ai     →  run the agent  →  reply to the customer
                                   →  write the reply to `messages` (so the
                                      operator sees what the bot said)

   mode = human  →  stop. A human owns this chat.


Operator replies in namici-ci
        │
        ▼
   POST /api/reply  ──▶  n8n outbound webhook  ──▶  delivered on the original platform
```

namici-ci itself has one API route, `/api/reply`, for messages staff send from
the inbox. Everything inbound is written by n8n straight into Supabase, and
the inbox picks it up over Realtime.

The handoff flag is the `chat_handoffs` table, keyed by `conversations.id`.
n8n reads the newest `active` row for the conversation on every inbound
message: while one exists and has not passed `expires_at`, the bot does not
run. *Take over* opens a row, *Hand back to AI* closes it, and when the bot
cannot answer n8n opens one itself with an expiry. `conversations.mode` mirrors
the flag so the inbox can show who has each chat.

---

## Setup

### 1. Supabase

Create a project, open **SQL Editor**, and run the migrations in
`supabase/migrations/` in order — `0001_init.sql`, `0002_last_preview.sql`,
`0003_media.sql`, `0004_chat_handoffs.sql`. `0003` also creates the
`chat-media` storage bucket.

Then create your staff logins under **Authentication → Users**. Anyone who can
sign in can work the inbox — this is a single-tenant install, one deployment
per business.

### 2. The app

```bash
cp .env.example .env.local     # fill in the four values
npm install
npm run dev
```

| Variable | Where it comes from |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same page, the **anon** key |
| `SUPABASE_SERVICE_ROLE_KEY` | same page, the **service role** key. Server only. |
| `N8N_OUTBOUND_WEBHOOK_URL` | the webhook in step 3b |

That is enough to run it locally. For a server, see **Deploying** below.

### 3. The two n8n workflows

**a. Inbound** — one per chat platform. n8n needs a Supabase credential with
the **service role** key, since it writes past row level security.

```
Telegram Trigger
  → Supabase REST  POST /rest/v1/conversations?on_conflict=channel,external_chat_id
      header  Prefer: resolution=merge-duplicates,return=representation
      body    { channel, external_chat_id, contact_name, contact_handle, last_message_at }
      → returns the row, including id, mode and unread
  → Supabase REST  POST /rest/v1/messages
      body    { conversation_id, role: 'customer', kind, body, media_url }
  → Supabase REST  PATCH /rest/v1/conversations?id=eq.<id>
      body    { last_message_at, last_preview, unread: unread + 1 }
  → IF  mode == 'ai'
      true → your AI Agent
           → Telegram: send the reply
           → Supabase REST POST /rest/v1/messages
                { conversation_id, role: 'ai', kind: 'text', body }
      false → stop. A human has it.
```

Photos: download the file from Telegram, upload it to the `chat-media` bucket
(`POST /storage/v1/object/chat-media/<path>`), and save the message with
`kind: 'image'` and the public URL as `media_url`.

**b. Outbound** — one, shared by every platform.

```
Webhook  POST /webhook/namici-outbound      ← this is N8N_OUTBOUND_WEBHOOK_URL
  → Switch on {{ $json.body.kind }}
      text  → Telegram: Send Message
                 chatId = {{ $json.body.externalChatId }}
                 text   = {{ $json.body.text }}
      image → Telegram: Send Photo
                 chatId    = {{ $json.body.externalChatId }}
                 binaryData = false
                 imageUrl  = {{ $json.body.mediaUrl }}
                 caption   = {{ $json.body.text }}
```

Add a second Switch on `{{ $json.body.channel }}` when you add WhatsApp.

Adding a platform is one branch here and one inbound workflow. namici-ci does
not change.

---

## Deploying

Vercel takes it as-is — push the repo and set the same four variables.
To run it on your own box:

### PM2

```bash
npm run build
pm2 start ecosystem.config.js
pm2 save && pm2 startup      # bring it back after a reboot
```

It listens on **port 3009**, set in `ecosystem.config.js` and nowhere else —
`next start` reads `PORT` from the environment, so there is no port baked into
`package.json` to drift out of step with it. Change the port there.

| | |
| --- | --- |
| Logs | `pm2 logs namici-ci`, or `logs/out.log` and `logs/error.log` |
| Restart after a change | `npm run build && pm2 restart namici-ci` |
| Status | `pm2 status` |

`.env.local` is read at startup, so **edit it and then restart** — PM2 will not
pick up new values on its own.

Put a reverse proxy in front of it for TLS. Whatever public URL you give it is
what goes in the n8n **Namici Config** node, not `localhost:3009` — n8n has to
reach it from wherever n8n runs.

### nginx

PM2 keeps it on `127.0.0.1:3009`. nginx gives it a domain and TLS.

**1.** `/etc/nginx/sites-available/namici-ci`:

```nginx
server {
    listen 80;
    server_name chat.example.com;          # your domain

    # Next fingerprints these filenames, so they can be cached hard.
    location /_next/static/ {
        proxy_pass http://127.0.0.1:3009;
        proxy_cache_valid 200 60m;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    location / {
        proxy_pass http://127.0.0.1:3009;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;

        proxy_read_timeout 60s;
    }
}
```

**2.** Enable it and check the syntax before reloading:

```bash
sudo ln -s /etc/nginx/sites-available/namici-ci /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

**3.** TLS. Certbot rewrites the block above to add the certificate and an
HTTP-to-HTTPS redirect:

```bash
sudo certbot --nginx -d chat.example.com
```

Then `https://chat.example.com` is the URL for the n8n **Namici Config** node.

#### Things that bite

**`X-Forwarded-Proto` is not optional.** Without it the app believes it is on
plain HTTP behind your TLS, and Supabase auth cookies set with the `Secure`
flag are dropped — staff log in, get bounced straight back to `/login`, and
nothing in the logs explains why.

**No WebSocket block is needed.** Supabase Realtime connects from the
browser straight to Supabase, not through nginx, so the usual
`Upgrade`/`Connection` dance does not apply here. Leaving it out is correct,
not an omission.

**Guard the service role key.** n8n holds it to write inbound messages, and it
bypasses every RLS policy. Keep it in n8n's credential store only.

## API

One route, JSON in and out.

| Route | Auth | Body | Returns |
| --- | --- | --- | --- |
| `POST /api/reply` | staff session | `conversationId`, `text`, `kind?`, `mediaUrl?` | `{ ok, delivered, deliveryError }` |

Send `text`, `mediaUrl`, or both. A message with a `mediaUrl` is stored as an
image and the text becomes its caption. The outbound webhook receives
`kind` (`text` or `image`) and `mediaUrl` so your workflow knows which send
node to use.

`/api/reply` **saves before it sends**. If n8n is down you get
`delivered:false` and the message is still in the thread, so you know to retry
rather than wondering whether it went out twice.

---

## Behaviour worth knowing

- **Typing takes the chat over.** An operator who sends a message switches the
  conversation to `human` automatically. Leaving it on `ai` would let the bot
  answer the customer's next message over the top of them.
- **Hand back deliberately.** A takeover from the inbox stays until someone
  presses *Hand back to AI*. A handoff the bot opened itself expires after
  the hours set in the n8n workflow, and the bot answers again.
- **New messages arrive over a WebSocket, not a poll.** Supabase Realtime
  publishes the row change and the browser already has the socket open, so an
  idle tab makes no requests at all. This is why the migration runs
  `alter publication supabase_realtime add table messages` — without it
  Postgres never publishes and the inbox looks broken while the data is fine.
- **Unread clears when you open a chat**, not only when you reply, and the
  total shows in the tab title as `(3) namici-ci`.
- **The bell in the sidebar turns on alerts** — a short two-note chime plus a
  desktop notification when the tab is in the background. The choice is
  remembered per browser. It stays silent for the conversation you already
  have open and focused, and never fires for the bot's own replies.
- **Scroll up to load older messages.** The thread opens with the newest 30
  and fetches the next 30 each time you reach the top, keeping your place
  rather than jumping.
- **The `chat-media` bucket is public.** Telegram and WhatsApp fetch an image
  by URL when sending it, so the link has to work without a token. Signed URLs
  would be more private but expire, which would break every image already in
  the thread. Do not put anything confidential in there.
- **WhatsApp's 24-hour rule still applies.** Outside 24 hours from the
  customer's last message only approved templates send. namici-ci will show
  the reply as saved and `delivered:false`.

---

## Licence

MIT. Use it, change it, run it for clients, sell what you build with it.
