'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  kind: 'text' | 'image';
  body: string;
  media_url: string | null;
  created_at: string;
};

const PAGE = 30;

const GRADIENTS = [
  'linear-gradient(135deg,#22d3ee,#3b82f6)',
  'linear-gradient(135deg,#34d399,#0d9488)',
  'linear-gradient(135deg,#f472b6,#c026d3)',
  'linear-gradient(135deg,#a78bfa,#6d28d9)',
  'linear-gradient(135deg,#fbbf24,#f97316)',
  'linear-gradient(135deg,#60a5fa,#4338ca)',
];

const EMOJI = ['😀','😄','😁','😊','🙂','😉','😍','😘','🤗','🤔','😐','😌','😴','😎','🥳','😅','😂','🤣','😭','😢','😡','👍','👎','👌','🙏','👏','💪','🙌','👋','✅','❌','⚠️','❤️','🔥','⭐','✨','🎉','🎁','💡','📌','📷','📎','📄','⏰','💰','🚀','🏠','🛒','📦','🚚'];

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

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(); yest.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, yest)) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** Two short notes from the Web Audio API, so there is no sound file to ship. */
function ping() {
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

export default function Inbox() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [alerts, setAlerts] = useState(false);

  const openIdRef = useRef<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const stickToBottom = useRef(true);
  const keepOffset = useRef<number | null>(null);

  const open = conversations.find((c) => c.id === openId) ?? null;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) =>
      [nameOf(c), c.channel, c.last_preview ?? ''].join(' ').toLowerCase().includes(q)
    );
  }, [conversations, query]);

  useEffect(() => { openIdRef.current = openId; }, [openId]);

  useEffect(() => {
    try { setAlerts(localStorage.getItem('namici-alerts') === 'on'); } catch { /* private mode */ }
  }, []);

  // Unread count in the tab title, so a background tab still tells you.
  useEffect(() => {
    const total = conversations.reduce((n, c) => n + (c.unread || 0), 0);
    document.title = total > 0 ? `(${total}) namici-ci` : 'namici-ci';
  }, [conversations]);

  useEffect(() => {
    getSupabase().auth.getSession().then(({ data }) => {
      if (!data.session) router.replace('/login');
      else { setEmail(data.session.user.email ?? ''); setReady(true); }
    });
  }, [router]);

  async function signOut() {
    await getSupabase().auth.signOut();
    router.replace('/login');
  }

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

  // A separate, unfiltered subscription: the per-thread one only covers the
  // chat you already have open, which is precisely the one you do not need
  // alerting about.
  useEffect(() => {
    if (!ready || !alerts) return;
    const supabase = getSupabase();
    const channel = supabase
      .channel('inbox-alerts')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' },
          (payload) => {
            const m = payload.new as Message;
            if (m.role !== 'customer') return;
            if (m.conversation_id === openIdRef.current && document.visibilityState === 'visible') return;
            ping();
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
              new Notification('New message', {
                body: m.kind === 'image' ? 'Sent a photo' : m.body.slice(0, 120),
                tag: m.conversation_id,
              });
            }
          })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [ready, alerts]);

  async function toggleAlerts() {
    const next = !alerts;
    setAlerts(next);
    try { localStorage.setItem('namici-alerts', next ? 'on' : 'off'); } catch { /* private mode */ }
    if (next) {
      ping();
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission();
      }
    }
  }

  // Newest page first, then flipped, so opening a long chat is one small query.
  useEffect(() => {
    if (!openId) { setMessages([]); setHasMore(false); return; }

    let cancelled = false;
    const supabase = getSupabase();
    stickToBottom.current = true;

    // Opening a conversation is reading it.
    supabase.from('conversations').update({ unread: 0 }).eq('id', openId).then(() => {
      if (!cancelled) setConversations((cs) => cs.map((c) => (c.id === openId ? { ...c, unread: 0 } : c)));
    });

    supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', openId)
      .order('created_at', { ascending: false })
      .limit(PAGE)
      .then(({ data }) => {
        if (cancelled) return;
        const page = ((data as Message[]) ?? []).slice().reverse();
        setMessages(page);
        setHasMore(page.length === PAGE);
      });

    const channel = supabase
      .channel('thread-' + openId)
      .on('postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${openId}` },
          (payload) => {
            stickToBottom.current = true;
            setMessages((m) => (m.some((x) => x.id === (payload.new as Message).id)
              ? m
              : [...m, payload.new as Message]));
          })
      .subscribe();

    return () => { cancelled = true; supabase.removeChannel(channel); };
  }, [openId]);

  const loadOlder = useCallback(async () => {
    const el = threadRef.current;
    if (!openId || !el || loadingOlder || !hasMore || messages.length === 0) return;

    setLoadingOlder(true);
    stickToBottom.current = false;
    keepOffset.current = el.scrollHeight - el.scrollTop;

    const { data } = await getSupabase()
      .from('messages')
      .select('*')
      .eq('conversation_id', openId)
      .lt('created_at', messages[0].created_at)
      .order('created_at', { ascending: false })
      .limit(PAGE);

    const older = ((data as Message[]) ?? []).slice().reverse();
    setMessages((m) => [...older, ...m]);
    setHasMore(older.length === PAGE);
    setLoadingOlder(false);
  }, [openId, loadingOlder, hasMore, messages]);

  // Prepending older messages would otherwise yank the view to the top.
  useLayoutEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    if (keepOffset.current !== null) {
      el.scrollTop = el.scrollHeight - keepOffset.current;
      keepOffset.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  function onThreadScroll() {
    const el = threadRef.current;
    if (!el) return;
    if (el.scrollTop < 80) loadOlder();
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  // chat_handoffs is the flag n8n checks before running the bot; mode mirrors
  // it so the list can show who has each chat. Taking over opens a row with no
  // expiry, handing back closes every open row for the conversation.
  async function setMode(id: string, mode: 'ai' | 'human') {
    const supabase = getSupabase();
    const { error } = mode === 'human'
      ? await supabase.from('chat_handoffs').insert({
          chat_id: id,
          status: 'active',
          reason: 'operator takeover',
          operator_id: email || null,
        })
      : await supabase.from('chat_handoffs')
          .update({ status: 'closed' })
          .eq('chat_id', id)
          .eq('status', 'active');
    if (error) {
      alert('Could not change who has this chat: ' + error.message);
      return;
    }
    await supabase.from('conversations').update({ mode }).eq('id', id);
    loadConversations();
  }

  async function post(payload: Record<string, unknown>) {
    const { data } = await getSupabase().auth.getSession();
    const res = await fetch('/api/reply', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + (data.session?.access_token ?? ''),
      },
      body: JSON.stringify(payload),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) alert('Could not send: ' + (out.error ?? res.status));
    else if (!out.delivered) alert('Saved, but n8n did not deliver it: ' + (out.deliveryError || 'unknown'));
  }

  async function send() {
    const text = draft.trim();
    if (!text || !open || sending) return;
    setSending(true);
    setShowEmoji(false);
    if (open.mode === 'ai') await setMode(open.id, 'human');
    await post({ conversationId: open.id, text });
    setDraft('');
    setSending(false);
  }

  async function sendImage(file: File) {
    if (!open) return;
    setUploading(true);
    try {
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60);
      const path = `${open.id}/${Date.now()}-${safe}`;
      const supabase = getSupabase();

      const { error } = await supabase.storage.from('chat-media').upload(path, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type || 'image/jpeg',
      });
      if (error) { alert('Upload failed: ' + error.message); return; }

      const { data: pub } = supabase.storage.from('chat-media').getPublicUrl(path);
      if (open.mode === 'ai') await setMode(open.id, 'human');
      await post({ conversationId: open.id, kind: 'image', mediaUrl: pub.publicUrl, text: draft.trim() });
      setDraft('');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
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
                ? <>Nothing yet. Messages appear here once your n8n workflow writes them to Supabase.</>
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

        <footer className="side-foot">
          <button className={'bell' + (alerts ? ' on' : '')} onClick={toggleAlerts}
                  title={alerts ? 'Alerts on - click to mute' : 'Alerts off - click to enable'}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M13.7 21a2 2 0 0 1-3.4 0" strokeLinecap="round" />
              {!alerts && <path d="M3 3l18 18" strokeLinecap="round" />}
            </svg>
          </button>
          <span className="who" title={email}>{email || 'Signed in'}</span>
          <button className="linkish" onClick={signOut}>Sign out</button>
        </footer>
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
              <span className={'dot ' + open.mode}
                    title={open.mode === 'ai' ? 'The bot is answering' : 'A human has this chat'} />
              <span className="pane-sub">{open.channel}</span>
            </span>

            <button className={'takeover ' + open.mode}
                    onClick={() => setMode(open.id, open.mode === 'ai' ? 'human' : 'ai')}>
              {open.mode === 'ai' ? 'Take over' : 'Hand back to AI'}
            </button>
          </header>

          <div className="thread" ref={threadRef} onScroll={onThreadScroll}>
            {loadingOlder && <p className="older">Loading earlier messages…</p>}
            {!hasMore && messages.length > 0 && <p className="older">Start of the conversation</p>}

            {messages.map((m, i) => {
              const out = m.role !== 'customer';
              const newDay = i === 0 || dayLabel(m.created_at) !== dayLabel(messages[i - 1].created_at);
              return (
                <div key={m.id}>
                  {newDay && <p className="daybreak"><span>{dayLabel(m.created_at)}</span></p>}
                  <div className={'turn' + (out ? ' out' : '')}>
                    {!out && (
                      <span className="avatar" style={{ background: avatarFor(open.id) }}>
                        {initials(nameOf(open))}
                      </span>
                    )}
                    <div className="stack">
                      {m.kind === 'image' && m.media_url ? (
                        <a className={'bubble media ' + m.role} href={m.media_url}
                           target="_blank" rel="noreferrer">
                          <img src={m.media_url} alt={m.body || 'Image'} />
                          {m.body && <span className="caption">{m.body}</span>}
                        </a>
                      ) : (
                        <div className={'bubble ' + m.role}>{m.body}</div>
                      )}
                      <span className="stamp">
                        {m.role === 'ai' ? 'AI · ' : m.role === 'agent' ? 'You · ' : ''}
                        {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="composer">
            {showEmoji && (
              <div className="emoji-pop">
                {EMOJI.map((e) => (
                  <button key={e} onClick={() => { setDraft((d) => d + e); setShowEmoji(false); }}>{e}</button>
                ))}
              </div>
            )}

            <button className="icon" title="Emoji" onClick={() => setShowEmoji((v) => !v)}>
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="9" /><path d="M9 10h.01M15 10h.01M8.5 14.5a4.5 4.5 0 0 0 7 0" strokeLinecap="round" />
              </svg>
            </button>

            <button className="icon" title="Send a photo" disabled={uploading}
                    onClick={() => fileRef.current?.click()}>
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21.4 11.6 12.8 20.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 1 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"
                      strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <input ref={fileRef} type="file" accept="image/*" hidden
                   onChange={(e) => { const f = e.target.files?.[0]; if (f) sendImage(f); }} />

            <textarea
              placeholder={uploading ? 'Uploading…'
                : open.mode === 'ai' ? 'Typing here takes the chat over…' : 'Write something…'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              }}
            />

            <button className="send" onClick={send} disabled={sending || uploading || !draft.trim()} title="Send">
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
