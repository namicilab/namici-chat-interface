'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { getSupabase } from '@/lib/client';
import {
  type Conversation, type Handoff, type Message, type SavedReply, type Tab,
  CONVO_COLUMNS, LIST_PAGE, MAX_UPLOAD_BYTES, MESSAGE_COLUMNS, PAGE,
  ago, api, avatarFor, channelLabel, dayLabel, fetchConversations, fetchTabCounts, formatLeft,
  initials, kindForFile, longestWaitFirst, nameOf, newestFirst, ping, staffName, whatsappWindow,
} from '@/lib/inbox';
import { DeliveryMark, MessageBody } from '@/components/MessageBody';
import { ContactPanel } from '@/components/ContactPanel';
import { SavedRepliesModal } from '@/components/SavedRepliesModal';
import { Lightbox } from '@/components/Lightbox';
import {
  clearCaches, edgeSwipe, isPhoneLayout, longPress, readListCache, readThreadCache,
  useAppBadge, useInstall, useIsPhone, useOnline, useViewportHeight, writeListCache, writeThreadCache,
} from '@/lib/mobile';

const EMOJI = ['😀','😄','😁','😊','🙂','😉','😍','😘','🤗','🤔','😐','😌','😴','😎','🥳','😅','😂','🤣','😭','😢','😡','👍','👎','👌','🙏','👏','💪','🙌','👋','✅','❌','⚠️','❤️','🔥','⭐','✨','🎉','🎁','💡','📌','📷','📎','📄','⏰','💰','🚀','🏠','🛒','📦','🚚'];

const TABS: { key: Tab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'mine', label: 'Mine' },
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'resolved', label: 'Resolved' },
];

type Team = { staff: string[]; suggest: boolean; push: boolean; vapidPublicKey: string | null };
type Presence = { email: string; viewing: string | null; typing: string | null };
type Theme = 'auto' | 'light' | 'dark';

function urlBase64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function isTextField(el: EventTarget | null) {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export default function Inbox() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState('');
  const [userId, setUserId] = useState('');
  const [team, setTeam] = useState<Team>({ staff: [], suggest: false, push: false, vapidPublicKey: null });

  // List
  const [tab, setTab] = useState<Tab>('all');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [hasMoreConvos, setHasMoreConvos] = useState(false);
  const [loadingConvos, setLoadingConvos] = useState(true);
  const [loadingMoreConvos, setLoadingMoreConvos] = useState(false);
  const [counts, setCounts] = useState({ mine: 0, unassigned: 0, waiting: 0 });
  const [channels, setChannels] = useState<string[]>([]);
  const [channelFilter, setChannelFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');   // `query` after a pause in typing

  // Thread
  const [openId, setOpenId] = useState<string | null>(null);
  const [openConvo, setOpenConvo] = useState<Conversation | null>(null);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [retrying, setRetrying] = useState<number | null>(null);

  // Composer
  const [draft, setDraft] = useState('');
  const [composeMode, setComposeMode] = useState<'reply' | 'note'>('reply');
  const [sending, setSending] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState<{ file: File; url: string | null } | null>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [savedReplies, setSavedReplies] = useState<SavedReply[]>([]);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [pickerDismissed, setPickerDismissed] = useState(false);

  // Chrome
  const [alerts, setAlerts] = useState(false);
  const [pushOn, setPushOn] = useState(false);
  const [theme, setTheme] = useState<Theme>('auto');
  const [showInfo, setShowInfo] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [presence, setPresence] = useState<Presence[]>([]);
  const [toastMsg, setToastMsg] = useState('');
  const [photo, setPhoto] = useState<{ src: string; caption?: string } | null>(null);
  const [chatMenu, setChatMenu] = useState(false);
  const [appMenu, setAppMenu] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [newBelow, setNewBelow] = useState(0);
  const [live, setLive] = useState(true);   // the realtime socket is connected
  const [, setTick] = useState(0);

  const openIdRef = useRef<string | null>(null);
  const conversationsRef = useRef<Conversation[]>([]);
  const messagesRef = useRef<Message[]>([]);
  const pushOnRef = useRef(false);
  const listEpoch = useRef(0);   // bumped when tab, filter or search changes; stale replies are dropped
  const listRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const stickToBottom = useRef(true);
  const keepOffset = useRef<number | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const presenceRef = useRef<RealtimeChannel | null>(null);
  const typingRef = useRef(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout>>();
  const resyncRef = useRef<() => void>(() => {});

  useEffect(() => { openIdRef.current = openId; }, [openId]);
  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { pushOnRef.current = pushOn; }, [pushOn]);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(''), 2800);
  }, []);

  useViewportHeight();
  const online = useOnline();
  const phone = useIsPhone();
  const { canInstall, install, iosTip, dismissIosTip } = useInstall();

  // ── Navigation ────────────────────────────────────────────────────────────
  // Each screen is a history entry, so the phone's back button and the swipe
  // back gesture close the chat (then the contact panel or photo above it)
  // instead of leaving the app — the way WhatsApp behaves.

  function openChat(id: string) {
    if (openIdRef.current === id) return;
    const state = { chat: id };
    if (openIdRef.current) window.history.replaceState(state, '');
    else window.history.pushState(state, '');
    setShowInfo(false);
    setPhoto(null);
    setChatMenu(false);
    setOpenId(id);
  }

  function closeChat() {
    if (window.history.state?.chat) window.history.back();
    else setOpenId(null);
  }

  // The contact panel and photo viewer are screens of their own on a phone;
  // on a desktop they sit beside the chat and need no history entry.
  function openInfo() {
    setChatMenu(false);
    if (isPhoneLayout()) window.history.pushState({ ...window.history.state, info: true }, '');
    setShowInfo(true);
  }
  function closeInfo() {
    if (window.history.state?.info) window.history.back();
    else setShowInfo(false);
  }
  function openPhoto(src: string, caption?: string) {
    if (isPhoneLayout()) window.history.pushState({ ...window.history.state, photo: { src, caption } }, '');
    setPhoto({ src, caption });
  }
  function closePhoto() {
    if (window.history.state?.photo) window.history.back();
    else setPhoto(null);
  }

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const st = e.state || {};
      setOpenId(st.chat ?? null);
      setShowInfo(!!st.info);
      setPhoto(st.photo ?? null);
      setChatMenu(false);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // ── Session and settings ──────────────────────────────────────────────────

  useEffect(() => {
    try {
      setAlerts(localStorage.getItem('namici-alerts') === 'on');
      setTheme((localStorage.getItem('namici-theme') as Theme) || 'auto');
    } catch { /* private mode */ }
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'auto') delete root.dataset.theme; else root.dataset.theme = theme;
    try { localStorage.setItem('namici-theme', theme); } catch { /* private mode */ }
  }, [theme]);

  // Relative times ("5 min", the WhatsApp window) stay current without a reload.
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) setTick((n) => n + 1); }, 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    getSupabase().auth.getSession().then(({ data }) => {
      if (!data.session) { router.replace('/login'); return; }
      setEmail(data.session.user.email ?? '');
      setUserId(data.session.user.id);
      setReady(true);
    });
  }, [router]);

  useEffect(() => {
    if (!ready) return;
    api<Team>('/api/team').then(setTeam).catch(() => { /* optional features stay off */ });
  }, [ready]);

  // Unread count in the tab title, so a background tab still tells you. A
  // chat a human owns with the customer waiting is flagged.
  useEffect(() => {
    const total = conversations.reduce((n, c) => n + (c.unread || 0), 0);
    document.title = counts.waiting > 0 ? `● (${counts.waiting}) namici-ci`
      : total > 0 ? `(${total}) namici-ci` : 'namici-ci';
  }, [conversations, counts.waiting]);

  // The number on the home-screen icon: people waiting for a human first,
  // otherwise everything unread.
  useAppBadge(counts.waiting || conversations.reduce((n, c) => n + (c.unread || 0), 0));

  async function signOut() {
    // A shared computer should stop alerting the person who left.
    if (pushOnRef.current) await disablePush().catch(() => {});
    clearCaches();
    await getSupabase().auth.signOut();
    router.replace('/login');
  }

  // ── Deep links: a push notification opens /?c=<id>, or messages an open tab ─

  useEffect(() => {
    if (!ready) return;
    const params = new URLSearchParams(window.location.search);
    const id = params.get('c');
    const startTab = params.get('tab') as Tab | null;
    if (startTab && TABS.some((t) => t.key === startTab)) setTab(startTab);
    if (id || startTab) window.history.replaceState(null, '', '/');
    if (id) openChat(id);
    // A reload lands back on the chat that was open.
    else if (window.history.state?.chat) setOpenId(window.history.state.chat);
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => { /* no PWA, inbox still works */ });
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'open-conversation' && e.data.conversationId) openChat(e.data.conversationId);
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, [ready]);

  // ── List ──────────────────────────────────────────────────────────────────

  // Search runs in the database, so wait for a pause in typing.
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const sortFor = tab === 'waiting' ? longestWaitFirst : newestFirst;

  const refreshCounts = useCallback(async () => {
    if (!email) return;
    try { setCounts(await fetchTabCounts(email)); } catch { /* counts are a nicety */ }
  }, [email]);

  /**
   * Fetches the first page. While the list is no longer than a page, it is
   * replaced, so rows that left the tab (reassigned, resolved) disappear.
   * Past that it is merged: someone who scrolled down to page three should not
   * be thrown back to the top every time a message arrives.
   */
  const refreshList = useCallback(async () => {
    if (!email) return;
    const epoch = listEpoch.current;
    try {
      const page = await fetchConversations({ tab, me: email, channel: channelFilter, q: search });
      if (epoch !== listEpoch.current) return;
      if (conversationsRef.current.length <= LIST_PAGE || tab === 'waiting') {
        conversationsRef.current = page;
        setConversations(page);
        setHasMoreConvos(tab !== 'waiting' && page.length === LIST_PAGE);
        if (tab === 'all' && !channelFilter && !search) writeListCache(page);
      } else {
        setConversations((cur) => {
          const byId = new Map(cur.map((c) => [c.id, c]));
          for (const c of page) byId.set(c.id, c);
          return Array.from(byId.values()).sort(sortFor);
        });
      }
    } catch (e: any) {
      // Offline is shown by the connection bar; no need to shout about it.
      if (navigator.onLine) toast('Could not load conversations: ' + (e?.message ?? e));
    } finally {
      if (epoch === listEpoch.current) setLoadingConvos(false);
    }
  }, [email, tab, channelFilter, search, sortFor, toast]);

  // A new tab, filter or search starts the list over from the top.
  useEffect(() => {
    if (!ready || !email) return;
    listEpoch.current++;
    // Open on what was there last time, then refresh: an app that shows a
    // spinner every time it is opened does not feel like an app.
    const cached = tab === 'all' && !channelFilter && !search ? readListCache() : null;
    conversationsRef.current = cached ?? [];
    setConversations(cached ?? []);
    setHasMoreConvos(false);
    setLoadingMoreConvos(false);
    setLoadingConvos(!cached);
    if (listRef.current) listRef.current.scrollTop = 0;
    refreshList();
    refreshCounts();
  }, [ready, email, refreshList, refreshCounts]);

  /** Scrolling down: the page after the last conversation shown. */
  const loadMoreConvos = useCallback(async () => {
    const cur = conversationsRef.current;
    if (!hasMoreConvos || loadingMoreConvos || !cur.length) return;
    const epoch = listEpoch.current;
    setLoadingMoreConvos(true);
    try {
      const page = await fetchConversations({ tab, me: email, channel: channelFilter, q: search, before: cur[cur.length - 1] });
      if (epoch !== listEpoch.current) return;
      const have = new Set(conversationsRef.current.map((c) => c.id));
      const fresh = page.filter((c) => !have.has(c.id));
      // A full page that was all ties we already hold would loop forever.
      setHasMoreConvos(page.length === LIST_PAGE && fresh.length > 0);
      setConversations((cs) => cs.concat(fresh));
    } catch (e: any) {
      toast('Could not load more: ' + (e?.message ?? e));
    } finally {
      if (epoch === listEpoch.current) setLoadingMoreConvos(false);
    }
  }, [hasMoreConvos, loadingMoreConvos, tab, email, channelFilter, search, toast]);

  // Without a scrollbar there is no scroll event; keep loading until there is one.
  useEffect(() => {
    const el = listRef.current;
    if (el && hasMoreConvos && !loadingMoreConvos && el.scrollHeight <= el.clientHeight) loadMoreConvos();
  }, [conversations, hasMoreConvos, loadingMoreConvos, loadMoreConvos]);

  function onListScroll() {
    const el = listRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) loadMoreConvos();
  }

  /** Every channel with a conversation, for the filter chips. */
  const loadChannels = useCallback(async () => {
    const { data } = await getSupabase()
      .from('conversations').select('channel')
      .order('last_message_at', { ascending: false }).limit(5000);
    setChannels(Array.from(new Set((data ?? []).map((r: any) => r.channel as string).filter(Boolean))));
  }, []);

  const loadSavedReplies = useCallback(async () => {
    const { data } = await getSupabase().from('saved_replies').select('id,shortcut,body,created_by').order('shortcut');
    setSavedReplies((data as SavedReply[]) ?? []);
  }, []);

  useEffect(() => {
    if (!ready) return;
    loadChannels();
    loadSavedReplies();
    const t = setInterval(loadChannels, 60_000);
    return () => clearInterval(t);
  }, [ready, loadChannels, loadSavedReplies]);

  // ── Thread ────────────────────────────────────────────────────────────────

  const markRead = useCallback((id: string) => {
    getSupabase().from('conversations').update({ unread: 0 }).eq('id', id).then(() => {
      setConversations((cs) => cs.map((c) => (c.id === id ? { ...c, unread: 0 } : c)));
    });
  }, []);

  const loadHandoff = useCallback(async (id: string) => {
    const { data } = await getSupabase().from('chat_handoffs').select('*')
      .eq('chat_id', id).order('started_at', { ascending: false }).limit(1);
    if (id === openIdRef.current) setHandoff(((data as Handoff[]) ?? [])[0] ?? null);
  }, []);

  /**
   * Catch up after the tab slept or the connection dropped: Realtime does not
   * replay what it missed. Refetches the newest page and merges it — which
   * also picks up delivery receipts on messages already shown. If more arrived
   * than one page holds, the thread restarts from that page.
   */
  const syncThread = useCallback(async () => {
    const id = openIdRef.current;
    if (!id) return;
    const supabase = getSupabase();
    const [{ data }, { data: row }] = await Promise.all([
      supabase.from('messages').select(MESSAGE_COLUMNS).eq('conversation_id', id)
        .order('id', { ascending: false }).limit(PAGE),
      supabase.from('conversations').select(CONVO_COLUMNS).eq('id', id).maybeSingle(),
    ]);
    if (id !== openIdRef.current) return;
    if (row) setOpenConvo(row as unknown as Conversation);
    loadHandoff(id);
    const page = ((data as unknown as Message[]) ?? []).slice().reverse();
    const cur = messagesRef.current;
    const newest = cur.length ? cur[cur.length - 1].id : 0;
    if (!cur.length || (page.length === PAGE && page[0].id > newest)) {
      stickToBottom.current = true;
      setMessages(page);
      setHasMore(page.length === PAGE);
      return;
    }
    const byId = new Map(cur.map((m) => [m.id, m]));
    for (const m of page) byId.set(m.id, m);
    setMessages(Array.from(byId.values()).sort((a, b) => a.id - b.id));
  }, [loadHandoff]);

  resyncRef.current = () => { refreshList(); refreshCounts(); syncThread(); };

  // Woken from sleep, back online, or a periodic safety net while visible.
  useEffect(() => {
    if (!ready) return;
    const onVisible = () => { if (document.visibilityState === 'visible') resyncRef.current(); };
    const onOnline = () => resyncRef.current();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    const t = setInterval(() => { if (document.visibilityState === 'visible') resyncRef.current(); }, 60_000);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      clearInterval(t);
    };
  }, [ready]);

  // Realtime for the list. Any change patches the row in place and refreshes
  // the first page (debounced: a burst of messages fires a burst of events).
  // A re-subscribe after a dropped connection triggers a full catch-up.
  useEffect(() => {
    if (!ready) return;
    const supabase = getSupabase();
    let t: ReturnType<typeof setTimeout> | undefined;
    let joined = false;
    const channel = supabase
      .channel('conversations-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, (payload) => {
        const row = payload.new as Conversation | undefined;
        if (row?.id) {
          setConversations((cs) => cs.map((c) => (c.id === row.id ? { ...c, ...row } : c)));
          if (row.id === openIdRef.current) setOpenConvo((c) => (c ? { ...c, ...row } : row));
        }
        clearTimeout(t);
        t = setTimeout(() => { refreshList(); refreshCounts(); }, 400);
      })
      .subscribe((s) => {
        if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED') { setLive(false); return; }
        if (s !== 'SUBSCRIBED') return;
        setLive(true);
        if (joined) resyncRef.current();
        joined = true;
      });
    return () => { clearTimeout(t); supabase.removeChannel(channel); };
  }, [ready, refreshList, refreshCounts]);

  // Alerts: a separate, unfiltered subscription, since the thread one only
  // covers the chat you already have open.
  useEffect(() => {
    if (!ready || !alerts) return;
    const supabase = getSupabase();
    const channel = supabase
      .channel('inbox-alerts')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, async (payload) => {
        const m = payload.new as Message;
        if (m.role !== 'customer') return;
        if (m.conversation_id === openIdRef.current && document.visibilityState === 'visible') return;
        ping();
        navigator.vibrate?.(30);
        // With Web Push on, the service worker shows the notification.
        if (pushOnRef.current) return;
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

        let c = conversationsRef.current.find((x) => x.id === m.conversation_id);
        if (!c) {
          const { data } = await supabase.from('conversations').select(CONVO_COLUMNS)
            .eq('id', m.conversation_id).maybeSingle();
          c = (data as unknown as Conversation) ?? undefined;
        }
        if (c?.assigned_to && c.assigned_to !== email) return;   // someone else's chat
        const who = c ? nameOf(c) : 'Customer';
        const n = new Notification(
          c?.mode === 'human' ? `${who} is waiting for you` : `${who} · ${channelLabel(c?.channel)}`,
          { body: m.kind === 'text' ? m.body.slice(0, 160) : (m.body || `Sent a ${m.kind}`), tag: m.conversation_id },
        );
        n.onclick = () => { window.focus(); openChat(m.conversation_id); n.close(); };
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [ready, alerts, email]);

  // Opening a conversation. Messages are paged on `id`, not `created_at`: it
  // is a bigserial, so it cannot tie, while two messages can share a timestamp.
  useEffect(() => {
    clearAttachment();
    setDraft('');
    setComposeMode('reply');
    setShowEmoji(false);
    setStatus('');
    // Show the cached last page at once; the network page replaces it.
    const cachedThread = openId ? readThreadCache(openId) : null;
    setMessages(cachedThread ?? []);
    messagesRef.current = cachedThread ?? [];
    setHasMore(false);
    setHandoff(null);
    setAtBottom(true);
    setNewBelow(0);
    if (!openId) { setOpenConvo(null); setShowInfo(false); return; }

    let cancelled = false;
    let joined = false;
    const supabase = getSupabase();
    stickToBottom.current = true;

    // Opened from a notification, the conversation may not be in the loaded
    // list. Without its row the header is blank and replying would not take
    // it over from the bot.
    const known = conversationsRef.current.find((c) => c.id === openId) ?? null;
    setOpenConvo(known);
    if (!known) {
      supabase.from('conversations').select(CONVO_COLUMNS).eq('id', openId).maybeSingle()
        .then(({ data }) => { if (!cancelled && data) setOpenConvo(data as unknown as Conversation); });
    }

    markRead(openId);
    loadHandoff(openId);

    supabase.from('messages').select(MESSAGE_COLUMNS).eq('conversation_id', openId)
      .order('id', { ascending: false }).limit(PAGE)
      .then(({ data }) => {
        if (cancelled) return;
        const page = ((data as unknown as Message[]) ?? []).slice().reverse();
        setMessages((cur) => {
          // Keep only what realtime delivered after this page; anything else
          // in `cur` is the cache, which this page supersedes.
          const newest = page.length ? page[page.length - 1].id : 0;
          return page.concat(cur.filter((m) => m.id > newest));
        });
        setHasMore(page.length === PAGE);
      });

    const filter = `conversation_id=eq.${openId}`;
    const channel = supabase
      .channel('thread-' + openId)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter }, (payload) => {
        const m = payload.new as Message;
        // Follow along only if they were at the bottom, or it is staff's own
        // message. Yanking the view while someone reads history is worse.
        const el = threadRef.current;
        if (m.role === 'agent' || !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
          stickToBottom.current = true;
        } else {
          setNewBelow((n) => n + 1);
        }
        setMessages((cur) => (cur.some((x) => x.id === m.id) ? cur : [...cur, m]));
        if (m.role === 'customer' && document.visibilityState === 'visible') markRead(m.conversation_id);
      })
      // Delivery status and receipts arrive as updates.
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter }, (payload) => {
        const m = payload.new as Message;
        setMessages((cur) => cur.map((x) => (x.id === m.id ? { ...x, ...m } : x)));
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_handoffs', filter: `chat_id=eq.${openId}` },
          () => loadHandoff(openId))
      .subscribe((s) => {
        if (s !== 'SUBSCRIBED') return;
        if (joined) syncThread();
        joined = true;
      });

    return () => { cancelled = true; supabase.removeChannel(channel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, markRead, loadHandoff]);

  const loadOlder = useCallback(async () => {
    const el = threadRef.current;
    if (!openId || !el || loadingOlder || !hasMore || messages.length === 0) return;

    const id = openId;
    setLoadingOlder(true);
    stickToBottom.current = false;
    keepOffset.current = el.scrollHeight - el.scrollTop;

    const { data } = await getSupabase().from('messages').select(MESSAGE_COLUMNS)
      .eq('conversation_id', id).lt('id', messages[0].id)
      .order('id', { ascending: false }).limit(PAGE);

    setLoadingOlder(false);
    if (id !== openIdRef.current) { keepOffset.current = null; return; }
    const older = ((data as unknown as Message[]) ?? []).slice().reverse();
    setMessages((m) => [...older, ...m]);
    setHasMore(older.length === PAGE);
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
    // With no scrollbar there is no scroll event; pull until it overflows.
    if (hasMore && !loadingOlder && el.scrollHeight <= el.clientHeight) loadOlder();
  }, [messages, hasMore, loadingOlder, loadOlder]);

  function onThreadScroll() {
    const el = threadRef.current;
    if (!el) return;
    if (el.scrollTop < 80) loadOlder();
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    stickToBottom.current = bottom;
    if (bottom !== atBottom) setAtBottom(bottom);
    if (bottom && newBelow) setNewBelow(0);
  }

  // The thread got shorter — the phone keyboard opened, the contact panel
  // narrowed it, a banner appeared. Stay on the newest message, as WhatsApp does.
  useEffect(() => {
    const el = threadRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (stickToBottom.current) el.scrollTop = el.scrollHeight; });
    ro.observe(el);
    return () => ro.disconnect();
  }, [openId]);

  function jumpToBottom() {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    stickToBottom.current = true;
    setNewBelow(0);
  }

  // Keep the last page on the device for an instant open next time.
  useEffect(() => {
    if (openId && messages.length) writeThreadCache(openId, messages);
  }, [openId, messages]);

  async function copyMessage(m: Message) {
    const text = m.body || m.media_url || '';
    if (!text) return;
    try { await navigator.clipboard.writeText(text); toast('Copied'); }
    catch { toast('Could not copy'); }
  }

  function followMedia() {
    const el = threadRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }

  // ── Presence: who is looking at, or typing in, which chat ─────────────────

  useEffect(() => {
    if (!ready || !email) return;
    const channel = getSupabase().channel('inbox-presence', { config: { presence: { key: email } } });
    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState<Presence>();
        setPresence(Object.values(state).flat().map((p) => ({ email: p.email, viewing: p.viewing, typing: p.typing })));
      })
      .subscribe((s) => {
        if (s === 'SUBSCRIBED') channel.track({ email, viewing: openIdRef.current, typing: null });
      });
    presenceRef.current = channel;
    return () => { presenceRef.current = null; getSupabase().removeChannel(channel); };
  }, [ready, email]);

  useEffect(() => {
    typingRef.current = false;
    presenceRef.current?.track({ email, viewing: openId, typing: null });
  }, [openId, email]);

  function noteTyping() {
    const ch = presenceRef.current;
    if (!ch || !openId) return;
    if (!typingRef.current) {
      typingRef.current = true;
      ch.track({ email, viewing: openId, typing: openId });
    }
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      typingRef.current = false;
      presenceRef.current?.track({ email, viewing: openIdRef.current, typing: null });
    }, 3000);
  }

  const others = (id: string, what: 'viewing' | 'typing') =>
    Array.from(new Set(presence.filter((p) => p.email !== email && p[what] === id).map((p) => staffName(p.email))));

  // ── Ownership: take over, hand back, assign, resolve ──────────────────────

  function patchConvo(id: string, patch: Partial<Conversation>) {
    setOpenConvo((c) => (c && c.id === id ? { ...c, ...patch } : c));
    setConversations((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  // chat_handoffs is the flag n8n checks before running the bot; mode mirrors
  // it so the list can show who has each chat. Taking over opens a row with no
  // expiry (unless one is already open) and claims an unowned chat; handing
  // back closes every open row and releases it.
  async function setMode(id: string, mode: 'ai' | 'human') {
    const supabase = getSupabase();
    let error = null;
    if (mode === 'human') {
      const { data: active } = await supabase.from('chat_handoffs').select('id')
        .eq('chat_id', id).eq('status', 'active').limit(1);
      if (!active?.length) {
        ({ error } = await supabase.from('chat_handoffs').insert({
          chat_id: id, status: 'active', reason: 'operator takeover', operator_id: email || null,
        }));
      }
    } else {
      ({ error } = await supabase.from('chat_handoffs')
        .update({ status: 'closed' }).eq('chat_id', id).eq('status', 'active'));
    }
    if (error) throw new Error('Could not change who has this chat: ' + error.message);

    const { error: modeError } = await supabase.from('conversations')
      .update(mode === 'human' ? { mode } : { mode, assigned_to: null }).eq('id', id);
    if (modeError) throw new Error('Could not change who has this chat: ' + modeError.message);
    if (mode === 'human') {
      // Only claim it if nobody owns it — never take a colleague's chat silently.
      await supabase.from('conversations').update({ assigned_to: email }).eq('id', id).is('assigned_to', null);
      const owner = openConvo?.id === id ? openConvo.assigned_to : null;
      patchConvo(id, { mode, assigned_to: owner ?? email });
    } else {
      patchConvo(id, { mode, assigned_to: null });
    }
    loadHandoff(id);
    refreshCounts();
  }

  async function toggleMode() {
    if (!openConvo) return;
    const next = openConvo.mode === 'human' ? 'ai' : 'human';
    try {
      await setMode(openConvo.id, next);
      toast(next === 'human' ? 'You have this conversation. The bot will stay quiet.' : 'Handed back to the bot.');
    } catch (e: any) { toast(e.message); }
  }

  async function assign(to: string | null) {
    if (!openConvo) return;
    const { error } = await getSupabase().from('conversations').update({ assigned_to: to }).eq('id', openConvo.id);
    if (error) return toast('Could not assign: ' + error.message);
    patchConvo(openConvo.id, { assigned_to: to });
    refreshCounts();
    toast(to ? `Assigned to ${to === email ? 'you' : staffName(to)}.` : 'Unassigned.');
  }

  /** Done with it: the bot takes the chat back, and a new customer message reopens it. */
  async function resolve() {
    if (!openConvo) return;
    const id = openConvo.id;
    const supabase = getSupabase();
    await supabase.from('chat_handoffs').update({ status: 'closed' }).eq('chat_id', id).eq('status', 'active');
    const patch = { status: 'resolved' as const, resolved_at: new Date().toISOString(), mode: 'ai' as const, assigned_to: null, unread: 0 };
    const { error } = await supabase.from('conversations').update(patch).eq('id', id);
    if (error) return toast('Could not resolve: ' + error.message);
    patchConvo(id, patch);
    loadHandoff(id);
    refreshCounts();
    toast('Resolved. The bot answers if they write again.');
  }

  async function reopen() {
    if (!openConvo) return;
    const patch = { status: 'open' as const, resolved_at: null };
    const { error } = await getSupabase().from('conversations').update(patch).eq('id', openConvo.id);
    if (error) return toast('Could not reopen: ' + error.message);
    patchConvo(openConvo.id, patch);
    refreshCounts();
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  /** Upload straight to the public chat-media bucket; n8n sends the file by URL. */
  async function upload(file: File, conversationId: string) {
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60) || 'file';
    const path = `${conversationId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
    const supabase = getSupabase();
    const { error } = await supabase.storage.from('chat-media').upload(path, file, {
      cacheControl: '3600', upsert: false, contentType: file.type || 'application/octet-stream',
    });
    if (error) throw new Error('Upload failed: ' + error.message);
    return supabase.storage.from('chat-media').getPublicUrl(path).data.publicUrl;
  }

  async function send() {
    const text = draft.trim();
    const id = openId;
    const note = composeMode === 'note';
    // Enter fires even while the button is disabled, so the guard is here: a
    // second Enter during a slow upload would send it twice.
    if (sending || !id || (!text && (note || !pending))) return;

    if (!note) {
      const wa = whatsappWindow(openConvo);
      if (wa && !wa.open && !confirm(
        'WhatsApp’s 24-hour window for this customer has closed. WhatsApp will most likely refuse a ' +
        'free-form message until they write again (only approved templates go through). Send anyway?')) return;
    }

    setSending(true);
    setShowEmoji(false);
    setStatus(pending && !note ? 'Uploading…' : 'Sending…');
    try {
      if (note) {
        await api('/api/reply', { body: { conversationId: id, kind: 'note', text } });
        setDraft('');
        setStatus('');
        return;
      }

      // Replying takes the chat over: leaving it with the bot would let it
      // answer over the top of you on the customer's next message. Always, not
      // only when the header says AI — the local copy can be out of date.
      await setMode(id, 'human');

      let payload: Record<string, unknown> = { conversationId: id, text };
      if (pending) {
        const url = await upload(pending.file, id);
        setStatus('Sending…');
        payload = { ...payload, kind: kindForFile(pending.file), mediaUrl: url,
                    fileName: pending.file.name, mimeType: pending.file.type || null };
      }

      stickToBottom.current = true;
      const out = await api<{ delivered: boolean; deliveryError: string }>('/api/reply', { body: payload });
      setDraft('');
      clearAttachment();
      setStatus(out.delivered ? '' : `Not delivered${out.deliveryError ? ': ' + out.deliveryError : ''}. Use Retry under the message.`);
      if (!out.delivered) toast('Saved, but not delivered to the customer.');
    } catch (e: any) {
      setStatus(e.message);
    } finally {
      setSending(false);
    }
  }

  /** Re-send a stored reply to n8n. The message row already exists, so nothing is inserted. */
  async function retryDelivery(messageId: number) {
    setRetrying(messageId);
    try {
      const out = await api<{ delivered: boolean; deliveryError: string }>('/api/reply', { body: { retryMessageId: messageId } });
      if (out.delivered) { setStatus(''); toast('Delivered.'); }
      else toast(`Still not delivered${out.deliveryError ? ': ' + out.deliveryError : ''}`);
    } catch (e: any) {
      toast(e.message);
    } finally {
      setRetrying(null);
    }
  }

  async function suggest() {
    if (!openId || suggesting) return;
    setSuggesting(true);
    try {
      const out = await api<{ text: string }>('/api/suggest', { body: { conversationId: openId } });
      setComposeMode('reply');
      setDraft(out.text);
      draftRef.current?.focus();
    } catch (e: any) {
      toast('No suggestion: ' + e.message);
    } finally {
      setSuggesting(false);
    }
  }

  // ── Composer helpers ──────────────────────────────────────────────────────

  function chooseFile(file: File | null | undefined) {
    if (!file) return;
    if (file.size === 0) return toast('That file is empty.');
    if (file.size > MAX_UPLOAD_BYTES) return toast('Files must be under 20 MB.');
    clearAttachment();
    setComposeMode('reply');
    setPending({ file, url: kindForFile(file) === 'image' ? URL.createObjectURL(file) : null });
    draftRef.current?.focus();
  }

  function clearAttachment() {
    setPending((p) => { if (p?.url) URL.revokeObjectURL(p.url); return null; });
    if (fileRef.current) fileRef.current.value = '';
  }

  /** Insert at the caret, not at the end — the operator may be mid-sentence. */
  function insertAtCursor(text: string) {
    const box = draftRef.current;
    const start = box?.selectionStart ?? draft.length;
    const end = box?.selectionEnd ?? draft.length;
    setDraft(draft.slice(0, start) + text + draft.slice(end));
    requestAnimationFrame(() => {
      if (!box) return;
      box.focus();
      box.selectionStart = box.selectionEnd = start + text.length;
    });
  }

  // Saved replies: typing "/" at the start of the box opens the picker.
  const slash = draft.match(/^\/(\S*)$/);
  const pickerItems = slash && !pickerDismissed
    ? savedReplies.filter((r) => r.shortcut.startsWith(slash[1].toLowerCase())
        || (slash[1].length > 1 && r.body.toLowerCase().includes(slash[1].toLowerCase()))).slice(0, 8)
    : [];
  const pickerOpen = !!slash && !pickerDismissed;

  function applySaved(r: SavedReply) {
    const first = (openConvo?.contact_name || '').trim().split(/\s+/)[0] || 'there';
    setDraft(r.body.replace(/\{name\}/g, first));
    requestAnimationFrame(() => draftRef.current?.focus());
  }

  useEffect(() => { setPickerIndex(0); setPickerDismissed(false); }, [slash?.[1]]);

  // Grow with the text, capped so the textarea scrolls rather than eating the thread.
  useLayoutEffect(() => {
    const box = draftRef.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = Math.min(box.scrollHeight, 140) + 'px';
  }, [draft, openId]);

  // ── Alerts and Web Push ───────────────────────────────────────────────────

  // Is this browser already subscribed?
  useEffect(() => {
    if (!ready || !alerts || !team.push || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setPushOn(!!sub))
      .catch(() => {});
  }, [ready, alerts, team.push]);

  async function enablePush() {
    if (!team.vapidPublicKey || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(team.vapidPublicKey) });
    const j = sub.toJSON();
    const { error } = await getSupabase().from('push_subscriptions').upsert({
      user_id: userId, email, endpoint: j.endpoint, p256dh: j.keys?.p256dh, auth: j.keys?.auth,
    }, { onConflict: 'endpoint' });
    if (error) throw new Error(error.message);
    setPushOn(true);
  }

  async function disablePush() {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await getSupabase().from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
      await sub.unsubscribe();
    }
    setPushOn(false);
  }

  async function toggleAlerts() {
    const next = !alerts;
    setAlerts(next);
    try { localStorage.setItem('namici-alerts', next ? 'on' : 'off'); } catch { /* private mode */ }
    if (!next) { disablePush().catch(() => {}); return; }
    ping();
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
    if (team.push && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      enablePush()
        .then(() => toast('Alerts on — including when this tab is closed.'))
        .catch((e) => toast('Alerts on in this tab. Push failed: ' + e.message));
    }
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────

  function moveSelection(step: number) {
    const list = conversationsRef.current;
    if (!list.length) return;
    const at = list.findIndex((c) => c.id === openIdRef.current);
    const next = at === -1 ? 0 : Math.min(list.length - 1, Math.max(0, at + step));
    openChat(list[next].id);
    listRef.current?.querySelectorAll<HTMLElement>('.row')[next]?.scrollIntoView({ block: 'nearest' });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (e.key === 'Escape') {
        if (photo) return closePhoto();
        if (chatMenu || appMenu) { setChatMenu(false); setAppMenu(false); return; }
        if (showSaved) return setShowSaved(false);
        if (showEmoji) return setShowEmoji(false);
        if (showInfo) return closeInfo();
        if (isTextField(e.target) && (e.target as HTMLInputElement).value) return;
        if (openIdRef.current) closeChat();
        return;
      }
      const vertical = e.key === 'ArrowDown' || e.key === 'ArrowUp';
      if (vertical && (e.altKey || !isTextField(e.target))) {
        e.preventDefault();
        moveSelection(e.key === 'ArrowDown' ? 1 : -1);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSaved, showEmoji, showInfo, photo, chatMenu, appMenu]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (!ready) return <div className="empty">Loading…</div>;

  const chips = [...channels];
  if (channelFilter && !chips.includes(channelFilter)) chips.push(channelFilter);
  chips.sort((a, b) => channelLabel(a).localeCompare(channelLabel(b)));
  const showChips = chips.length >= 2 || channelFilter !== null;

  const open = openConvo;
  const wa = whatsappWindow(open);
  const viewers = open ? others(open.id, 'viewing') : [];
  const typers = open ? others(open.id, 'typing') : [];
  const noteMode = composeMode === 'note';
  const canSend = !sending && (draft.trim().length > 0 || (!noteMode && !!pending));
  const meLabel = (who: string | null) => (who && who === email ? 'You' : staffName(who));
  const themeIcon = theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐';

  return (
    <div className={'app' + (openId ? '' : ' browsing') + (showInfo && open ? ' with-info' : '')
                    + (!online || !live ? ' net-off' : '')}>
      {(!online || !live) && (
        <div className={'netbar' + (online ? ' connecting' : '')} role="status">
          {online ? 'Connecting…' : 'Waiting for network — showing what was saved on this device'}
        </div>
      )}

      <aside className="panel side">
        {/* Phone app bar. On a desktop the same controls live in the footer. */}
        <header className="side-head">
          <span className="side-title">Chats</span>
          <button className={'bar-btn' + (alerts ? ' on' : '')} onClick={toggleAlerts}
                  aria-label={alerts ? 'Mute alerts' : 'Turn on alerts'}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M13.7 21a2 2 0 0 1-3.4 0" strokeLinecap="round" />
                {!alerts && <path d="M3 3l18 18" strokeLinecap="round" />}
              </svg>
          </button>
          <div className="menu-anchor">
            <button className="bar-btn" onClick={() => setAppMenu((v) => !v)} aria-label="Menu" aria-expanded={appMenu}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="5" r="1.9" /><circle cx="12" cy="12" r="1.9" /><circle cx="12" cy="19" r="1.9" />
              </svg>
            </button>
            {appMenu && (
              <>
                <div className="menu-scrim" onClick={() => setAppMenu(false)} />
                <div className="menu" role="menu">
                  <p className="menu-who">{email}</p>
                  {canInstall && <button role="menuitem" onClick={() => { setAppMenu(false); install(); }}>Install app</button>}
                  <button role="menuitem" onClick={() => { setAppMenu(false); setShowSaved(true); }}>Saved replies</button>
                  <button role="menuitem" onClick={() => setTheme(theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto')}>
                    Theme: {theme === 'auto' ? 'System' : theme === 'light' ? 'Light' : 'Dark'}
                  </button>
                  <button role="menuitem" className="danger" onClick={signOut}>Sign out</button>
                </div>
              </>
            )}
          </div>
        </header>

        {iosTip && (
          <div className="install-tip">
            <span>Install this app: tap <strong>Share</strong> <span aria-hidden>⎋</span> then <strong>Add to Home Screen</strong>.</span>
            <button onClick={dismissIosTip} aria-label="Dismiss">×</button>
          </div>
        )}

        <div className="search">
          <div className="search-box">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" strokeLinecap="round" />
            </svg>
            <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)}
                   placeholder="Search names or messages" type="search" />
            <kbd className="kbd">Ctrl K</kbd>
          </div>
        </div>

        <nav className="tabs" aria-label="Views">
          {TABS.map((t) => {
            const n = t.key === 'mine' ? counts.mine : t.key === 'unassigned' ? counts.unassigned
              : t.key === 'waiting' ? counts.waiting : 0;
            return (
              <button key={t.key} className={'tab' + (t.key === 'waiting' && n > 0 ? ' hot' : '')}
                      aria-pressed={tab === t.key} onClick={() => setTab(t.key)}>
                {t.label}{n > 0 && <span className="tab-n">{n}</span>}
              </button>
            );
          })}
        </nav>

        {showChips && (
          <nav className="chips" aria-label="Filter by channel">
            {[null, ...chips].map((ch) => (
              <button key={ch ?? '*'} className="chip" aria-pressed={ch === channelFilter}
                      onClick={() => setChannelFilter(ch)}>
                {ch ? channelLabel(ch) : 'All channels'}
              </button>
            ))}
          </nav>
        )}

        <div className="rows" ref={listRef} onScroll={onListScroll}>
          {conversations.length === 0 && (
            <p className="hint">
              {loadingConvos ? 'Loading…'
                : search ? `Nothing matches “${search}”.`
                : tab === 'waiting' ? 'Nobody is waiting for a person. 🎉'
                : tab === 'mine' ? 'No open chats assigned to you.'
                : tab === 'unassigned' ? 'Every open chat has an owner.'
                : tab === 'resolved' ? 'Nothing resolved yet.'
                : channelFilter ? `No ${channelLabel(channelFilter)} conversations.`
                : <>Nothing yet. Point an n8n workflow at <code>rpc/namici_inbound</code>.</>}
            </p>
          )}
          {conversations.map((c) => {
            const label = nameOf(c);
            const waiting = c.unread > 0 && c.mode === 'human' && c.status === 'open';
            const looking = others(c.id, 'viewing');
            return (
              <button key={c.id}
                      className={'row' + (waiting ? ' waiting' : '') + (c.status === 'resolved' ? ' resolved' : '')}
                      aria-current={c.id === openId} onClick={() => openChat(c.id)}>
                <span className="avatar" style={{ background: avatarFor(c.id) }}>{initials(label)}</span>
                <span className="row-main">
                  <span className="row-top">
                    <span className="row-name">{label}</span>
                    {looking.length > 0 && <span className="eye" title={`${looking.join(', ')} viewing`}>👁</span>}
                    {waiting && c.last_customer_at ? (
                      <span className="row-time late" title="Waiting for a reply since their last message">
                        waiting {ago(c.last_customer_at)}
                      </span>
                    ) : (
                      <span className="row-time" title={new Date(c.last_message_at).toLocaleString()}>
                        {ago(c.last_message_at)}
                      </span>
                    )}
                  </span>
                  <span className="row-bottom">
                    <span className="row-last">{c.last_preview || '—'}</span>
                    <span className="tags">
                      <span className="tag channel" data-ch={c.channel.toLowerCase()}>{channelLabel(c.channel)}</span>
                      {c.status === 'resolved' ? <span className="tag done">✓</span>
                        : c.assigned_to ? <span className={'tag human' + (c.assigned_to === email ? ' me' : '')}>
                            {c.assigned_to === email ? 'Me' : staffName(c.assigned_to)}</span>
                        : c.mode === 'human' ? <span className="tag human">Human</span> : null}
                      {c.unread > 0 && <span className="badge">{c.unread}</span>}
                    </span>
                  </span>
                </span>
              </button>
            );
          })}
          {loadingMoreConvos && <p className="older">Loading more…</p>}
        </div>

        <footer className="side-foot">
          <button className={'bell' + (alerts ? ' on' : '')} onClick={toggleAlerts}
                  title={alerts ? (pushOn ? 'Alerts on, also with the tab closed. Click to mute.' : 'Alerts on. Click to mute.')
                                : 'Alerts off. Click to enable.'}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M13.7 21a2 2 0 0 1-3.4 0" strokeLinecap="round" />
              {!alerts && <path d="M3 3l18 18" strokeLinecap="round" />}
            </svg>
          </button>
          <button className="bell" onClick={() => setShowSaved(true)} title="Saved replies">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" strokeLinejoin="round" />
            </svg>
          </button>
          <button className="bell" title={`Theme: ${theme}`}
                  onClick={() => setTheme(theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto')}>
            <span aria-hidden>{themeIcon}</span>
          </button>
          {canInstall && (
            <button className="bell" onClick={install} title="Install as an app">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
          <span className="who" title={email}>{email || 'Signed in'}</span>
          <button className="linkish" onClick={signOut}>Sign out</button>
        </footer>
      </aside>

      {!openId ? (
        <section className="panel empty">
          <div>
            <p>Pick a conversation</p>
            <p className="shortcuts">
              <kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> move · <kbd className="kbd">Esc</kbd> back ·{' '}
              <kbd className="kbd">Ctrl K</kbd> search · <kbd className="kbd">/</kbd> saved reply
            </p>
          </div>
        </section>
      ) : (
        <section className="panel pane" {...edgeSwipe(closeChat)}>
          <header className="pane-head">
            <button className="back" onClick={closeChat} title="Back to the list (Esc)" aria-label="Back">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {open && (
              <button className="avatar head-avatar" style={{ background: avatarFor(open.id) }}
                      onClick={openInfo} aria-label="Contact details">
                {initials(nameOf(open))}
              </button>
            )}

            <div className="pane-title" onClick={() => { if (isPhoneLayout() && open) openInfo(); }}>
              <span className="pane-line">
                <span className="pane-name">{open ? nameOf(open) : 'Conversation'}</span>
                {open && <span className={'dot ' + open.mode}
                               title={open.mode === 'ai' ? 'The bot is answering' : 'A human has this chat'} />}
              </span>
              {open && (
                <span className="pane-sub">
                  <span className="sub-channel">
                    {channelLabel(open.channel)}{open.contact_handle ? ' · ' + open.contact_handle : ''}
                  </span>
                  {wa && (
                    <span className={'wa ' + (wa.open ? (wa.left < 3 * 3600_000 ? 'soon' : 'ok') : 'closed')}
                          title="WhatsApp only allows free-form replies within 24 hours of the customer's last message">
                      {wa.open ? `${formatLeft(wa.left)} left to reply` : 'reply window closed'}
                    </span>
                  )}
                  {typers.length > 0 ? <span className="presence typing">{typers.join(', ')} typing…</span>
                    : viewers.length > 0 ? <span className="presence">{viewers.join(', ')} viewing</span> : null}
                </span>
              )}
            </div>

            {open && (
              <div className="pane-actions">
                <select className="assign desk-only" value={open.assigned_to ?? ''} title="Assign this chat"
                        onChange={(e) => assign(e.target.value || null)}>
                  <option value="">Unassigned</option>
                  {Array.from(new Set([...team.staff, ...(open.assigned_to ? [open.assigned_to] : []), email]))
                    .filter(Boolean).map((s) => <option key={s} value={s}>{s === email ? 'Me' : staffName(s)}</option>)}
                </select>
                {open.status === 'resolved'
                  ? <button className="ghost desk-only" onClick={reopen}>Reopen</button>
                  : <button className="ghost desk-only" onClick={resolve} title="Mark as done and hand back to the bot">Resolve</button>}
                <button className={'takeover ' + open.mode} onClick={toggleMode}
                        title={open.mode === 'ai' ? 'The bot is answering. Click to take over.'
                                                  : 'You are answering. Click to hand back to the bot.'}>
                  {open.mode === 'ai' ? 'Take over' : <><span className="long">Hand back to AI</span><span className="short">Hand back</span></>}
                </button>
                <button className={'icon desk-only' + (showInfo ? ' on' : '')} title="Contact details"
                        onClick={() => (showInfo ? closeInfo() : openInfo())}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" strokeLinecap="round" />
                  </svg>
                </button>
                {/* Phone: the secondary actions fold into a menu, like WhatsApp's ⋮ */}
                <div className="menu-anchor phone-only">
                  <button className="bar-btn" onClick={() => setChatMenu((v) => !v)} aria-label="More" aria-expanded={chatMenu}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="5" r="1.9" /><circle cx="12" cy="12" r="1.9" /><circle cx="12" cy="19" r="1.9" />
              </svg>
                  </button>
                  {chatMenu && (
                    <>
                      <div className="menu-scrim" onClick={() => setChatMenu(false)} />
                      <div className="menu" role="menu">
                        <button role="menuitem" onClick={openInfo}>Contact info</button>
                        <label className="menu-select">
                          <span>Assigned to</span>
                          <select value={open.assigned_to ?? ''}
                                  onChange={(e) => { setChatMenu(false); assign(e.target.value || null); }}>
                            <option value="">Nobody</option>
                            {Array.from(new Set([...team.staff, ...(open.assigned_to ? [open.assigned_to] : []), email]))
                              .filter(Boolean).map((s) => <option key={s} value={s}>{s === email ? 'Me' : staffName(s)}</option>)}
                          </select>
                        </label>
                        {open.status === 'resolved'
                          ? <button role="menuitem" onClick={() => { setChatMenu(false); reopen(); }}>Reopen</button>
                          : <button role="menuitem" onClick={() => { setChatMenu(false); resolve(); }}>Resolve</button>}
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </header>

          {open && handoff?.status === 'active' && (
            <div className={'banner ' + (handoff.reason === 'operator takeover' ? 'quiet' : 'bot')}>
              {handoff.reason === 'operator takeover'
                ? <>Taken over by {meLabel(handoff.operator_id)} {ago(handoff.started_at)} ago. The bot stays quiet.</>
                : <>
                    <strong>Bot handed over:</strong> {handoff.reason || 'no reason given'}
                    {handoff.expires_at && <span className="dim"> · bot takes back in {formatLeft(new Date(handoff.expires_at).getTime() - Date.now())}</span>}
                  </>}
            </div>
          )}
          {open?.status === 'resolved' && (
            <div className="banner quiet">
              Resolved {ago(open.resolved_at)} ago. A new message from the customer reopens it.
            </div>
          )}

          <div className="thread-wrap">
          <div className="thread" ref={threadRef} onScroll={onThreadScroll}>
            {loadingOlder && <p className="older">Loading earlier messages…</p>}
            {!hasMore && messages.length > 0 && <p className="older">Start of the conversation</p>}

            {messages.map((m, i) => {
              const prev = messages[i - 1];
              const next = messages[i + 1];
              const isNote = m.kind === 'note';
              const out = m.role !== 'customer';
              const who = (x: Message) => `${x.role}|${x.kind === 'note'}|${x.sent_by ?? ''}`;
              const newDay = !prev || dayLabel(m.created_at) !== dayLabel(prev.created_at);
              const nextNewDay = !next || dayLabel(next.created_at) !== dayLabel(m.created_at);
              const failed = m.role === 'agent' && m.delivery_status === 'failed';
              // A run from one sender reads as a single block; only the last
              // carries the avatar and stamp. A failed reply always gets its
              // own line, so Retry sits under the exact message.
              const last = !next || who(next) !== who(m) || nextNewDay || failed;
              const grouped = !newDay && prev && who(prev) === who(m);
              return (
                <div key={m.id}>
                  {newDay && <p className="daybreak"><span>{dayLabel(m.created_at)}</span></p>}
                  <div className={'turn' + (out ? ' out' : '') + (grouped ? ' grouped' : '')
                                  + (failed ? ' failed' : '') + (isNote ? ' is-note' : '')}>
                    {!out && (last && open ? (
                      <span className="avatar" style={{ background: avatarFor(open.id) }}>{initials(nameOf(open))}</span>
                    ) : <span className="avatar-gap" />)}
                    <div className="stack" {...longPress(() => copyMessage(m))}>
                      <MessageBody m={m} onMediaLoad={followMedia} onOpenImage={openPhoto} />
                      {last && (
                        <span className="stamp">
                          {isNote ? `Note · ${meLabel(m.sent_by)} · `
                            : m.role === 'ai' ? 'Bot · '
                            : m.role === 'agent' ? `${m.sent_by ? meLabel(m.sent_by) : 'Staff'} · ` : ''}
                          {failed ? (
                            <>
                              <span className="undelivered" title={m.delivery_error || 'n8n did not accept this reply'}>
                                Not delivered
                              </span>
                              {' · '}
                              <button className="retry" disabled={retrying === m.id} onClick={() => retryDelivery(m.id)}>
                                {retrying === m.id ? 'Sending…' : 'Retry'}
                              </button>
                            </>
                          ) : (
                            <>
                              <span title={new Date(m.created_at).toLocaleString()}>
                                {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </span>
                              {m.role === 'agent' && !isNote && <> <DeliveryMark status={m.delivery_status} /></>}
                            </>
                          )}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {!atBottom && (
            <button className="jump" onClick={jumpToBottom} aria-label="Scroll to the newest message">
              {newBelow > 0 && <span className="jump-n">{newBelow}</span>}
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
          </div>

          {wa && !wa.open && !noteMode && (
            <div className="banner warn">
              WhatsApp’s 24-hour window closed {ago(new Date(new Date(open!.last_customer_at!).getTime() + 24 * 3600_000).toISOString())} ago.
              Free-form replies will likely be refused until the customer writes again.
            </div>
          )}

          {pending && (
            <div className="attach-preview">
              {pending.url ? <img src={pending.url} alt="" />
                : <span className="attach-icon">{kindForFile(pending.file) === 'audio' ? '🎤' : kindForFile(pending.file) === 'video' ? '🎬' : '📎'}</span>}
              <span className="attach-name">{pending.file.name} · {(pending.file.size / 1024).toFixed(0)} KB</span>
              <button className="icon" title="Remove" onClick={clearAttachment}>×</button>
            </div>
          )}

          <div className={'composer-wrap' + (noteMode ? ' note' : '')}>
            <div className="compose-bar">
              <div className="seg" role="tablist" aria-label="Message type">
                <button role="tab" aria-selected={!noteMode} onClick={() => setComposeMode('reply')}>Reply</button>
                <button role="tab" aria-selected={noteMode} onClick={() => { setComposeMode('note'); clearAttachment(); }}
                        title="Only your team sees notes">Note</button>
              </div>
              {team.suggest && !noteMode && (
                <button className="ghost small" onClick={suggest} disabled={suggesting}
                        title="Ask the AI for a draft you can edit">
                  {suggesting ? 'Thinking…' : '✨ Suggest reply'}
                </button>
              )}
            </div>

            <div className="composer">
              {showEmoji && (
                <div className="emoji-pop">
                  {EMOJI.map((e) => <button key={e} onClick={() => insertAtCursor(e)}>{e}</button>)}
                </div>
              )}

              {pickerOpen && (
                <div className="picker" role="listbox">
                  {pickerItems.length === 0 && <p className="dim picker-empty">No saved reply matches.</p>}
                  {pickerItems.map((r, i) => (
                    <button key={r.id} role="option" aria-selected={i === pickerIndex}
                            onMouseDown={(e) => { e.preventDefault(); applySaved(r); }}>
                      <code>/{r.shortcut}</code><span>{r.body}</span>
                    </button>
                  ))}
                  <button className="picker-manage" onMouseDown={(e) => { e.preventDefault(); setShowSaved(true); }}>
                    Manage saved replies…
                  </button>
                </div>
              )}

              <button className="icon" title="Emoji" aria-expanded={showEmoji} onClick={() => setShowEmoji((v) => !v)}>
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="9" /><path d="M9 10h.01M15 10h.01M8.5 14.5a4.5 4.5 0 0 0 7 0" strokeLinecap="round" />
                </svg>
              </button>

              {!noteMode && (
                <button className="icon" title="Attach a photo, voice note, video or file" disabled={sending}
                        onClick={() => fileRef.current?.click()}>
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21.4 11.6 12.8 20.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 1 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"
                          strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
              <input ref={fileRef} type="file" hidden onChange={(e) => chooseFile(e.target.files?.[0])} />

              <textarea
                ref={draftRef}
                rows={1}
                placeholder={phone ? (noteMode ? 'Internal note' : pending ? 'Add a caption' : 'Message')
                : noteMode ? 'Internal note — the customer never sees this'
                  : pending ? 'Add a caption…'
                  : open?.mode === 'ai' ? 'Typing here takes the chat over… ( / for saved replies)'
                  : 'Write something… ( / for saved replies)'}
                value={draft}
                onChange={(e) => { setDraft(e.target.value); noteTyping(); }}
                onPaste={(e) => {
                  // Pasting a screenshot is how people actually attach images.
                  if (noteMode) return;
                  const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.kind === 'file');
                  if (!item) return;
                  e.preventDefault();
                  chooseFile(item.getAsFile());
                }}
                onKeyDown={(e) => {
                  if (pickerOpen && pickerItems.length) {
                    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setPickerIndex((i) => (i + 1) % pickerItems.length); return; }
                    if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setPickerIndex((i) => (i - 1 + pickerItems.length) % pickerItems.length); return; }
                    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applySaved(pickerItems[pickerIndex]); return; }
                  }
                  if (pickerOpen && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setPickerDismissed(true); return; }
                  // Not while an input method is composing: there Enter confirms
                  // a word (Japanese, Chinese, Korean…), it is not "send".
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
                }}
              />

              <button className="send" onClick={send} disabled={!canSend} title={noteMode ? 'Add note' : 'Send'}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 12h14M13 6l6 6-6 6" />
                </svg>
              </button>
            </div>
          </div>
          {status && <p className="send-status">{status}</p>}
        </section>
      )}

      {showInfo && open && (
        <ContactPanel convo={open} toast={toast} onClose={closeInfo}
                      onChange={(patch) => patchConvo(open.id, patch)} />
      )}

      {showSaved && (
        <SavedRepliesModal replies={savedReplies} email={email} toast={toast}
                           onClose={() => setShowSaved(false)} onChanged={loadSavedReplies} />
      )}

      {photo && <Lightbox src={photo.src} caption={photo.caption} onClose={closePhoto} />}

      <div className={'toast' + (toastMsg ? ' show' : '')} role="status">{toastMsg}</div>
    </div>
  );
}
