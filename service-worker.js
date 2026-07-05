// Minimal service worker: exists mainly to receive push events and show
// a notification even when this app isn't open / the phone is locked.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  self.clients.claim();
});

self.addEventListener('push', (event) => {
  let data = { title: 'today.sched', body: 'Timer update.' };
  try {
    if (event.data) data = event.data.json();
  } catch (e) { /* fall back to default text above */ }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      vibrate: [200, 100, 200],
      tag: 'today-sched-timer',
    })
  );
});

// tapping the notification brings the app to the foreground
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clientsArr) => {
      const existing = clientsArr.find((c) => c.url.includes(self.registration.scope));
      if (existing) return existing.focus();
      return self.clients.openWindow('./index.html');
    })
  );
});
