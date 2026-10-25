import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import bcrypt from 'bcryptjs';

export const professions = [
  ['mc', 'MC / Event Host', 'Mic'], ['dj', 'DJ', 'Disc3'], ['promoter', 'Event Promoter', 'Megaphone'],
  ['organiser', 'Event Organiser / Planner', 'CalendarDays'], ['guide', 'Tour / Experience Guide', 'Compass'],
  ['creator', 'Influencer / Content Creator', 'Camera'], ['musician', 'Musician / Live Performer', 'Music2'],
  ['comedian', 'Comedian', 'Smile'], ['photographer', 'Photographer', 'Aperture'], ['videographer', 'Videographer', 'Video'],
].map(([id, name, icon]) => ({ id, name, icon }));
export const featureNames = { bookings: 'Service bookings', events: 'Events & tickets', tours: 'Tours & experiences', staff: 'Staff & permissions', notifications: 'Push notifications', sponsors: 'Brand partnerships & ads', showcase:'Professional reels, albums & case studies',music:'Music, mixes & audio previews',mediaKit:'Creator media kit',planning:'Event planning & run of show',clientDelivery:'Private client galleries & film reviews',directory: 'Discovery listing', customDomain: 'Custom domain' };
export const permissions = ['bookings', 'payments', 'events', 'scan', 'content', 'notifications', 'analytics', 'staff','planning','deliveries'];
export const uid = (prefix = '') => prefix + randomBytes(12).toString('hex');
export const secret = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export const now = () => new Date().toISOString();
export const json = value => JSON.stringify(value);
export const parse = (value, fallback = {}) => { try { return JSON.parse(value); } catch { return fallback; } };
export class AppError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const fail = (condition, status, message) => { if (!condition) throw new AppError(status, message); };

export function openStore(directory) {
  const dir = resolve(directory); mkdirSync(dir, { recursive: true }); mkdirSync(join(dir, 'uploads'), { recursive: true });
  const db = new DatabaseSync(join(dir, 'promote.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0, doc TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memberships (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL, permissions TEXT NOT NULL DEFAULT '[]', event_ids TEXT NOT NULL DEFAULT '[]', UNIQUE(tenant_id,user_id));
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), email TEXT NOT NULL, token TEXT NOT NULL UNIQUE, permissions TEXT NOT NULL, event_ids TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'staff');
    CREATE TABLE IF NOT EXISTS services (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), doc TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), doc TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), token TEXT NOT NULL UNIQUE, status TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, doc TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS bookings_tenant_date ON bookings(tenant_id,starts_at,ends_at,status);
    CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), event_id TEXT NOT NULL REFERENCES events(id), token TEXT NOT NULL UNIQUE, status TEXT NOT NULL, quantity INTEGER NOT NULL, expires_at TEXT NOT NULL, doc TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS orders_event ON orders(event_id,status,expires_at);
    CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), event_id TEXT NOT NULL REFERENCES events(id), order_id TEXT NOT NULL REFERENCES orders(id), code TEXT NOT NULL UNIQUE, checked_at TEXT, checked_by TEXT REFERENCES users(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS proofs (id TEXT PRIMARY KEY, tenant_id TEXT REFERENCES tenants(id), kind TEXT NOT NULL, reference_id TEXT NOT NULL, path TEXT NOT NULL, mime TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL, reference TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', reviewed_by TEXT, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, name TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL, features TEXT NOT NULL, period TEXT NOT NULL DEFAULT 'monthly', active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), status TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL, due_at TEXT NOT NULL, hold_at TEXT NOT NULL, period_key TEXT, doc TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(tenant_id,period_key));
    CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT REFERENCES users(id), endpoint TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, last_seen TEXT NOT NULL, UNIQUE(tenant_id,endpoint));
    CREATE TABLE IF NOT EXISTS notices (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), audience TEXT NOT NULL, permission TEXT, title TEXT NOT NULL, body TEXT NOT NULL, url TEXT NOT NULL, event_id TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS push_jobs (id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE, notice_id TEXT NOT NULL REFERENCES notices(id), attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', next_at TEXT NOT NULL, error TEXT, UNIQUE(subscription_id,notice_id));
    CREATE TABLE IF NOT EXISTS activity (id TEXT PRIMARY KEY, tenant_id TEXT REFERENCES tenants(id), user_id TEXT, action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL REFERENCES tenants(id), device TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS metric_time ON metrics(tenant_id,created_at,kind);
    CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, hits INTEGER NOT NULL, resets_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS domains (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), hostname TEXT NOT NULL UNIQUE, token TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), path TEXT NOT NULL UNIQUE, mime TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sponsor_campaigns (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), doc TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sponsor_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id TEXT NOT NULL REFERENCES sponsor_campaigns(id), tenant_id TEXT NOT NULL REFERENCES tenants(id), device TEXT NOT NULL, kind TEXT NOT NULL, period TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(campaign_id,device,kind,period));
    CREATE TABLE IF NOT EXISTS professional_profiles (tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),doc TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS professional_work (id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id),profession TEXT NOT NULL,kind TEXT NOT NULL,doc TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS music_tracks (id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id),profession TEXT NOT NULL,doc TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS event_plans (id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id),event_id TEXT REFERENCES events(id),doc TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS delivery_assets (id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id),path TEXT NOT NULL,preview_path TEXT NOT NULL,mime TEXT NOT NULL,name TEXT NOT NULL,size INTEGER NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS client_deliveries (id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id),token TEXT NOT NULL UNIQUE,doc TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS professional_work_tenant ON professional_work(tenant_id,created_at);
    CREATE INDEX IF NOT EXISTS music_tracks_tenant ON music_tracks(tenant_id,created_at);
    CREATE INDEX IF NOT EXISTS event_plans_tenant ON event_plans(tenant_id,event_id);
    CREATE INDEX IF NOT EXISTS delivery_assets_tenant ON delivery_assets(tenant_id,created_at);
    CREATE INDEX IF NOT EXISTS client_deliveries_tenant ON client_deliveries(tenant_id,created_at);
  `);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const setting = (key, fallback = null) => { const v = get('SELECT value FROM settings WHERE key=?', key); return v ? parse(v.value) : fallback; };
  const setSetting = (key, value) => run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, json(value));
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const audit = (tenant, user, action, detail = {}) => run('INSERT INTO activity VALUES(?,?,?,?,?,?)', uid('a_'), tenant || null, user || null, action, json(detail), now());
  return { db, dir, get, all, run, setting, setSetting, tx, audit };
}

export function readTenant(store, identifier) {
  const row = store.get('SELECT * FROM tenants WHERE id=? OR slug=?', identifier, identifier);
  return row ? { ...parse(row.doc), id: row.id, slug: row.slug, name: row.name, published: !!row.published, createdAt: row.created_at } : null;
}
export function saveTenant(store, tenant) {
  const { id, slug, name, published, createdAt, ...doc } = tenant;
  store.run('UPDATE tenants SET slug=?,name=?,published=?,doc=? WHERE id=?', slug, name, published ? 1 : 0, json(doc), id);
}
export function statusOf(store, tenant) {
  if (tenant.suspended) return 'suspended';
  if (store.setting('billingEnabled', false) && store.get("SELECT id FROM invoices WHERE tenant_id=? AND status!='paid' AND status!='void' AND hold_at<=? LIMIT 1", tenant.id, now())) return 'billing_hold';
  return 'active';
}
export function sanitizeTenant(store, tenant) {
  const { paymentAccounts, suspended, billingPlan, ...publicFields } = tenant;
  return { ...publicFields, status: statusOf(store, tenant), paymentReady: (paymentAccounts || []).some(a => a.holder && a.number), features: { ...tenant.features, directory: store.setting('directoryEnabled', true) && tenant.features.directory } };
}
export function memberOf(store, user, tenantId) {
  if (!user) return null;
  if (user.role === 'admin') return { role: 'admin', permissions, eventIds: [] };
  const row = store.get('SELECT * FROM memberships WHERE user_id=? AND tenant_id=?', user.id, tenantId);
  if (row?.role === 'staff' && readTenant(store,tenantId)?.features?.staff === false) return null;
  return row ? { id: row.id, role: row.role, permissions: parse(row.permissions, []), eventIds: parse(row.event_ids, []) } : null;
}
export function can(member, permission, eventId = null) {
  if (!member) return false;
  if (member.role === 'admin') return true;
  if (member.role === 'owner') return permissions.includes(permission);
  if (!member.permissions.includes(permission)) return false;
  return !eventId || !member.eventIds.length || member.eventIds.includes(eventId);
}
export function allowedEvents(member, rows) {
  return ['owner', 'admin'].includes(member.role) || !member.eventIds.length ? rows : rows.filter(r => member.eventIds.includes(r.id));
}
export function documents(store, table, tenantId) {
  fail(['services', 'events', 'bookings', 'orders', 'invoices', 'sponsor_campaigns'].includes(table), 500, 'Invalid collection.');
  return store.all(`SELECT * FROM ${table} WHERE tenant_id=? ORDER BY created_at DESC`, tenantId).map(row => ({ ...parse(row.doc), ...Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'doc' && key !== 'token')) }));
}
export function seedTenant(store) {
  if (store.get('SELECT id FROM tenants LIMIT 1')) {
    for(const row of store.all('SELECT id FROM tenants')){const t=readTenant(store,row.id);if(t.features?.sponsors===undefined){t.features={...t.features,sponsors:true};saveTenant(store,t);}}
    return;
  }
  const tenant = {
    id: 'tn_henry', slug: 'mchenry', name: 'MC Henry', published: true, professions: ['mc', 'guide', 'creator'],
    tagline: 'Fine Boy Wey Mumu', headline: 'Good energy.\nGreat memories.',
    bio: 'Event MC, nightlife personality, content creator and tour guide. From a night out in Cotonou to your next big celebration, let’s make it an experience to remember.',
    location: 'Cotonou, Benin Republic', areas: ['Benin Republic', 'Nigeria'], email: 'hel uemeh@gmail.com'.replace(' ', ''), phone: '+22996014959',
    accent: '#c5f36b', avatar: '/media/henry-identity.jpeg', cover: '/media/henry-soiree.jpeg',
    social: { instagram: 'https://www.instagram.com/henryhudson_official1/', tiktok: 'https://www.tiktok.com/@mc.henry01' },
    features: Object.fromEntries(Object.keys(featureNames).map(k => [k, k !== 'customDomain'])), paymentAccounts: [], verified: false,
    gallery: [{ url: '/media/henry-soiree.jpeg', caption: 'The Grand Nightlife Soirée — past event' }, { url: '/media/henry-rebirth.jpeg', caption: 'The Rebirth 3.0 — past event' }, { url: '/media/henry-identity.jpeg', caption: 'Meet MC Henry' }],
    timezone: 'Africa/Lagos', blocks: [],
  };
  const { id, slug, name, published, ...doc } = tenant;
  store.run('INSERT INTO tenants VALUES(?,?,?,?,?,?)', id, slug, name, 1, json(doc), now());
  const basics = [{ key: 'location', label: 'Where is the event?', type: 'text', required: true }, { key: 'guests', label: 'How many guests?', type: 'number', required: true }, { key: 'budget', label: 'What is your budget and currency?', type: 'text', required: false }];
  for (const service of [
    { title: 'MC & event hosting', category: 'mc', description: 'Your celebration deserves a host who brings the room together. Weddings, birthdays, private parties and corporate events.', duration: 4, questions: basics, icon: 'Mic' },
    { title: 'Tours & local experiences', category: 'guide', description: 'Explore the city, discover local spots and experience the nightlife with a guide who brings the energy.', duration: 6, questions: [{ key: 'destination', label: 'Where would you like to explore?', type: 'text', required: true }, { key: 'guests', label: 'How many people?', type: 'number', required: true }, { key: 'transport', label: 'Do you need transport?', type: 'select', options: ['Yes', 'No', 'Let’s discuss'], required: true }], icon: 'Compass' },
    { title: 'Brand collaborations', category: 'creator', description: 'Let’s create something your audience remembers. Content collaborations, brand appearances and promotional campaigns.', duration: 2, questions: [{ key: 'brand', label: 'Your brand or organisation', type: 'text', required: true }, { key: 'brief', label: 'Tell us about the collaboration', type: 'textarea', required: true }], icon: 'Sparkles' },
  ]) store.run('INSERT INTO services VALUES(?,?,?,?)', uid('svc_'), id, json({ ...service, active: true, price: 0, currency: 'NGN', priceMode: 'quote' }), now());
  store.setSetting('directoryEnabled', true);
  store.setSetting('billingEnabled', false);
  store.setSetting('platformAccounts', []);
  store.setSetting('platformName', 'Promote');
  store.setSetting('publicRegistration', true);
}
export function ensureKeys(store) {
  if (!store.setting('vapid')) {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pub = publicKey.export({ format: 'jwk' }), priv = privateKey.export({ format: 'jwk' });
    const bytes = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]);
    store.setSetting('vapid', { publicKey: bytes.toString('base64url'), privateKey: priv.d });
  }
  if (!store.setting('bootstrapHash') && !store.get("SELECT id FROM users WHERE role='admin'")) {
    const token = secret(); store.setSetting('bootstrapHash', hash(token));
    writeFileSync(join(store.dir, 'bootstrap-code.txt'), token, { mode: 0o600 });
  }
}
export async function createUser(store, { email, name, password, role = 'user' }) {
  const id = uid('usr_');
  const encoded = await bcrypt.hash(password, 12);
  try { store.run('INSERT INTO users VALUES(?,?,?,?,?,?)', id, email.toLowerCase().trim(), name.trim(), encoded, role, now()); }
  catch (e) { if (e.code?.includes('CONSTRAINT') || e.message.includes('UNIQUE')) throw new AppError(409, 'An account already exists with this email. Sign in instead.'); throw e; }
  return { id, email: email.toLowerCase().trim(), name, role };
}
export function validateQuestions(questions, answers) {
  const output = {};
  for (const q of questions) {
    const value = String(answers[q.key] ?? '').trim();
    fail(!q.required || value.length > 0, 400, `Please answer: ${q.label}`);
    fail(value.length <= 3000, 400, `Answer is too long: ${q.label}`);
    if (value && q.type === 'number') fail(Number.isFinite(Number(value)) && Number(value) >= 0, 400, `Enter a valid number: ${q.label}`);
    if (value && q.type === 'select') fail(q.options.includes(value), 400, `Choose an option: ${q.label}`);
    output[q.key] = value;
  }
  return output;
}
export function issueTickets(store, order) {
  for (let i = 0; i < order.quantity; i++) store.run('INSERT INTO tickets VALUES(?,?,?,?,?,?,?,?)', uid('tk_'), order.tenant_id, order.event_id, order.id, secret(), null, null, now());
}
export function invoiceResult(store, invoice) {
  const { doc, ...fields } = invoice;
  return { ...parse(doc), ...fields, proofs: store.all('SELECT id,status,note,created_at,amount,currency,reference FROM proofs WHERE kind=? AND reference_id=? ORDER BY created_at DESC', 'invoice', invoice.id) };
}
export function nextBillingDate(value,period,anchorDay){
  const next=new Date(value),day=anchorDay||next.getUTCDate();next.setUTCDate(1);
  if(period==='yearly')next.setUTCFullYear(next.getUTCFullYear()+1);else next.setUTCMonth(next.getUTCMonth()+1);
  const maximum=new Date(Date.UTC(next.getUTCFullYear(),next.getUTCMonth()+1,0)).getUTCDate();next.setUTCDate(Math.min(day,maximum));return next.toISOString();
}
export function sweep(store) {
  const timestamp = now();
  store.run("UPDATE orders SET status='expired' WHERE status='awaiting_payment' AND expires_at<?", timestamp);
  for (const row of store.all("SELECT * FROM bookings WHERE status='awaiting_payment'")) {
    if (parse(row.doc).payBy < timestamp) store.run("UPDATE bookings SET status='expired' WHERE id=?", row.id);
  }
  store.run('DELETE FROM sessions WHERE expires_at<?', timestamp);
  store.run('DELETE FROM limits WHERE resets_at<?', Date.now() - 86400000);
  if (!store.setting('billingEnabled', false)) return;
  for (const row of store.all('SELECT id FROM tenants')) {
    const tenant = readTenant(store, row.id);
    const sub = tenant.billingPlan;
    if (!sub || !sub.nextIssueAt || sub.nextIssueAt > timestamp) continue;
    const activated = store.setting('billingActivatedAt');
    if (activated && sub.nextIssueAt < activated) sub.nextIssueAt = activated;
    const plan = store.get('SELECT * FROM plans WHERE id=? AND active=1', sub.planId);
    if (!plan) continue;
    store.tx(() => {
      const period = sub.nextIssueAt.slice(0, 10);
      const due = new Date(sub.nextIssueAt); due.setUTCDate(due.getUTCDate() + (sub.graceDays || 7));
      const id = uid('inv_');
      store.run('INSERT OR IGNORE INTO invoices VALUES(?,?,?,?,?,?,?,?,?,?)', id, tenant.id, plan.amount === 0 ? 'paid' : 'unpaid', plan.amount, plan.currency, due.toISOString(), due.toISOString(), period, json({ title: `${plan.name} · ${period}`, planId: plan.id, features: parse(plan.features, []) }), timestamp);
      tenant.billingPlan.anchorDay ||= new Date(sub.nextIssueAt).getUTCDate();
      tenant.billingPlan.nextIssueAt = nextBillingDate(sub.nextIssueAt,plan.period,tenant.billingPlan.anchorDay); saveTenant(store, tenant);
      store.audit(tenant.id, null, 'invoice.created', { invoiceId: id });
    });
  }
}

export function metricsFor(store, tenantId) {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const counts = store.get("SELECT COUNT(DISTINCT CASE WHEN kind='visit' THEN device END) AS visitors, COUNT(CASE WHEN kind='install' THEN 1 END) AS observedInstalls, COUNT(DISTINCT CASE WHEN kind='app_open' AND created_at>=? THEN device END) AS activeAppDevices FROM metrics WHERE tenant_id=?", since, tenantId);
  const subs = store.get("SELECT COUNT(*) AS n FROM subscriptions WHERE tenant_id=? AND COALESCE(json_extract(payload,'$.publicEnabled'),CASE WHEN user_id IS NULL THEN 1 ELSE 0 END)=1", tenantId).n;
  const bookings = store.get('SELECT COUNT(*) AS n FROM bookings WHERE tenant_id=?', tenantId).n;
  const tickets = store.get('SELECT COUNT(*) AS n FROM tickets WHERE tenant_id=?', tenantId).n;
  const daily = store.all("SELECT substr(created_at,1,10) AS date, COUNT(*) AS views FROM metrics WHERE tenant_id=? AND kind='visit' AND created_at>=? GROUP BY date ORDER BY date", tenantId, since);
  const revenue = store.all("SELECT currency,SUM(amount) AS amount FROM proofs WHERE tenant_id=? AND status='approved' AND kind!='invoice' GROUP BY currency", tenantId);
  return { ...counts, subscribers: subs, bookings, tickets, daily, revenue };
}
