// Сервис-воркер: оболочка приложения работает офлайн, данные всегда берутся с сервера.
// Стратегия «сначала сеть, при ошибке — кэш», чтобы пользователи всегда получали свежую версию.
const CACHE = 'sh-shell-v18';
const SHELL = ['./', 'index.html', 'css/style.css', 'js/main.js', 'js/api.js', 'js/ui.js', 'js/util.js', 'js/config.js', 'js/local-backend.js', 'js/maps.js',
  'js/screens-common.js', 'js/screens-worker.js', 'js/screens-contractor.js', 'js/screens-admin.js', 'icons/icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // API (Supabase), карты и Telegram — только через сеть
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); } return r; }).catch(() => caches.match(e.request).then((m) => m || caches.match('index.html'))));
});
