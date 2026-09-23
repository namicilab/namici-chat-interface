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
   n8n workflow  ──POST /api/inbound──▶  namici-ci   (save + read the AI/human flag)
        │                                    │
        │        ◀──{ forwardToAi }──────────┘
        ▼
   forwardToAi = true  →  run the agent  →  reply to the customer
                                          →  POST /api/bot-message (so the
                                             operator sees what the bot said)

   forwardToAi = false →  stop. A human owns this chat.


Operator replies in namici-ci
        │
        ▼
   POST /api/reply  ──▶  n8n outbound webhook  ──▶  delivered on the original platform
```

The AI/human flag lives in one column, `conversations.mode`. That is the entire
handoff: while it is `human`, `/api/inbound` returns `forwardToAi:false` and
the bot cannot talk over your colleague.

---

## Setup

### 1. Supabase

Create a project, open **SQL Editor**, and run
`supabase/migrations/0001_init.sql`.

Then create your staff logins under **Authentication → Users**. Anyone who can
sign in can work the inbox — this is a single-tenant install, one deployment
per business.

### 2. The app

```bash
cp .env.example .env.local     # fill in the five values
npm install
npm run dev
```

| Variable | Where it comes from |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same page, the **anon** key |
| `SUPABASE_SERVICE_ROLE_KEY` | same page, the **service role** key. Server only. |
| `NAMICI_API_KEY` | invent one. n8n sends it as `x-api-key`. |
| `N8N_OUTBOUND_WEBHOOK_URL` | the webhook in step 3b |

Deploys to Vercel as-is. Set the same five variables there.

### Running it yourself with PM2

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

### 3. The two n8n workflows

**a. Inbound** — one per chat platform.

```
Telegram Trigger
  → HTTP Request  POST  https://your-app/api/inbound
      header  x-api-key: <NAMICI_API_KEY>
      body    { channel, externalChatId, text, contactName, contactHandle }
  → IF  {{ $json.forwardToAi }}
      true → your AI Agent
           → Telegram: send the reply
           → HTTP Request POST /api/bot-message
                { conversationId, text }
      false → stop. A human has it.
```

**b. Outbound** — one, shared by every platform.

```
Webhook  POST /webhook/namici-outbound      ← this is N8N_OUTBOUND_WEBHOOK_URL
  → Switch on {{ $json.channel }}
      telegram → Telegram: send  chatId = {{ $json.externalChatId }}
      whatsapp → WhatsApp: send  to     = {{ $json.externalChatId }}
      …
```

Adding a platform is one branch here and one inbound workflow. namici-ci does
not change.

---

## API

All three take and return JSON.

| Route | Auth | Body | Returns |
| --- | --- | --- | --- |
| `POST /api/inbound` | `x-api-key` | `channel`, `externalChatId`, `text`, `contactName?`, `contactHandle?` | `{ conversationId, mode, forwardToAi }` |
| `POST /api/bot-message` | `x-api-key` | `conversationId`, `text` | `{ ok }` |
| `POST /api/reply` | staff session | `conversationId`, `text` | `{ ok, delivered, deliveryError }` |

`/api/reply` **saves before it sends**. If n8n is down you get
`delivered:false` and the message is still in the thread, so you know to retry
rather than wondering whether it went out twice.

---

## Behaviour worth knowing

- **Typing takes the chat over.** An operator who sends a message switches the
  conversation to `human` automatically. Leaving it on `ai` would let the bot
  answer the customer's next message over the top of them.
- **Hand back deliberately.** The chat stays with the human until someone
  presses *Hand back to AI*. There is no timer.
- **WhatsApp's 24-hour rule still applies.** Outside 24 hours from the
  customer's last message only approved templates send. namici-ci will show
  the reply as saved and `delivered:false`.

---

## Licence

MIT. Use it, change it, run it for clients, sell what you build with it.
