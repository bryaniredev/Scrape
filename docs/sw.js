// Minimal service worker so the site can be installed (needed for it to appear in Android's
// Share menu). It caches nothing and only handles this site's own page loads; data and API
// requests never pass through it.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  if (event.request.mode === "navigate") event.respondWith(fetch(event.request));
});
