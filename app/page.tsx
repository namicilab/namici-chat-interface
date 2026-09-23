'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabase } from '@/lib/client';

type Conversation = {
  id: string;
  channel: string;
  external_chat_id: string;
  contact_name: string | null;
  contact_handle: string | null;
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

export default function Inbox() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const open = conversations.find((c) => c.id === openId) ?? null;

  // --- auth gate ----------------------------------------------------------
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

  // --- list, kept live ----------------------------------------------------
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

  // --- open thread, kept live --------------------------------------------
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
    <div className="app">
      <div className="list">
        <h1>Conversations</h1>
        {conversations.length === 0 && (
          <p style={{ padding: 16, color: '#8a8a94', fontSize: 13 }}>
            Nothing yet. Point an n8n workflow at <code>/api/inbound</code>.
          </p>
        )}
        {conversations.map((c) => (
          <button key={c.id} className="row" aria-current={c.id === openId}
                  onClick={() => setOpenId(c.id)}>
            <span className="who">
              <span>{c.contact_name || c.contact_handle || c.external_chat_id}</span>
              <span className={'tag ' + c.mode}>{c.mode}</span>
            </span>
            <span className="last">
              {c.channel}
              {c.unread > 0 ? ` · ${c.unread} new` : ''}
            </span>
          </button>
        ))}
      </div>

      {!open ? (
        <div className="empty">Pick a conversation</div>
      ) : (
        <div className="pane">
          <header>
            <strong>{open.contact_name || open.contact_handle || open.external_chat_id}</strong>
            <span className="meta">{open.channel} · {open.external_chat_id}</span>
            <span style={{ flex: 1 }} />
            <button
              className={'toggle ' + open.mode}
              onClick={() => setMode(open.id, open.mode === 'ai' ? 'human' : 'ai')}
            >
              {open.mode === 'ai' ? 'Take over' : 'Hand back to AI'}
            </button>
          </header>

          <div className="thread">
            {messages.map((m) => (
              <div key={m.id}>
                <div className={'msg ' + m.role}>{m.body}</div>
                <div className="meta" style={{ textAlign: m.role === 'customer' ? 'left' : 'right' }}>
                  {m.role} · {new Date(m.created_at).toLocaleTimeString()}
                </div>
              </div>
            ))}
            <div ref={bottom} />
          </div>

          <div className="composer">
            <textarea
              placeholder={open.mode === 'ai' ? 'Typing here takes the chat over…' : 'Your reply…'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              }}
            />
            <button onClick={send} disabled={sending}>{sending ? 'Sending…' : 'Send'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
