/* Fox AI service worker.
   Нужен, чтобы сайт можно было установить как приложение (ПК, Android, iPhone)
   и чтобы интерфейс открывался мгновенно. Запросы к /api/ всегда идут в сеть. */

const CACHE = "fox-ai-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // API и чужие сайты — не трогаем
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) {
    return;
  }

  // Сначала сеть (чтобы обновления сайта приходили сразу), при офлайне — кэш
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("/")))
  );
});
