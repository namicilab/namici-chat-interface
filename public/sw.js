/**
 * namici-ci service worker.
 *
 *  - Opens offline: the app shell (page, scripts, styles, icons) is cached, so
 *    an installed app starts like a native one and shows the conversations
 *    saved on the device instead of the browser's dinosaur.
 *  - Never serves stale data: pages are network-first (the cache is only for
 *    when there is no network), API and Supabase calls are not cached at all.
 *  - Web Push alerts and the app-icon badge while no tab is open.
 *
 * Bump VERSION when this file changes so old caches are dropped.
 */

const VERSION = 'v2';
const SHELL = `namici-shell-${VERSION}`;
const ASSETS = `namici-assets-${VERSION}`;
const PRECACHE = ['/', '/login', '/offline.html', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL)
      // One missing URL must not stop the worker installing.
      .then((c) => Promise.all(PRECACHE.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = [SHELL, ASSETS];
    for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // Supabase, n8n, media: straight to the network
  if (url.pathname.startsWith('/api/')) return;

  // Next fingerprints these, so a cached copy is always the right one.
  if (url.pathname.startsWith('/_next/static/') || /\.(png|svg|ico|webmanifest)$/.test(url.pathname)) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) (await caches.open(ASSETS)).put(req, res.clone());
      return res;
    })());
    return;
  }

  // Pages: the network when there is one, the last copy when there is not.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(SHELL)).put(url.pathname === '/' ? '/' : req, res.clone());
        return res;
      } catch {
        return (await caches.match(req, { ignoreSearch: true }))
          || (await caches.match('/'))
          || (await caches.match('/offline.html'));
      }
    })());
  }
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { /* plain text push */ }
  e.waitUntil((async () => {
    await self.registration.showNotification(data.title || 'New message', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // One notification per conversation, replaced as more messages arrive.
      tag: data.conversationId || 'namici',
      renotify: true,
      vibrate: [80, 40, 80],
      data: { conversationId: data.conversationId || null },
    });
    // A dot or count on the home-screen icon until the app is opened.
    if (self.navigator.setAppBadge) {
      const open = await self.registration.getNotifications();
      self.navigator.setAppBadge(open.length).catch(() => {});
    }
  })());
});

// Land in that conversation: reuse an open inbox window if there is one.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.conversationId;
  e.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const tab = tabs.find((t) => new URL(t.url).origin === self.location.origin);
    if (tab) {
      await tab.focus();
      if (id) tab.postMessage({ type: 'open-conversation', conversationId: id });
      return;
    }
    await self.clients.openWindow(id ? `/?c=${encodeURIComponent(id)}` : '/');
  })());
});
