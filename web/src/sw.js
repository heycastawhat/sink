// Vite injects the production shell manifest. Keep the HTML and its entry assets together;
// the first visit can load the scripts before the worker takes control. API responses never go in this cache.
const PREFIX = 'sink-shell-';
const CACHE = PREFIX + BUILD;

self.addEventListener('install', (event) => {
  const shell = [SHELL_URL, ...SHELL_ASSETS].map((url) => url.startsWith('/assets/') ? url : new Request(url, { cache: 'reload' }));
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(shell))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key === 'sink-v1' || (key.startsWith(PREFIX) && key !== CACHE)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return;

  if (request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/shared')) {
    // The online page may be newer; the offline copy belongs to this worker's build.
    event.respondWith(
      fetch(request).catch(async () => (await caches.match(SHELL_URL, { cacheName: CACHE })) || Response.error()),
    );
  } else if (url.pathname.startsWith('/assets/') || SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        // Cache lazy chunks as they are used without making the page wait for the write.
        if (res.ok && url.pathname.startsWith('/assets/')) event.waitUntil(cache.put(request, res.clone()).catch(() => {}));
        return res;
      }),
    );
  }
});

// Todo reminders (server/src/push.ts), for browsers that turned them on in Settings.
self.addEventListener('push', (event) => {
  let r = {};
  try {
    r = event.data?.json() ?? {};
  } catch {}
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
