import express from 'express';
import {cloudUploadTools} from './cloud-uploads.mjs';
import helmet from 'helmet';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { buildPushPayload } from '@block65/webcrypto-web-push';
import { openStore, seedTenant, ensureKeys, now, hash, secret, uid, json, parse, readTenant, memberOf, can, statusOf, fail, AppError, createUser, sweep, permissions, featureNames, professions } from './core.mjs';
import { publicRoutes } from './routes-public.mjs';
import { businessRoutes } from './routes-business.mjs';
import { adminRoutes } from './routes-admin.mjs';
import { iconPng } from './png.mjs';
import { sponsorRoutes } from './sponsors.mjs';
import { makeTheme } from '../shared/theme.mjs';
import {netlifyProxyPolicy,netlifyPublicHost} from './netlify-proxy.mjs';
import {ensureProfessionalDefaults} from './professional-data.mjs';
import {professionalRoutes} from './professional-routes.mjs';
import {deliveryRoutes} from './delivery-routes.mjs';

export const root = process.env.LAMBDA_TASK_ROOT?resolve(process.env.LAMBDA_TASK_ROOT):resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function prepareAssets() {
  const directory = join(root, 'public', 'media'); mkdirSync(directory, { recursive: true });
  const files = { 'henry-soiree.jpeg': 'WhatsApp Image 2026-10-24 at 12.27.46 AM.jpeg', 'henry-rebirth.jpeg': 'WhatsApp Image 2026-10-24 at 12.27.46 AM (1).jpeg', 'henry-identity.jpeg': 'WhatsApp Image 2026-10-24 at 12.27.46 AM (4).jpeg' };
  for (const [target, source] of Object.entries(files)) if (!existsSync(join(directory, target)) && existsSync(join(root, '..', source))) copyFileSync(join(root, '..', source), join(directory, target));
}

export function createApp(options = {}) {
  const proxyPolicy=netlifyProxyPolicy(process.env);
  const store = options.store || openStore(options.dataDir || process.env.DATA_DIR || join(root, '.data'));
  if (options.seed !== false) seedTenant(store);
  ensureProfessionalDefaults(store);
  ensureKeys(store); if(!store.cloud)prepareAssets();
  const app = express();
  const production = process.env.NODE_ENV === 'production';
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.disable('x-powered-by');
  if(store.cloud){app.set('trust proxy',1);app.use((req,res,next)=>store.requestContext.run({},next));}
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'], fontSrc: ["'self'"], mediaSrc:["'self'",'blob:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], upgradeInsecureRequests: production ? [] : null } }, crossOriginEmbedderPolicy: false, strictTransportSecurity: production ? undefined : false, referrerPolicy: { policy: 'no-referrer' } }));
  app.use(express.json({ limit: '128kb' }));
  app.get('/api/health',(req,res)=>{store.get('SELECT 1');res.set('Cache-Control','no-store').json({ok:true,database:true,version:'1.0.0'});});
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const proxyHost=netlifyPublicHost(req,proxyPolicy),publicHost=proxyHost?.host||req.get('Host');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      if (req.get('X-Promote-Request') !== '1') return res.status(403).json({ error: 'Request verification failed. Refresh and try again.' });
      const origin = req.get('Origin');
      if (origin) { try { const url=new URL(origin);if (url.host.toLowerCase() !== publicHost.toLowerCase() || (production&&url.protocol!=='https:')) return res.status(403).json({ error: 'Cross-site requests are not allowed.' }); } catch { return res.status(403).json({ error: 'Invalid request origin.' }); } }
    }
    const cookie = /(?:^|;\s*)promote_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    req.sessionHash = cookie ? hash(cookie) : null;
    req.user = cookie ? store.get('SELECT u.id,u.email,u.name,u.role FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token=? AND s.expires_at>?', hash(cookie), now()) : null;
    const base = (process.env.BASE_DOMAIN || 'localhost').toLowerCase();
    const host = proxyHost?.hostname||new URL('http://'+req.get('Host')).hostname.toLowerCase();
    if (host.endsWith('.' + base)) {
      const slug = host.slice(0, -base.length - 1);
      if (!['www', 'admin'].includes(slug)) req.tenant = readTenant(store, slug);
      if (!req.tenant && !['www', 'admin'].includes(slug)) return res.status(404).json({ error: 'This business address is not active.' });
    } else if (![base, '127.0.0.1', 'localhost', 'www.' + base, 'admin.' + base].includes(host)) {
      const domain = store.get('SELECT tenant_id FROM domains WHERE hostname=? AND verified=1', host);
      if (domain) req.tenant = readTenant(store, domain.tenant_id);
      else if (production) return res.status(404).json({ error: 'This domain is not connected.' });
    }
    next();
  });
  const auth = (req, res, next) => { if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' }); next(); };
  const admin = (req, res, next) => { if (!req.user || req.user.role !== 'admin' || req.tenant) return res.status(403).json({ error: 'Techverse administrator access required.' }); next(); };
  const tenant = (req, identifier, requirePublished = false) => {
    const t = readTenant(store, identifier); fail(t && (!req.tenant || req.tenant.id === t.id), 404, 'Business not found.');
    if (requirePublished) fail(t.published && !t.suspended, 404, 'This business is not currently published.');
    return t;
  };
  const access = (req, identifier, permission, eventId, allowHold = false) => {
    fail(req.user, 401, 'Sign in to continue.');
    const t = tenant(req, identifier), m = memberOf(store, req.user, t.id);
    fail(m && (!permission || can(m, permission, eventId)), 403, 'You do not have permission for this action.');
    if (permission === 'scan') fail(!t.suspended, 423, 'This business is suspended. Contact Techverse.');
    if (!allowHold && !['GET', 'HEAD'].includes(req.method) && permission !== 'scan') fail(statusOf(store, t) === 'active', 423, 'This account is on hold. The owner can resolve this in Billing.');
    return { t, m };
  };
  const feature = (t, name) => fail(t.features?.[name], 403, `${featureNames[name] || name} is not enabled for this business.`);
  const limited = (req, bucket, maximum = 30, duration = 3600000) => {
    const key = hash(`${req.ip}:${bucket}`), timestamp = Date.now();
    const row = store.get('SELECT * FROM limits WHERE key=?', key);
    if (!row || row.resets_at <= timestamp) store.run('INSERT INTO limits VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET hits=1,resets_at=excluded.resets_at', key, 1, timestamp + duration);
    else { fail(row.hits < maximum, 429, 'Too many requests. Please try again later.'); store.run('UPDATE limits SET hits=hits+1 WHERE key=?', key); }
  };
  const logIn = (req, res, user) => {
    const token = secret(), old = /(?:^|;\s*)promote_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    if (old) store.run('DELETE FROM sessions WHERE token=?', hash(old));
    store.run('INSERT INTO sessions VALUES(?,?,?)', hash(token), user.id, new Date(Date.now() + 7 * 86400000).toISOString());
    res.cookie('promote_session', token, { httpOnly: true, sameSite: 'lax', secure: production, path: '/', maxAge: 7 * 86400000 });
  };
  const notice = (tenantId, audience, title, body, url, permission = null, eventId = null) => {
    const t = readTenant(store, tenantId), id = uid('notice_');
    store.run('INSERT INTO notices VALUES(?,?,?,?,?,?,?,?,?)', id, tenantId, audience, permission, title, body, url, eventId, now());
    for (const sub of store.all('SELECT * FROM subscriptions WHERE tenant_id=?', tenantId)) {
      if (audience === 'public' && !(parse(sub.payload).publicEnabled??!sub.user_id)) continue;
      if (audience === 'private') {
        if (!sub.user_id) continue;
        const u = store.get('SELECT id,role FROM users WHERE id=?', sub.user_id), m = memberOf(store, u, tenantId);
        if (!m || (permission && !can(m, permission, eventId))) continue;
      }
      if (!t.features?.notifications && audience === 'public') continue;
      store.run('INSERT OR IGNORE INTO push_jobs VALUES(?,?,?,?,?,?,?)', uid('job_'), sub.id, id, 0, 'pending', now(), null);
    }
    return id;
  };
  let sending = false;
  const flushPush = async ({deadline=Date.now()+18000}={}) => {
    if (sending) return; sending = true;
    try {
      const keys = store.setting('vapid');
      for (const candidate of store.all("SELECT j.*,s.payload,s.endpoint,s.user_id,s.tenant_id,n.title,n.body,n.url,n.audience,n.permission,n.event_id FROM push_jobs j JOIN subscriptions s ON j.subscription_id=s.id JOIN notices n ON j.notice_id=n.id WHERE j.status IN ('pending','processing') AND j.next_at<=? ORDER BY j.next_at LIMIT 25", now())) {
        if(Date.now()>deadline)break;
        const job=store.tx(()=>{const fresh=store.get('SELECT status,next_at FROM push_jobs WHERE id=?',candidate.id);if(!['pending','processing'].includes(fresh?.status)||fresh.next_at>now())return null;store.run("UPDATE push_jobs SET status='processing',next_at=? WHERE id=?",new Date(Date.now()+120000).toISOString(),candidate.id);return candidate;});if(!job)continue;
        const t = readTenant(store, job.tenant_id);
        if(job.audience==='public'&&!(parse(job.payload).publicEnabled??!job.user_id)){store.run("UPDATE push_jobs SET status='cancelled' WHERE id=?",job.id);continue;}
        if (job.audience === 'private') {
          const u = store.get('SELECT id,role FROM users WHERE id=?', job.user_id || ''), m = memberOf(store, u, job.tenant_id);
          if (!m || (job.permission && !can(m, job.permission, job.event_id))) { store.run("UPDATE push_jobs SET status='cancelled' WHERE id=?", job.id); continue; }
        }
        try {
          const payload = await buildPushPayload({ data: { title: `${t.name} · ${job.title}`, body: job.body, url: job.url, icon: `/api/brand/${t.slug}/icon.png?size=192`, tag: job.notice_id }, options: { ttl: 86400 } }, parse(job.payload), { ...keys, subject: process.env.VAPID_SUBJECT || 'mailto:notifications@example.com' });
          const response = await fetch(job.endpoint, { ...payload, signal: AbortSignal.timeout(10000) });
          if ([404, 410].includes(response.status)) { store.run('DELETE FROM subscriptions WHERE id=?', job.subscription_id); continue; }
          if (!response.ok) throw new Error(`Push service returned ${response.status}`);
          store.run("UPDATE push_jobs SET status='sent',attempts=attempts+1,error=NULL WHERE id=?", job.id);
        } catch (e) {
          store.run('UPDATE push_jobs SET attempts=attempts+1,status=?,next_at=?,error=? WHERE id=?', job.attempts >= 4 ? 'failed' : 'pending', new Date(Date.now() + 60000 * 2 ** job.attempts).toISOString(), String(e.message).slice(0, 180), job.id);
        }
      }
    } finally { sending = false; }
  };
  let upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 10, fieldSize: 4096, fieldNameSize: 100 } });
  let mediaUpload = multer({storage:multer.memoryStorage(),limits:{fileSize:40*1024*1024,files:1,fields:10,fieldSize:4096}});
  const tasks = [];
  const ctx = { store, auth, admin, tenant, access, feature, limited, logIn, notice, upload, mediaUpload, flushPush, tasks,production };
  if(store.cloud){const tools=cloudUploadTools(ctx);ctx.upload=tools.wrap(upload);ctx.mediaUpload=tools.wrap(mediaUpload);app.post('/api/uploads/start',tools.start);}

  app.get('/api/bootstrap', (req, res) => res.json({ liveTransport:store.cloud?'poll':'sse', setupRequired: !store.get("SELECT id FROM users WHERE role='admin'"), professions: store.setting('professions', professions), permissions, featureNames, platformName:store.setting('platformName','Promote'), baseDomain:process.env.BASE_DOMAIN||'localhost', tenantRouting:process.env.TENANT_ROUTING==='path'?'path':'subdomain', requireTenantHost:production&&process.env.TENANT_ROUTING!=='path', directoryEnabled: store.setting('directoryEnabled', true), registrationEnabled: store.setting('publicRegistration', true), tenant: req.tenant ? { slug: req.tenant.slug, name: req.tenant.name } : null }));
  const credentials = z.object({ email: z.email().max(180), password: z.string().min(10).max(128), name: z.string().trim().min(2).max(100) });
  app.post('/api/setup', async (req, res) => {
    limited(req, 'setup', 10); fail(!req.tenant && !store.get("SELECT id FROM users WHERE role='admin'"), 409, 'Techverse is already set up.');
    const body = credentials.parse(req.body);
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    fail((!production && local) || hash(String(req.body.code || '')) === store.setting('bootstrapHash'), 403, 'Enter the bootstrap code from the server’s .data/bootstrap-code.txt file.');
    const user = await createUser(store, { ...body, role: 'admin' });
    store.run('INSERT INTO memberships VALUES(?,?,?,?,?,?)', uid('mem_'), 'tn_henry', user.id, 'owner', json(permissions), '[]');
    store.setSetting('bootstrapHash', null); store.audit(null, user.id, 'platform.setup'); logIn(req, res, user); res.status(201).json({ user });
  });
  app.post('/api/auth/login', async (req, res) => {
    limited(req, 'login', 15, 15 * 60000);
    const input = z.object({ email: z.email(), password: z.string().min(1).max(128) }).parse(req.body);
    const user = store.get('SELECT * FROM users WHERE email=?', input.email.toLowerCase());
    const valid = await bcrypt.compare(input.password, user?.password || '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
    fail(user && valid, 401, 'Email or password is incorrect.');
    if (req.tenant) fail(memberOf(store, user, req.tenant.id), 403, 'This account does not have access to this business.');
    logIn(req, res, user); res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  });
  app.post('/api/auth/logout', (req, res) => {
    const cookie = /(?:^|;\s*)promote_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    if (cookie) store.run('DELETE FROM sessions WHERE token=?', hash(cookie));
    if(req.user)for(const sub of store.all('SELECT * FROM subscriptions WHERE user_id=?',req.user.id)){if(parse(sub.payload).publicEnabled??false)store.run('UPDATE subscriptions SET user_id=NULL WHERE id=?',sub.id);else store.run('DELETE FROM subscriptions WHERE id=?',sub.id);}
    res.clearCookie('promote_session', { path: '/' }); res.json({ ok: true });
  });
  app.get('/api/auth/me', (req, res) => {
    const memberships = req.user ? store.all('SELECT m.*,t.name,t.slug FROM memberships m JOIN tenants t ON m.tenant_id=t.id WHERE m.user_id=?', req.user.id).map(m => ({ ...m, permissions: parse(m.permissions, []), eventIds: parse(m.event_ids, []) })) : [];
    res.json({ user: req.user || null, memberships });
  });
  app.post('/api/auth/password', auth, async (req, res) => {
    const input = z.object({ current: z.string().max(128), password: z.string().min(10).max(128) }).parse(req.body);
    const user = store.get('SELECT * FROM users WHERE id=?', req.user.id); fail(await bcrypt.compare(input.current, user.password), 400, 'Current password is incorrect.');
    store.run('UPDATE users SET password=? WHERE id=?', await bcrypt.hash(input.password, 12), user.id); store.run('DELETE FROM sessions WHERE user_id=?', user.id); logIn(req, res, user); res.json({ ok: true });
  });
  app.get('/api/brand/:slug/manifest.webmanifest', (req, res) => {
    const t = req.params.slug === 'platform' ? null : tenant(req, req.params.slug);
    const slug = t?.slug || 'platform', canonicalHost = process.env.BASE_DOMAIN || 'localhost';
    const onTenantHost = !!req.tenant;
    const start = t ? (onTenantHost ? '/' : `/p/${slug}`) : '/';
    res.type('application/manifest+json').set('Cache-Control', 'public,max-age=300').json({ id: t ? `/app/${t.id}` : '/app/platform', name: t?.name || 'Promote by Techverse', short_name: (t?.name || 'Promote').slice(0, 25), description: t?.bio || 'Your people. Your stage. Your own app.', start_url: start, scope: '/', display: 'standalone', background_color: makeTheme(t?.accent,t?.themeMode).background, theme_color: makeTheme(t?.accent,t?.themeMode).background, icons: [192,512].map(size => ({ src: `/api/brand/${slug}/icon.png?size=${size}&v=${t?.brandVersion||'1'}`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any maskable' })), shortcuts: t ? [{ name: 'Book now', url: `${start === '/' ? '' : start}/book` }, { name: 'Events', url: `${start === '/' ? '' : start}/events` }] : [] });
  });
  app.get('/api/brand/:slug/icon.svg', (req, res) => {
    const t = req.params.slug === 'platform' ? null : tenant(req, req.params.slug);
    const letters = (t?.name || 'Promote').split(/\s+/).map(w => w[0]).slice(0, 2).join('').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    res.type('image/svg+xml').send(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#101413"/><circle cx="256" cy="256" r="180" fill="${t?.accent || '#c5f36b'}"/><text x="256" y="300" font-family="Arial,sans-serif" font-weight="900" font-size="145" text-anchor="middle" fill="#101413">${letters}</text></svg>`);
  });
  app.get('/api/brand/:slug/icon.png', async (req, res) => {
    const t = req.params.slug === 'platform' ? null : tenant(req, req.params.slug);
    const size = req.query.size === '512' ? 512 : 192;
    res.type('png').set('Cache-Control', 'public,max-age=300').send(await iconPng(t, size, store.dir,store,root));
  });
  app.get('/api/live/:slug', (req, res) => {
    if(store.cloud){const t=tenant(req,req.params.slug),member=memberOf(store,req.user,t.id);return res.json({notices:store.all('SELECT * FROM notices WHERE tenant_id=? AND created_at>? ORDER BY created_at,id LIMIT 50',t.id,String(req.query.since||now())).filter(n=>n.audience==='public'||(member&&(!n.permission||can(member,n.permission,n.event_id))))});}
    const t = tenant(req, req.params.slug), member = memberOf(store, req.user, t.id);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
    let last = req.get('Last-Event-ID') || req.query.since || now(), closed = false;
    res.write('retry: 5000\n\n');
    const send = () => {
      if (closed) return;
      const currentMember = memberOf(store, req.user, t.id);
      if (member && (!currentMember || !store.get('SELECT token FROM sessions WHERE token=? AND expires_at>?', req.sessionHash || '', now()))) { res.end(); return; }
      const rows = store.all('SELECT * FROM notices WHERE tenant_id=? AND created_at>? ORDER BY created_at,id LIMIT 50', t.id, last);
      for (const n of rows) {
        last = n.created_at;
        if (n.audience !== 'public' && (!currentMember || (n.permission && !can(currentMember, n.permission, n.event_id)))) continue;
        res.write(`id: ${n.created_at}\ndata: ${JSON.stringify({ id: n.id, title: n.title, body: n.body, url: n.url, createdAt: n.created_at })}\n\n`);
      }
      res.write(': connected\n\n');
    };
    send(); const interval = setInterval(send, 2500); req.on('close', () => { closed = true; clearInterval(interval); });
  });
  publicRoutes(app, ctx); businessRoutes(app, ctx); adminRoutes(app, ctx); sponsorRoutes(app,ctx); professionalRoutes(app,ctx); deliveryRoutes(app,ctx);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
  app.get('/sw.js', (req, res) => res.set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' }).type('application/javascript').sendFile(join(root, 'public', 'sw.js')));
  app.use(express.static(join(root, 'public'), { maxAge: '1h' }));
  app.use(express.static(join(root, 'dist'), { index: false, maxAge: '1h' }));
  app.get('/{*path}', (req, res) => { if (existsSync(join(root, 'dist', 'index.html'))) res.set('Cache-Control', 'no-cache').sendFile(join(root, 'dist', 'index.html')); else res.type('text').send('Promote API is running. Open http://localhost:5173 for the development app, or run npm run build.'); });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.removeHeader('Content-Type');
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? (req.path.includes('delivery-assets')?'Private photos must be smaller than 20 MB; review films must be smaller than 40 MB.':req.path.includes('professional-assets')?'Audio must be smaller than 25 MB; videos 40 MB; images 8 MB.':req.path.includes('sponsor-assets')?'Video must be smaller than 40 MB; images must be smaller than 8 MB.':'Image must be smaller than 8 MB.') : 'Upload one file at a time.' });
    if (!error.status) console.error('[promote]', error.message);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Something went wrong. Please try again.' });
  });
  const runScheduled = () => { sweep(store); for (const task of tasks) task(); };
  const tick = options.scheduler === false ? null : setInterval(() => { try { runScheduled(); void flushPush(); } catch (e) { console.error('[scheduler]', e.message); } }, 15000); tick?.unref();
  return { app, store, close: () => { clearInterval(tick); store.db.close(); }, flushPush, runScheduled };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app } = createApp();
  const portIndex = process.argv.indexOf('--port');
  const port = Number(process.env.PORT || (portIndex >= 0 ? process.argv[portIndex + 1] : 3000)), host = process.env.HOST || '127.0.0.1';
  app.listen(port, host, () => console.log(`Promote is running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));
}
