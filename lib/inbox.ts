'use client';
import { getSupabase } from '@/lib/client';

export type Conversation = {
  id: string;
  channel: string;
  external_chat_id: string;
  contact_name: string | null;
  contact_handle: string | null;
  last_preview: string | null;
  mode: 'ai' | 'human';
  last_message_at: string;
  last_customer_at: string | null;
  unread: number;
  status: 'open' | 'resolved';
  resolved_at: string | null;
  assigned_to: string | null;
  tags: string[] | null;
  contact_note: string | null;
  created_at: string;
};

export type Kind = 'text' | 'image' | 'audio' | 'video' | 'file' | 'location' | 'note';

export type Message = {
  id: number;
  conversation_id: string;
  role: 'customer' | 'ai' | 'agent';
  kind: Kind;
  body: string;
  media_url: string | null;
  media_name: string | null;
  media_mime: string | null;
  sent_by: string | null;
  delivery_status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | null;
  delivery_error: string | null;
  created_at: string;
};

export type Handoff = {
  id: number;
  chat_id: string;
  status: string;
  reason: string | null;
  operator_id: string | null;
  started_at: string;
  expires_at: string | null;
};

export type SavedReply = { id: number; shortcut: string; body: string; created_by: string | null };

export type Tab = 'all' | 'mine' | 'unassigned' | 'waiting' | 'resolved';

export const CONVO_COLUMNS =
  'id,channel,external_chat_id,contact_name,contact_handle,mode,last_message_at,last_customer_at,' +
  'last_preview,unread,status,resolved_at,assigned_to,tags,contact_note,created_at';
export const MESSAGE_COLUMNS =
  'id,conversation_id,role,kind,body,media_url,media_name,media_mime,sent_by,delivery_status,delivery_error,created_at';

export const PAGE = 30;          // messages per page
export const LIST_PAGE = 50;     // conversations per page
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const WHATSAPP_WINDOW_MS = 24 * 3600 * 1000;

const GRADIENTS = [
  'linear-gradient(135deg,#22d3ee,#3b82f6)',
  'linear-gradient(135deg,#34d399,#0d9488)',
  'linear-gradient(135deg,#f472b6,#c026d3)',
  'linear-gradient(135deg,#a78bfa,#6d28d9)',
  'linear-gradient(135deg,#fbbf24,#f97316)',
  'linear-gradient(135deg,#60a5fa,#4338ca)',
];

// Anything not listed is shown as stored, so a new channel in n8n works
// without a code change.
const CHANNEL_LABELS: Record<string, string> = {
  telegram: 'Telegram', whatsapp: 'WhatsApp', web: 'Web', slack: 'Slack',
  messenger: 'Messenger', facebook: 'Facebook', instagram: 'Instagram',
  discord: 'Discord', line: 'LINE', email: 'Email', sms: 'SMS', teams: 'Teams',
  twitter: 'X', x: 'X', viber: 'Viber', wechat: 'WeChat', tiktok: 'TikTok',
};

export function channelLabel(ch: string | null | undefined) {
  return CHANNEL_LABELS[String(ch || '').toLowerCase()] || ch || 'Unknown';
}

export function nameOf(c: Conversation) {
  return c.contact_name || c.contact_handle || c.external_chat_id;
}

/** "ana@shop.com" → "ana". Staff are known by email; this is what the thread shows. */
export function staffName(email: string | null | undefined) {
  if (!email) return 'Staff';
  return email.split('@')[0];
}

export function avatarFor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return GRADIENTS[h % GRADIENTS.length];
}

export function initials(label: string) {
  const parts = label.replace(/^@/, '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function ago(iso: string | null | undefined) {
  if (!iso) return '';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} h`;
  return `${Math.floor(hrs / 24)} d`;
}

export function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(); yest.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, yest)) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** Time left in WhatsApp's 24-hour customer-service window, or null for other channels. */
export function whatsappWindow(c: Conversation | null) {
  if (!c || c.channel.toLowerCase() !== 'whatsapp' || !c.last_customer_at) return null;
  const left = WHATSAPP_WINDOW_MS - (Date.now() - new Date(c.last_customer_at).getTime());
  return { open: left > 0, left };
}

export function formatLeft(ms: number) {
  const mins = Math.max(0, Math.floor(ms / 60000));
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

/** What kind of message a file becomes when an operator attaches it. */
export function kindForFile(file: File): Exclude<Kind, 'text' | 'location' | 'note'> {
  const t = (file.type || '').split(';')[0].trim();
  if (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(t)) return 'image';
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('video/')) return 'video';
  return 'file';
}

/** A location body is "lat,lng" or "label|lat,lng". */
export function parseLocation(body: string) {
  const [label, coords] = body.includes('|') ? body.split('|') : ['', body];
  const m = coords.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return { label: label.trim(), lat: m[1], lng: m[2] };
}

/**
 * A value inside a PostgREST logic tree (`or=(…)`). Quoted, because names and
 * search text can contain the characters that tree syntax reserves.
 */
function pgQuote(v: string) {
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export const newestFirst = (a: Conversation, b: Conversation) =>
  (b.last_message_at || '').localeCompare(a.last_message_at || '') || b.id.localeCompare(a.id);

/** Longest wait first: the order a queue should be worked in. */
export const longestWaitFirst = (a: Conversation, b: Conversation) =>
  (a.last_customer_at || a.last_message_at).localeCompare(b.last_customer_at || b.last_message_at);

/** Two short notes from the Web Audio API, so there is no sound file to ship. */
export function ping() {
  try {
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const play = (freq: number, at: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 0.2);
    };
    play(880, 0);
    play(1174, 0.11);
    setTimeout(() => ctx.close(), 600);
  } catch {
    /* a browser that blocks audio is not a reason to break the inbox */
  }
}

/**
 * Conversation ids whose messages match a search pattern. Scanning message
 * text is the expensive part of a search, and the list re-runs its query on
 * every realtime change, so the answer is kept for 30 seconds per pattern.
 */
const mentionCache = new Map<string, { at: number; ids: string[] }>();
async function conversationsMentioning(pattern: string) {
  const hit = mentionCache.get(pattern);
  if (hit && Date.now() - hit.at < 30_000) return hit.ids;
  const { data } = await getSupabase()
    .from('messages')
    .select('conversation_id')
    .ilike('body', pattern)
    .order('id', { ascending: false })
    .limit(300);
  const ids = Array.from(new Set((data ?? []).map((r: any) => r.conversation_id as string)));
  mentionCache.set(pattern, { at: Date.now(), ids });
  if (mentionCache.size > 20) mentionCache.delete(mentionCache.keys().next().value!);
  return ids;
}

/** The filter each list tab stands for. Shared by the list and its counts. */
function applyTab<Q extends { eq: any; is: any; gt: any }>(query: Q, tab: Tab, me: string): Q {
  switch (tab) {
    case 'mine':       return query.eq('status', 'open').eq('assigned_to', me);
    case 'unassigned': return query.eq('status', 'open').is('assigned_to', null);
    case 'waiting':    return query.eq('status', 'open').eq('mode', 'human').gt('unread', 0);
    case 'resolved':   return query.eq('status', 'resolved');
    default:           return query;
  }
}

/**
 * One page of the list. Tab, channel filter, search and paging all run in
 * the database, so the inbox is never limited to whatever it loaded first.
 *
 * Most tabs are newest activity first, paged with `before` (the last row
 * shown). The cursor is `lte` on the timestamp and the caller drops ids it
 * already has: two conversations can share a timestamp, and a strict `lt`
 * would skip one. Waiting is a queue — longest wait first, one page.
 */
export async function fetchConversations(opts: {
  tab: Tab; me: string; channel: string | null; q: string; before?: Conversation;
}) {
  const waiting = opts.tab === 'waiting';
  let query = getSupabase().from('conversations').select(CONVO_COLUMNS);
  query = applyTab(query, opts.tab, opts.me);
  query = waiting
    ? query.order('last_customer_at', { ascending: true, nullsFirst: false }).limit(200)
    : query.order('last_message_at', { ascending: false }).order('id', { ascending: false }).limit(LIST_PAGE);

  if (opts.channel) query = query.eq('channel', opts.channel);
  if (opts.before && !waiting) query = query.lte('last_message_at', opts.before.last_message_at);

  const q = opts.q.trim();
  if (q) {
    // % and _ are LIKE wildcards; someone searching "50%" means the text.
    const escaped = q.replace(/[\\%_]/g, '\\$&');
    const like = pgQuote(`*${escaped}*`);
    const match = [`contact_name.ilike.${like}`, `contact_handle.ilike.${like}`, `last_preview.ilike.${like}`];
    // A customer is often remembered by what they said, not their name.
    const ids = await conversationsMentioning(`%${escaped}%`);
    if (ids.length) match.push(`id.in.(${ids.join(',')})`);
    query = query.or(match.join(','));
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data as unknown as Conversation[]) ?? [];
}

/** Badge numbers on the tabs. */
export async function fetchTabCounts(me: string) {
  const count = async (tab: Tab) => {
    const { count } = await applyTab(
      getSupabase().from('conversations').select('id', { count: 'exact', head: true }), tab, me);
    return count ?? 0;
  };
  const [mine, unassigned, waiting] = await Promise.all([count('mine'), count('unassigned'), count('waiting')]);
  return { mine, unassigned, waiting };
}

/** Calls an API route with the signed-in user's token. */
export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const { data } = await getSupabase().auth.getSession();
  const res = await fetch(path, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + (data.session?.access_token ?? ''),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error ?? `Request failed (${res.status})`);
  return out as T;
}
