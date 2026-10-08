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
   n8n workflow  ──rpc/namici_inbound──▶  Supabase  ──Realtime──▶  namici-ci inbox
        │          (saves the message, returns
        │           bot_should_answer + history)
        ▼
   bot_should_answer  →  run the agent  →  reply to the customer
                                        →  rpc/namici_bot_reply (so the operator
                                           sees what the bot said; can hand off)

   otherwise          →  stop. A human owns this chat.


Operator replies in namici-ci
        │
        ▼
   POST /api/reply  ──▶  n8n outbound webhook  ──▶  delivered on the original platform
```

namici-ci itself has one API route, `/api/reply`, for messages staff send from
the inbox. Everything inbound goes through two Postgres functions in Supabase
(`0005_inbound_rpc.sql`), and the inbox picks it up over Realtime. They live in
the database, not the Next.js app, so the bot keeps working while the inbox is
down.

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
`0003_media.sql`, `0004_chat_handoffs.sql`, `0005_inbound_rpc.sql`,
`0006_inbox_upgrades.sql`. `0003` also creates the `chat-media` storage
bucket. Every file is safe to run again.

Then create your staff logins under **Authentication → Users**. Anyone who can
sign in can work the inbox — this is a single-tenant install, one deployment
per business.

### 2. The app

```bash
cp .env.example .env.local     # fill in the four required values
npm install
npm run dev
```

| Variable | Where it comes from |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same page, the **anon** key |
| `SUPABASE_SERVICE_ROLE_KEY` | same page, the **service role** key. Server only. |
| `N8N_OUTBOUND_WEBHOOK_URL` | the webhook in step 3b |
| `N8N_WEBHOOK_SECRET` | optional, any long random string. Sent as `x-namici-secret` (and `x-handover-secret`); have the workflow reject requests without it. |
| `N8N_SUGGEST_WEBHOOK_URL` | optional, see **Suggested replies** |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `PUSH_WEBHOOK_SECRET` | optional, see **Push alerts** |

That is enough to run it locally. For a server, see **Deploying** below.

### 3. The two n8n workflows

**a. Inbound** — one per chat platform. n8n needs a Supabase credential with
the **service role** key; the functions are not callable with the anon key.

```
Telegram Trigger
  → POST /rest/v1/rpc/namici_inbound
      { p_channel, p_external_chat_id, p_text, p_media_url?, p_contact_name?,
        p_contact_handle?, p_source_ref? }
      → { conversation_id, bot_should_answer, handoff_state, mode, history[] }
  → IF bot_should_answer
      true → your AI Agent (history is the last 20 messages, oldest first)
           → Telegram: send the reply
           → POST /rest/v1/rpc/namici_bot_reply
                { p_conversation_id, p_text, p_handoff_reason?, p_handoff_hours? }
                → { message_id, handoff_opened }
      false → stop. A human has it.
```

`namici_inbound` does in one transaction what used to take a node per table:
upserts the conversation, saves the message, bumps unread and the preview,
closes an expired handoff, and returns the chat history. Set
`p_handoff_reason` on `namici_bot_reply` and the chat goes to a human
(`chat_handoffs` row plus `mode = 'human'`).

Photos: download the file from Telegram, upload it to the `chat-media` bucket
(`POST /storage/v1/object/chat-media/<path>`), and pass the public URL as
`p_media_url`.

**Replaying messages after an outage.** Pass `p_source_ref` (e.g.
`telegram:<update_id>`) and the original time as `p_received_at`. A message
with a `source_ref` that already exists is skipped, so a replay that half
succeeded never duplicates. Replayed messages keep their original time and
do not overwrite a newer preview. Bot replies are replayed with
`p_role: 'ai'`. `POST /rest/v1/rpc/namici_ping` is the health check.

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

The body is
`{ conversationId, messageId, channel, externalChatId, kind, text, mediaUrl, fileName, mimeType }`,
where `kind` is `text`, `image`, `audio`, `video` or `file`. Add branches for
the kinds your platform supports (Telegram: Send Audio / Send Video / Send
Document, all by URL).

Answer with `{ "externalMessageId": "<the platform's message id>" }` from a
**Respond to Webhook** node if you want delivered/read ticks (see
**Delivery receipts**). Anything else, or nothing, is fine too.

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

JSON in and out.

| Route | Auth | Body | Returns |
| --- | --- | --- | --- |
| `POST /api/reply` | staff session | `conversationId`, `text`, `kind?`, `mediaUrl?`, `fileName?`, `mimeType?` | `{ ok, messageId, delivered, deliveryError }` |
| `POST /api/reply` | staff session | `retryMessageId` | same; re-delivers a stored reply without saving it again |
| `POST /api/suggest` | staff session | `conversationId` | `{ text }` |
| `GET /api/team` | staff session | — | `{ staff, suggest, push, vapidPublicKey }` |
| `POST /api/push` | `x-push-secret` | Supabase Database Webhook payload | `{ ok, sent }` |

`kind` is `text`, `image`, `audio`, `video`, `file` or `note`. A media kind
needs a `mediaUrl` and the text becomes its caption. A `note` is stored for
staff and never sent to n8n.

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
  desktop notification when the tab is in the background (and Web Push with
  the tab closed, if configured). The choice is
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
  customer's last message only approved templates send. The header counts
  the window down, and sending after it closes asks first.
- **Ownership.** Taking over or replying claims an unowned chat; it never
  takes a colleague's. *Hand back to AI* releases it. Tabs: **Mine**,
  **Unassigned**, **Waiting** (a human owns it and the customer is waiting —
  longest wait first), **Resolved**.
- **Resolve** hands the chat back to the bot and files it under Resolved. A
  new customer message reopens it.
- **Notes** (the *Note* tab in the composer) are for the team: yellow in the
  thread, never sent to the customer, and left out of the history the bot
  sees.
- **Saved replies**: type `/` in the composer. `{name}` becomes the
  customer's first name. Manage them from the bookmark icon in the sidebar.
- **Presence.** The header shows when a colleague is viewing or typing in the
  same chat, so two people don't answer at once.
- **Catching up.** Realtime does not replay what it missed while a laptop
  slept, so the inbox refetches when the tab wakes, the network returns or
  the socket reconnects, and once a minute while visible.
- **Keyboard**: `↑`/`↓` (or `Alt+↑`/`↓` while typing) move between chats,
  `Esc` goes back, `Ctrl+K` searches.
- **Dark mode** follows the system; the ◐ button in the sidebar overrides it.

---

## Optional features

### Installing it as an app

namici-ci is a Progressive Web App: install it and it opens full screen from
the home screen, like WhatsApp.

- **Android / Chrome / Edge**: menu → *Install app* (the inbox also offers it
  in its ⋮ menu or the sidebar footer).
- **iPhone / iPad**: Safari → Share → *Add to Home Screen*. The inbox shows a
  one-time tip. Web Push on iOS works only once installed this way (iOS 16.4+).

What the installed app does:

- Opens instantly on the last list and chats you saw (kept on the device,
  cleared on sign out), then refreshes. It still opens offline.
- The phone's back button and a swipe from the left edge go back a screen
  instead of closing the app.
- The home-screen icon shows the number of people waiting for a human
  (otherwise the unread count). Long-press the icon for *Waiting* and *Mine*.
- Long-press a message to copy it; tap a photo to view it full screen.
- A bar at the top says when it is offline or reconnecting.

Requires HTTPS (localhost is the exception). After a deploy, open the app
once with a connection to pick up the new version.

### Push alerts (tab closed)

The bell turns on in-tab alerts. With these set it also subscribes the
browser to Web Push, so a phone or desktop is alerted with the inbox closed.
On a phone, add the site to the home screen first (it is an installable app).

1. `npx web-push generate-vapid-keys` → put the two keys in
   `NEXT_PUBLIC_VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`; set `VAPID_SUBJECT`
   to `mailto:` your address and `PUSH_WEBHOOK_SECRET` to a random string.
   Rebuild — the public key is baked into the page.
2. Supabase → **Database → Webhooks → Create**: table `messages`, event
   **Insert**, type HTTP Request, `POST https://<your inbox>/api/push`, header
   `x-push-secret: <PUSH_WEBHOOK_SECRET>`.

A chat with an assignee alerts only them; an unowned one alerts everyone.
Push needs HTTPS (localhost is the exception).

### Suggested replies

Set `N8N_SUGGEST_WEBHOOK_URL` and a **✨ Suggest reply** button appears. It
POSTs `{ conversationId, channel, contactName, history: [{ role, kind, body, at }] }`
(internal notes left out) to that webhook. Run your AI Agent on it and answer
with `{ "text": "…" }` from a Respond to Webhook node. The draft lands in the
composer for the operator to edit; nothing is sent automatically.

### Delivery receipts

Replies show ⏱ while sending, ✓ once n8n accepted them, and *Not delivered ·
Retry* if it did not — stored on the message, so the whole team sees it. For
✓✓ delivered and blue ✓✓ read, have the channel workflow call

```
POST /rest/v1/rpc/namici_message_status   (service role key)
  { p_status: 'delivered' | 'read' | 'failed',
    p_channel: 'whatsapp', p_external_message_id: '<platform id>' }
```

or pass `p_message_id` (our id, from the outbound payload) instead. Status
only moves forward: a late *delivered* never overwrites *read*.

### Voice notes, video, files, locations

`namici_inbound` takes `p_kind` (`audio`, `video`, `file`, `location`) and
`p_media_name` for a file's name. A location is `p_text: 'lat,lng'` or
`'Label|lat,lng'`. Upload media to `chat-media` first, as with photos.

---

## Licence

MIT. Use it, change it, run it for clients, sell what you build with it.
