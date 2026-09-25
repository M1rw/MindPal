/*
 * MindPal's service worker: check-in notifications only.
 *
 * The push arrives empty (backend/infra/push/webpush.py), so no words from
 * anyone's memory pass through the push services; the notification says a
 * fixed, gentle line in the phone's language and opens the app, where the
 * greeting asks the actual question. There is deliberately no fetch handler:
 * this worker never caches or intercepts the app's requests.
 */
const LINES = {
  en: { title: 'MindPal', body: 'A quick check-in is waiting for you.' },
  ar: { title: 'MindPal', body: 'عندك سؤال صغير من MindPal، متى ما حبيت.' },
};

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  const lang = (self.navigator.language || 'en').toLowerCase().startsWith('ar') ? 'ar' : 'en';
  const line = LINES[lang];
  event.waitUntil(
    self.registration.showNotification(line.title, {
      body: line.body,
      icon: '/assets/brand/icon-128.png',
      badge: '/assets/brand/icon-128.png',
      tag: 'mindpal-check-in',
      renotify: false,
      dir: lang === 'ar' ? 'rtl' : 'ltr',
      lang,
      data: { url: '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open) return open.focus();
      return self.clients.openWindow('/');
    }),
  );
});
