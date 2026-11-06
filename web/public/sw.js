// Makes the web app installable and lets it open offline. Notes themselves aren't cached: the API always goes to
// the server, so nothing private sits in the browser and a save can never come from a stale copy.
const CACHE = 'sink-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add('/')));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

// Clone before returning: the page reads the original body.
const save = (key, res) => {
  const copy = res.clone();
  caches.open(CACHE).then((cache) => cache.put(key, copy));
};

// The app's own routes all serve index.html; these pages are something else.
const notTheApp = /^\/(api|s|public|oidc|oauth|mcp|plugins|\.well-known)(\/|$)/;

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return;

  if (request.mode === 'navigate' && !notTheApp.test(url.pathname)) {
    // Network first so a deploy shows up straight away; the last copy when offline.
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok && url.pathname === '/') save('/', res);
          return res;
        })
        .catch(() => caches.match('/')),
    );
  } else if (url.pathname.startsWith('/assets/')) {
    // Hashed file names, so a cached copy is never out of date.
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.ok) save(request, res);
            return res;
          }),
      ),
    );
  }
});

// Todo reminders (server/src/push.ts), for browsers that turned them on in Settings.
self.addEventListener('push', (event) => {
  const r = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(r.title ?? 'Todo', { body: r.body, tag: r.tag, data: r, icon: '/icon-192.png', badge: '/icon-192.png' }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { path, line } = event.notification.data ?? {};
  const url = path ? `/#/n/${path.split('/').map(encodeURIComponent).join('/')}?line=${line}` : '/#/todos';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === location.origin);
      // Focus first: it's only allowed straight after the click. navigate() fails on a page this worker doesn't control.
      return open ? open.focus().then(() => open.navigate(url)).catch(() => self.clients.openWindow(url)) : self.clients.openWindow(url);
    }),
  );
});
