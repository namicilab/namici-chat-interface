'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabase } from '@/lib/client';

type Conversation = {
  id: string;
  channel: string;
  external_chat_id: string;
  contact_name: string | null;
  contact_handle: string | null;
  last_preview: string | null;
  mode: 'ai' | 'human';
  last_message_at: string;
  unread: number;
};

type Message = {
  id: number;
  conversation_id: string;
  role: 'customer' | 'ai' | 'agent';
  body: string;
  created_at: string;
};

const GRADIENTS = [
  'linear-gradient(135deg,#22d3ee,#3b82f6)',
  'linear-gradient(135deg,#34d399,#0d9488)',
  'linear-gradient(135deg,#f472b6,#c026d3)',
  'linear-gradient(135deg,#a78bfa,#6d28d9)',
  'linear-gradient(135deg,#fbbf24,#f97316)',
  'linear-gradient(135deg,#60a5fa,#4338ca)',
];

function nameOf(c: Conversation) {
  return c.contact_name || c.contact_handle || c.external_chat_id;
}

function avatarFor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return GRADIENTS[h % GRADIENTS.length];
}

function initials(label: string) {
  const parts = label.replace(/^@/, '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function ago(iso: string) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} h`;
  return `${Math.floor(hrs / 24)} d`;
}

export default function Inbox() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const open = conversations.find((c) => c.id === openId) ?? null;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) =>
      [nameOf(c), c.channel, c.last_preview ?? ''].join(' ').toLowerCase().includes(q)
    );
  }, [conversations, query]);

  useEffect(() => {
    getSupabase().auth.getSession().then(({ data }) => {
      if (!data.session) router.replace('/login');
      else setReady(true);
    });
  }, [router]);

  const loadConversations = useCallback(async () => {
    const { data } = await getSupabase()
      .from('conversations')
      .select('*')
      .order('last_message_at', { ascending: false })
      .limit(200);
    setConversations((data as Conversation[]) ?? []);
  }, []);

  useEffect(() => {
    if (!ready) return;
    loadConversations();
    const supabase = getSupabase();
    const channel = supabase
      .channel('conversations-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' },
          () => loadConversations())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [ready, loadConversations]);

  useEffect(() => {
    if (!openId) { setMessages([]); return; }

    let cancelled = false;
    const supabase = getSupabase();
    supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', openId)
      .order('created_at', { ascending: true })
      .then(({ data }) => { if (!cancelled) setMessages((data as Message[]) ?? []); });

    const channel = supabase
      .channel('thread-' + openId)
      .on('postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${openId}` },
          (payload) => setMessages((m) => [...m, payload.new as Message]))
      .subscribe();

    return () => { cancelled = true; supabase.removeChannel(channel); };
  }, [openId]);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  async function setMode(id: string, mode: 'ai' | 'human') {
    await getSupabase().from('conversations').update({ mode }).eq('id', id);
    loadConversations();
  }

  async function send() {
    const text = draft.trim();
    if (!text || !open || sending) return;
    setSending(true);

    // Taking over implicitly: an operator who types has taken the chat, and
    // leaving it on 'ai' would let the bot answer the next message over them.
    if (open.mode === 'ai') await setMode(open.id, 'human');

    const { data } = await getSupabase().auth.getSession();
    const res = await fetch('/api/reply', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + (data.session?.access_token ?? ''),
      },
      body: JSON.stringify({ conversationId: open.id, text }),
    });

    const out = await res.json().catch(() => ({}));
    if (!res.ok) alert('Could not send: ' + (out.error ?? res.status));
    else if (!out.delivered) alert('Saved, but n8n did not deliver it: ' + (out.deliveryError || 'unknown'));

    setDraft('');
    setSending(false);
  }

  if (!ready) return <div className="empty">Loading…</div>;

  return (
    <div className={'app' + (open ? '' : ' browsing')}>
      <aside className="panel side">
        <div className="search">
          <div className="search-box">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" strokeLinecap="round" />
            </svg>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search contact" />
          </div>
        </div>

        <div className="rows">
          {visible.length === 0 && (
            <p className="hint">
              {conversations.length === 0
                ? <>Nothing yet. Point an n8n workflow at <code>/api/inbound</code>.</>
                : 'No conversation matches that.'}
            </p>
          )}
          {visible.map((c) => {
            const label = nameOf(c);
            return (
              <button key={c.id} className="row" aria-current={c.id === openId}
                      onClick={() => setOpenId(c.id)}>
                <span className="avatar" style={{ background: avatarFor(c.id) }}>{initials(label)}</span>
                <span className="row-main">
                  <span className="row-top">
                    <span className="row-name">{label}</span>
                    <span className="row-time">{ago(c.last_message_at)}</span>
                  </span>
                  <span className="row-last">{c.last_preview || c.channel}</span>
                </span>
                {c.unread > 0 && <span className="badge">{c.unread}</span>}
              </button>
            );
          })}
        </div>
      </aside>

      {!open ? (
        <section className="panel empty">Pick a conversation</section>
      ) : (
        <section className="panel pane">
          <header className="pane-head">
            <button onClick={() => setOpenId(null)} title="Back to the list" style={{ color: 'var(--faint)' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            <span className="pane-title">
              {nameOf(open)}
              <span className={'dot ' + open.mode} title={open.mode === 'ai' ? 'The bot is answering' : 'A human has this chat'} />
              <span className="pane-sub">{open.channel}</span>
            </span>

            <button className={'takeover ' + open.mode}
                    onClick={() => setMode(open.id, open.mode === 'ai' ? 'human' : 'ai')}>
              {open.mode === 'ai' ? 'Take over' : 'Hand back to AI'}
            </button>
          </header>

          <div className="thread">
            {messages.map((m) => {
              const out = m.role !== 'customer';
              return (
                <div key={m.id} className={'turn' + (out ? ' out' : '')}>
                  {!out && (
                    <span className="avatar" style={{ background: avatarFor(open.id) }}>
                      {initials(nameOf(open))}
                    </span>
                  )}
                  <div className="stack">
                    <div className={'bubble ' + m.role}>{m.body}</div>
                    <span className="stamp">
                      {m.role === 'ai' ? 'AI' : m.role === 'agent' ? 'You' : ''}
                      {m.role === 'customer' ? '' : ' · '}
                      {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                </div>
              );
            })}
            <div ref={bottom} />
          </div>

          <div className="composer">
            <textarea
              placeholder={open.mode === 'ai' ? 'Typing here takes the chat over…' : 'Write something…'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              }}
            />
            <button className="send" onClick={send} disabled={sending || !draft.trim()} title="Send">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 12h14M13 6l6 6-6 6" />
              </svg>
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
