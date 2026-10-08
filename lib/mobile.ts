'use client';
/**
 * What makes the inbox feel like an installed chat app rather than a web page:
 * keyboard-aware height, an install prompt, the app-icon badge, an
 * online/offline flag, long-press, and an on-device cache so the app opens
 * instantly with the last thing you saw.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Conversation, Message } from '@/lib/inbox';

/** Installed to the home screen (or a desktop app window). */
export function isStandalone() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
}

export function isPhoneLayout() {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 820px)').matches;
}

/** isPhoneLayout as state, for wording that has to be shorter on a phone. */
export function useIsPhone() {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 820px)');
    const set = () => setPhone(mq.matches);
    set();
    mq.addEventListener('change', set);
    return () => mq.removeEventListener('change', set);
  }, []);
  return phone;
}

/**
 * iOS does not shrink 100dvh when the keyboard opens, so the composer ends up
 * under it. The visual viewport does shrink; mirror it into --app-h.
 */
export function useViewportHeight() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const set = () => document.documentElement.style.setProperty('--app-h', `${vv.height}px`);
    set();
    vv.addEventListener('resize', set);
    return () => vv.removeEventListener('resize', set);
  }, []);
}

/**
 * Chrome/Edge/Android hand us an install prompt to show on our own button.
 * iOS Safari has no prompt — only Share → Add to Home Screen — so for it we
 * show a one-time tip instead.
 */
export function useInstall() {
  const deferred = useRef<any>(null);
  const [canInstall, setCanInstall] = useState(false);
  const [iosTip, setIosTip] = useState(false);

  useEffect(() => {
    const onPrompt = (e: Event) => { e.preventDefault(); deferred.current = e; setCanInstall(true); };
    const onInstalled = () => { deferred.current = null; setCanInstall(false); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);

    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    let dismissed = false;
    try { dismissed = localStorage.getItem('namici-ios-tip') === 'off'; } catch { /* private mode */ }
    if (ios && !isStandalone() && !dismissed) setIosTip(true);

    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    const e = deferred.current;
    if (!e) return;
    e.prompt();
    await e.userChoice.catch(() => null);
    deferred.current = null;
    setCanInstall(false);
  }, []);

  const dismissIosTip = useCallback(() => {
    setIosTip(false);
    try { localStorage.setItem('namici-ios-tip', 'off'); } catch { /* private mode */ }
  }, []);

  return { canInstall, install, iosTip, dismissIosTip };
}

/** The number on the home-screen icon, like an unread count on WhatsApp. */
export function useAppBadge(count: number) {
  useEffect(() => {
    const nav = navigator as any;
    if (!nav.setAppBadge) return;
    (count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge()).catch(() => {});
  }, [count]);
}

export function useOnline() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online;
}

/**
 * Press and hold (touch) or right-click (mouse). Movement cancels it, so a
 * scroll that starts on a bubble does not trigger it.
 */
export function longPress(onHold: () => void, ms = 450) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let start = { x: 0, y: 0 };
  const cancel = () => clearTimeout(timer);
  return {
    onTouchStart: (e: React.TouchEvent) => {
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      timer = setTimeout(() => { navigator.vibrate?.(12); onHold(); }, ms);
    },
    onTouchMove: (e: React.TouchEvent) => {
      const t = e.touches[0];
      if (Math.abs(t.clientX - start.x) > 8 || Math.abs(t.clientY - start.y) > 8) cancel();
    },
    onTouchEnd: cancel,
    onTouchCancel: cancel,
    onContextMenu: (e: React.MouseEvent) => {
      // Leave the browser's own menu on links and media.
      if ((e.target as HTMLElement).closest('a, img, video, audio')) return;
      e.preventDefault();
      onHold();
    },
  };
}

/**
 * Swipe right from the left edge to go back — iOS has no back button in an
 * installed app, and this is the gesture people already use.
 */
export function edgeSwipe(onBack: () => void) {
  let start: { x: number; y: number; t: number } | null = null;
  return {
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0];
      start = t.clientX < 28 ? { x: t.clientX, y: t.clientY, t: Date.now() } : null;
    },
    onTouchEnd: (e: React.TouchEvent) => {
      if (!start) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - start.x;
      const dy = Math.abs(t.clientY - start.y);
      if (dx > 70 && dy < 60 && Date.now() - start.t < 600) onBack();
      start = null;
    },
  };
}

// ── On-device cache ─────────────────────────────────────────────────────────
// The last list and the last page of recently opened chats, so the app opens
// on what you saw last instead of a spinner, then refreshes. Cleared on sign
// out: a shared phone must not show the previous person's inbox.

const LIST_KEY = 'namici-cache-list';
const THREAD_KEY = 'namici-cache-threads';
const MAX_THREADS = 15;

export function readListCache(): Conversation[] | null {
  try { return JSON.parse(localStorage.getItem(LIST_KEY) || 'null'); } catch { return null; }
}

export function writeListCache(list: Conversation[]) {
  try { localStorage.setItem(LIST_KEY, JSON.stringify(list.slice(0, 50))); } catch { /* full or private */ }
}

export function readThreadCache(id: string): Message[] | null {
  try { return JSON.parse(localStorage.getItem(THREAD_KEY) || '{}')[id]?.messages ?? null; } catch { return null; }
}

export function writeThreadCache(id: string, messages: Message[]) {
  try {
    const all = JSON.parse(localStorage.getItem(THREAD_KEY) || '{}');
    all[id] = { at: Date.now(), messages: messages.slice(-30) };
    const keep = Object.entries(all as Record<string, { at: number }>)
      .sort((a, b) => b[1].at - a[1].at).slice(0, MAX_THREADS);
    localStorage.setItem(THREAD_KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch { /* full or private */ }
}

export function clearCaches() {
  try { localStorage.removeItem(LIST_KEY); localStorage.removeItem(THREAD_KEY); } catch { /* private mode */ }
}
