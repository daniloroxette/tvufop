// sw.js — service worker mínimo só para atender ao requisito de PWA
self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  clients.claim();
});

// Handler vazio (network-only). Mantém tudo simples e compatível com HLS.
self.addEventListener('fetch', event => {
  // Você pode implementar cache depois, se quiser.
});
