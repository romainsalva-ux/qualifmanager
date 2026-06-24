const CACHE_NAME = 'qualifmanager-v2';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Laisser passer toutes les requêtes sans interférer
  // Le SW sert uniquement à activer le mode PWA standalone
  return;
});
