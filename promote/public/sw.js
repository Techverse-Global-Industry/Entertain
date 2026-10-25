const STATIC_CACHE = 'promote-static-v2';
const OFFLINE = '/offline.html';
self.addEventListener('install', event => { event.waitUntil(caches.open(STATIC_CACHE).then(cache => cache.add(OFFLINE))); });
self.addEventListener('activate', event => { event.waitUntil(Promise.all([caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('promote-') && k !== STATIC_CACHE).map(k => caches.delete(k)))), self.clients.claim()])); });
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if(event.data?.type==='BRAND'){
    const brand=event.data.brand||{},escape=value=>String(value||'').slice(0,100).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),colour=(value,fallback)=>/^#[0-9a-f]{6}$/i.test(value)?value:fallback;
    const name=escape(brand.name||'Promote'),background=colour(brand.background,'#101413'),text=colour(brand.text,'#f4f4e9'),accent=colour(brand.accent,'#c5f36b'),ink=colour(brand.onAccent,'#111111'),muted=colour(brand.muted,'#aab2a7');
    const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="${background}"><title>You’re offline · ${name}</title><style>body{margin:0;background:${background};color:${text};font:16px system-ui;display:grid;place-items:center;min-height:100vh}main{max-width:430px;padding:32px}b{color:${accent};letter-spacing:.15em;font-size:12px}h1{font-size:42px;letter-spacing:-2px;line-height:1.12}p{color:${muted};line-height:1.8}a{display:inline-flex;margin-top:20px;padding:14px 24px;background:${accent};color:${ink};border-radius:30px;text-decoration:none;font-weight:650}</style><main><b>${name}</b><h1>A little connection<br>goes a long way.</h1><p>You’re offline. Connect to check the latest details, send a booking request, or retrieve your tickets. Your app will be ready when you are.</p><a href="/">Try again ↗</a></main></html>`;
    event.waitUntil(caches.open(STATIC_CACHE).then(cache=>cache.put(OFFLINE,new Response(html,{headers:{'Content-Type':'text/html;charset=utf-8'}}))));
  }
});
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== 'GET') return;
  // Video byte ranges must reach the server intact; CacheStorage rejects partial responses.
  if(request.headers.has('range') || /\.(mp4|webm)$/i.test(url.pathname)) return;
  if (request.mode === 'navigate') { event.respondWith(fetch(request).catch(() => caches.match(OFFLINE))); return; }
  // Private records, payment screenshots, QR codes and authenticated pages never enter the cache.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/dashboard') || url.pathname.startsWith('/admin') || url.pathname.startsWith('/manage') || url.pathname.startsWith('/invite') || url.pathname.startsWith('/login')) return;
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/media/')) event.respondWith(caches.open(STATIC_CACHE).then(async cache => { const cached = await cache.match(request); if (cached) return cached; const response = await fetch(request); if (response.status===200 && (!url.pathname.startsWith('/media/') || response.headers.get('content-type')?.startsWith('image/'))) await cache.put(request, response.clone()).catch(()=>{}); return response; }));
});
self.addEventListener('push', event => {
  let data = {}; try { data = event.data?.json() || {}; } catch { data = { title: 'New update', body: event.data?.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'New update', { body: data.body || '', icon: data.icon || '/api/brand/platform/icon.png?size=192', badge: data.icon || '/api/brand/platform/icon.png?size=192', tag: data.tag, data: { url: data.url || '/' } }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clients => { const existing = clients.find(client => new URL(client.url).pathname === target.pathname); if (existing) return existing.focus(); return self.clients.openWindow(target.href); }));
});
