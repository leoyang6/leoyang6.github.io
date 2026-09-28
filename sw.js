/* 美股晨析 Service Worker：导航网络优先（保证更新），静态资源缓存优先，/api 永不缓存；
   push → 弹通知，notificationclick → 聚焦或打开对应日期页面。 */
'use strict';
const CACHE = 'stock-advisor-v81'; // 版本号变更 → activate 时清旧缓存
// 会随版本迭代的资源:走 stale-while-revalidate(先回缓存、后台取新,下次访问生效)
const REVALIDATE = ['/style.css', '/app.js', '/manifest.webmanifest'];
const SHELL = ['/', '/style.css?v=81', '/app.js?v=81', '/manifest.webmanifest', '/og.png', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  // /api/* 与任何非 GET 请求永远走网络，绝不缓存
  if (req.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  // 导航请求：网络优先，离线时退回缓存壳
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put('/', copy));
        return r;
      }).catch(() => caches.match('/'))
    );
    return;
  }
  // 静态资源：缓存优先，miss 取网并回填
  // app.js/style.css 等迭代资源:stale-while-revalidate——先回缓存保证秒开,
  // 同时后台取新版回填,下次访问用新版;UI 更新不再被旧缓存卡住
  if (REVALIDATE.includes(url.pathname)) {
    e.respondWith(
      caches.match(req).then(hit => {
        const refetch = fetch(req).then(r => {
          if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
          return r;
        }).catch(() => hit);
        return hit || refetch;
      })
    );
    return;
  }
  // 图标等长期静态资源:缓存优先,miss 取网并回填
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return r;
    }))
  );
});

self.addEventListener('push', e => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch (err) { p = {}; }
  const title = p.title || '美股晨析';
  e.waitUntil(self.registration.showNotification(title, {
    body: p.body || '',
    tag: p.tag || 'stock-advisor-daily',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: p.url || '/' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) {
          if ('navigate' in c) {
            return c.navigate(target).then((n) => (n || c).focus()).catch(() => c.focus());
          }
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
