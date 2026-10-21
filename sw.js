// Xóa cache app cũ chứa danh bạ nhúng. Không cache dữ liệu đăng nhập/khách hàng.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) {
    if (key.startsWith('b2b-telesales-') || key.startsWith('telesales-team-')) await caches.delete(key);
  }
  await self.clients.claim();
})()));
// Không có fetch handler: app và API luôn dùng mạng.
