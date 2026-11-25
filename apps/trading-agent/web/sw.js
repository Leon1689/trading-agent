// Cache only immutable presentation resources. Account/session/API responses never enter CacheStorage.
const CACHE = 'trading-agent-shell-v3.3';
const SHELL = ['/styles.css','/ui-model.js','/icon.svg','/manifest.webmanifest'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => (key.startsWith('pi-trader-shell-') || key.startsWith('trading-agent-shell-')) && key !== CACHE).map(key => caches.delete(key))))));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).then(response => { if (response.ok) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request,copy)); } return response; }).catch(() => caches.match(event.request)));
});
