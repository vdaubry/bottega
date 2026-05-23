// Kill-switch service worker. Bottega does not use a service worker
// anymore (see git history — the workbox precache caused a stale-bundle
// bug for clients stuck on a previous deploy). This file exists only to
// unregister whatever SW a browser may still have cached from earlier,
// wipe its caches, and force-reload the page so the next fetch goes
// straight to Vite over the network.
//
// Workbox's `registerType: 'autoUpdate'` made browsers re-fetch /sw.js
// periodically and install a new version when bytes differ — that's the
// hook we're using here. Once you're confident no clients have an old SW
// installed (a few weeks of activity is plenty), this file can be deleted.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((n) => caches.delete(n)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      client.navigate(client.url);
    }
  })());
});
