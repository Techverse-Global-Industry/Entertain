import {putFile,removeFile,fileInfo,sendFile} from './storage.mjs';
import { z } from 'zod';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { fail, uid, hash, secret, now, json, parse, permissions, professions, featureNames, createUser, readTenant, sanitizeTenant, statusOf, saveTenant, documents, validateQuestions, issueTickets, memberOf, can, sweep } from './core.mjs';
import { validateImage } from './png.mjs';
import {publicStudio,addServiceTemplates,moduleFor,catalogue} from './professional-data.mjs';
import {professionFor} from '../shared/professions.mjs';
import {requireEventFeature} from './professional-events.mjs';

export const currencySchema = z.enum(['NGN', 'XOF', 'GHS', 'USD', 'EUR']);
export const contactSchema = z.object({ name: z.string().trim().min(2).max(120), email: z.email().max(180), phone: z.string().trim().min(6).max(40) });
const slugSchema = z.string().regex(/^[a-z][a-z0-9-]{2,35}$/, 'Use 3–36 lowercase letters, numbers or hyphens, starting with a letter.').refine(s => !['admin', 'www', 'api', 'app', 'platform', 'billing', 'mail', 'support', 'techverse', 'promote'].includes(s), 'This name is reserved.');
const publicEvent = (row) => { const { staffNotes, ...doc } = parse(row.doc); return { ...doc, id: row.id, tenant_id: row.tenant_id }; };

export function publicRoutes(app, ctx) {
  const { store, tenant, access, feature, limited, logIn, notice, upload, auth } = ctx;
  const guestRow = (req, table, id) => {
    const token = req.get('Authorization')?.replace(/^Bearer /, '') || '';
    const row = store.get(`SELECT * FROM ${table} WHERE id=?`, id);
    fail(row && token && row.token === hash(token), 404, 'This private link is invalid or has expired.');
    tenant(req, row.tenant_id); return row;
  };
  app.get('/api/directory', (req, res) => {
    const enabled = store.setting('directoryEnabled', true);
    const rows = enabled ? store.all('SELECT id FROM tenants WHERE published=1').map(r => readTenant(store, r.id)).filter(t => t.features.directory && !t.suspended && (!req.tenant || req.tenant.id === t.id)).map(t => sanitizeTenant(store, t)) : [];
    res.json({ enabled, businesses: rows });
  });
  app.get('/api/public/:slug', (req, res) => {
    const t = tenant(req, req.params.slug);
    fail((t.published && !t.suspended) || memberOf(store, req.user, t.id), 404, 'This business is not currently published.');
    const events = (t.features.events||t.features.tours) ? store.all('SELECT * FROM events WHERE tenant_id=? ORDER BY created_at DESC', t.id).map(publicEvent).filter(e => e.published&&(e.kind==='tour'?t.features.tours&&moduleFor(store,t,'tours'):t.features.events)) : [];
    const available = events.map(event => {
      const held = store.get("SELECT COALESCE(SUM(quantity),0) AS n FROM orders WHERE event_id=? AND (status IN ('confirmed','awaiting_review') OR (status='awaiting_payment' AND expires_at>?))", event.id, now()).n;
      return { ...event, remaining: Math.max(0, event.capacity - held) };
    });
    res.json({ business: sanitizeTenant(store, t),professional:publicStudio(store,t),services: t.features.bookings ? documents(store, 'services', t.id).filter(s => t.professions.includes(s.category)&&s.active && (!professionFor(s.category,catalogue(store)).modules.includes('tours') || t.features.tours)).sort((a,b) => { const rank = service => { const i = t.professions.indexOf(service.category); return i < 0 ? 99 : i; }; return rank(a)-rank(b); }) : [], events: available, announcements: store.all("SELECT id,title,body,url,created_at FROM notices WHERE tenant_id=? AND audience='public' ORDER BY created_at DESC LIMIT 10", t.id) });
  });
  app.get('/api/public/:slug/availability', (req, res) => {
    const t = tenant(req, req.params.slug, true);
    sweep(store);
    const unavailable = store.all("SELECT starts_at,ends_at FROM bookings WHERE tenant_id=? AND status IN ('awaiting_payment','awaiting_review','confirmed') AND ends_at>=?", t.id, now());
    const departures=store.all('SELECT doc FROM events WHERE tenant_id=?',t.id).map(row=>parse(row.doc)).filter(event=>event.kind==='tour'&&event.published&&!event.cancelled&&event.endsAt>=now()).map(event=>({starts_at:event.startsAt,ends_at:event.endsAt}));
    res.json({ unavailable:[...unavailable,...departures], blocks: t.blocks || [], timezone: t.timezone || 'Africa/Lagos' });
  });
  app.post('/api/register', async (req, res) => {
    limited(req, 'registration', 8); fail(store.setting('publicRegistration', true) && !req.tenant, 403, 'Contact Techverse to create a business account.');
    fail(store.get("SELECT id FROM users WHERE role='admin'"), 409, 'Techverse needs to complete initial setup first.');
    const input = z.object({ name: z.string().trim().min(2).max(100), email: z.email().max(180), password: z.string().min(10).max(128), businessName: z.string().trim().min(2).max(80), slug: slugSchema, professions: z.array(z.enum(store.setting('professions', professions).map(p => p.id))).min(1).max(20) }).parse(req.body);
    fail(!readTenant(store, input.slug), 409, 'This business address is already taken. Choose another.');
    const user = await createUser(store, input);
    let business;
    store.tx(() => {
      const id = uid('tn_'), { businessName, slug } = input;
      const doc = { professions: input.professions, tagline: '', headline: professionFor(input.professions[0],catalogue(store)).title, bio: '', location: '', areas: [], accent: '#c5f36b', avatar: '', cover: '', social: {}, gallery: [], email: input.email, phone: '', paymentAccounts: [], features: Object.fromEntries(Object.keys(featureNames).map(k => [k, k !== 'customDomain'])), timezone: 'Africa/Lagos', blocks: [], verified: false };
      store.run('INSERT INTO tenants VALUES(?,?,?,?,?,?)', id, slug, businessName, 0, json(doc), now());
      store.run('INSERT INTO memberships VALUES(?,?,?,?,?,?)', uid('mem_'), id, user.id, 'owner', json(permissions), '[]');
      store.audit(id, user.id, 'business.created'); business = readTenant(store, id);addServiceTemplates(store,business);
    });
    logIn(req, res, user); res.status(201).json({ user, business });
  });
  app.post('/api/public/:slug/bookings', (req, res) => {
    limited(req, 'booking', 20); const t = tenant(req, req.params.slug, true); feature(t, 'bookings');
    fail(statusOf(store, t) === 'active', 423, 'New bookings are temporarily unavailable. Please contact the business.');
    const input = contactSchema.extend({ serviceId: z.string(), startsAt: z.iso.datetime(), answers: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}), notes: z.string().max(3000).default('') }).parse(req.body);
    const service = store.get('SELECT * FROM services WHERE id=? AND tenant_id=?', input.serviceId, t.id);
    fail(service, 404, 'Service not found.'); const doc = parse(service.doc);fail(t.professions.includes(doc.category),409,'This service is no longer offered.'); fail(doc.active, 409, 'This service is currently unavailable.');
    if (professionFor(doc.category,catalogue(store)).modules.includes('tours')) feature(t, 'tours');
    const start = new Date(input.startsAt), end = new Date(start.getTime() + doc.duration * 3600000);
    fail(start > new Date(), 400, 'Choose a future date and time.');
    const id = uid('bk_'), token = secret();
    store.tx(() => {
      fail(!store.get("SELECT id FROM bookings WHERE tenant_id=? AND status IN ('awaiting_payment','awaiting_review','confirmed') AND starts_at<? AND ends_at>?", t.id, end.toISOString(), start.toISOString()), 409, 'This time is already reserved. Please choose another time.');
      fail(!(t.blocks || []).some(b => b.start < end.toISOString() && b.end > start.toISOString()), 409, 'This time is unavailable. Choose another date.');
      const clash=store.all('SELECT doc FROM events WHERE tenant_id=?',t.id).some(row=>{const departure=parse(row.doc);return departure.kind==='tour'&&departure.published&&!departure.cancelled&&departure.startsAt<end.toISOString()&&departure.endsAt>start.toISOString();});fail(!clash,409,'This time is reserved for a scheduled tour departure.');
      const answers = validateQuestions(doc.questions || [], input.answers);
      store.run('INSERT INTO bookings VALUES(?,?,?,?,?,?,?,?)', id, t.id, hash(token), 'requested', start.toISOString(), end.toISOString(), json({ name: input.name, email: input.email, phone: input.phone, serviceId: service.id, serviceTitle: doc.title, notes: input.notes, answers, amount: null, currency: doc.currency || 'NGN' }), now());
      store.audit(t.id, null, 'booking.requested', { bookingId: id });
      notice(t.id, 'private', 'New booking request', `A customer requested ${doc.title}.`, `/dashboard/${t.slug}/bookings`, 'bookings');
    });
    res.status(201).json({ id, access: token, status: 'requested' });
  });
  app.get('/api/guest/bookings/:id', (req, res) => {
    sweep(store); const row = guestRow(req, 'bookings', req.params.id), t = readTenant(store, row.tenant_id);
    const { token, doc, ...fields } = row;
    res.json({ booking: { ...parse(doc), ...fields }, business: sanitizeTenant(store, t), paymentAccounts: ['awaiting_payment', 'awaiting_review', 'confirmed'].includes(row.status) ? t.paymentAccounts || [] : [], proofs: store.all("SELECT id,status,note,created_at FROM proofs WHERE reference_id=? AND kind='booking' ORDER BY created_at DESC", row.id) });
  });
  app.post('/api/public/:slug/orders', (req, res) => {
    limited(req, 'order', 20); const t = tenant(req, req.params.slug, true); 
    fail(statusOf(store, t) === 'active', 423, 'New ticket orders are temporarily unavailable.'); sweep(store);
    const input = contactSchema.extend({ eventId: z.string(), tierId: z.string(), quantity: z.number().int().min(1).max(10) }).parse(req.body);
    const eventRow = store.get('SELECT * FROM events WHERE id=? AND tenant_id=?', input.eventId, t.id); fail(eventRow, 404, 'Event not found.');
    const event = parse(eventRow.doc);requireEventFeature(store,t,event,feature);const tier = event.tiers?.find(v => v.id === input.tierId);
    fail(event.published && !event.cancelled && tier, 409, 'These tickets are not available.');
    fail(event.startsAt > now(), 409, 'Ticket sales have closed for this event.');
    if (event.salesEnd) fail(event.salesEnd > now(), 409, 'Ticket sales have closed.');
    if (tier.price > 0) fail((t.paymentAccounts || []).some(a => a.currency === event.currency && a.holder && a.number), 409, 'The organiser must configure a payment account for this currency before selling tickets.');
    const id = uid('ord_'), token = secret();
    store.tx(() => {
      const held = store.get("SELECT COALESCE(SUM(quantity),0) AS n FROM orders WHERE event_id=? AND (status IN ('confirmed','awaiting_review') OR (status='awaiting_payment' AND expires_at>?))", eventRow.id, now()).n;
      fail(held + input.quantity <= event.capacity, 409, 'There are not enough tickets remaining.');
      const doc = { name: input.name, email: input.email, phone: input.phone, amount: tier.price * input.quantity, currency: event.currency, tierId: tier.id, tierName: tier.name, eventTitle: event.title };
      const status = doc.amount === 0 ? 'confirmed' : 'awaiting_payment';
      const row = { id, tenant_id: t.id, event_id: eventRow.id, quantity: input.quantity };
      store.run('INSERT INTO orders VALUES(?,?,?,?,?,?,?,?,?)', id, t.id, eventRow.id, hash(token), status, input.quantity, new Date(Date.now() + 30 * 60000).toISOString(), json(doc), now());
      if (status === 'confirmed') issueTickets(store, row);
      store.audit(t.id, null, 'tickets.ordered', { orderId: id, quantity: input.quantity });
      notice(t.id, 'private', status === 'confirmed' ? 'New ticket registration' : 'New ticket order', `${input.quantity} ticket(s) for ${event.title}.`, `/dashboard/${t.slug}/events`, 'events', eventRow.id);
    });
    res.status(201).json({ id, access: token });
  });
  app.get('/api/guest/orders/:id', (req, res) => {
    sweep(store); const row = guestRow(req, 'orders', req.params.id), t = readTenant(store, row.tenant_id), event = store.get('SELECT * FROM events WHERE id=?', row.event_id);
    const { token, doc, ...fields } = row;
    res.json({ order: { ...parse(doc), ...fields }, event: event ? publicEvent(event) : null, business: sanitizeTenant(store, t), paymentAccounts: t.paymentAccounts || [], tickets: row.status === 'confirmed' ? store.all('SELECT id,code,checked_at FROM tickets WHERE order_id=?', row.id) : [], proofs: store.all("SELECT id,status,note,created_at FROM proofs WHERE reference_id=? AND kind='order' ORDER BY created_at DESC", row.id) });
  });
  app.get('/api/guest/orders/:id/qr/:code', async (req, res) => {
    if (!req.get('Authorization') && req.query.access) req.headers.authorization = `Bearer ${req.query.access}`;
    const order = guestRow(req, 'orders', req.params.id);
    const ticket = store.get('SELECT id FROM tickets WHERE order_id=? AND code=?', order.id, req.params.code); fail(ticket && order.status === 'confirmed', 404, 'Ticket not found.');
    res.type('png').send(await QRCode.toBuffer(`PROMOTE:${req.params.code}`, { width: 360, margin: 2, errorCorrectionLevel: 'M' }));
  });
  app.post('/api/guest/:kind/:id/proof', upload.single('proof'), async (req, res) => {
    limited(req, 'proof', 30); fail(['bookings', 'orders'].includes(req.params.kind), 404, 'Not found.');
    sweep(store); const row = guestRow(req, req.params.kind, req.params.id), doc = parse(row.doc), t = readTenant(store, row.tenant_id);
    fail(['awaiting_payment'].includes(row.status), 409, row.status === 'awaiting_review' ? 'Your proof is already awaiting review.' : 'Payment is not currently due for this request.');
    fail(await validateImage(req.file), 400, 'Upload a valid JPG, PNG or WebP payment screenshot, up to 8 MB.');
    const reference = z.string().trim().min(2).max(120).parse(req.body.reference);
    fail(Number(req.body.amount) === doc.amount && req.body.currency === doc.currency, 400, 'The payment amount and currency must match the amount due.');
    fail((t.paymentAccounts || []).some(a => a.currency === doc.currency), 409, 'Contact the business to configure payment details.');
    const id = uid('proof_'), filename = `${id}.image`, kind = req.params.kind === 'bookings' ? 'booking' : 'order';
    putFile(store,filename,req.file.buffer,{tenantId:t.id,mime:req.file.mimetype,private:true});
    try { store.tx(() => {
      const fresh = store.get(`SELECT status FROM ${req.params.kind} WHERE id=?`, row.id); fail(fresh.status === 'awaiting_payment', 409, 'This payment has already been submitted.');
      store.run('INSERT INTO proofs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', id, row.tenant_id, kind, row.id, filename, req.file.mimetype, doc.amount, doc.currency, reference, 'pending', null, '', now());
      store.run(`UPDATE ${req.params.kind} SET status='awaiting_review' WHERE id=?`, row.id);
      notice(row.tenant_id, 'private', 'Payment proof received', 'A customer payment is ready for verification.', `/dashboard/${t.slug}/payments`, 'payments', row.event_id || null);
      store.audit(row.tenant_id, null, 'payment.proof_submitted', { proofId: id, kind });
    }); } catch (e) { removeFile(store,filename); throw e; }
    res.status(201).json({ id, status: 'awaiting_review' });
  });
  app.post('/api/public/:slug/metrics', (req, res) => {
    limited(req, 'metrics', 150); const t = tenant(req, req.params.slug, true);
    const input = z.object({ device: z.string().regex(/^[a-zA-Z0-9_-]{16,100}$/), kind: z.enum(['visit', 'install', 'app_open', 'notification_click']) }).parse(req.body);
    const window = input.kind === 'install' ? '1970-01-01' : new Date(Date.now() - 30 * 60000).toISOString();
    if (!store.get('SELECT id FROM metrics WHERE tenant_id=? AND device=? AND kind=? AND created_at>?', t.id, input.device, input.kind, window)) store.run('INSERT INTO metrics(tenant_id,device,kind,created_at) VALUES(?,?,?,?)', t.id, input.device, input.kind, now());
    res.json({ ok: true });
  });
  app.get('/api/public/:slug/push-key', (req, res) => { const t = tenant(req, req.params.slug); feature(t, 'notifications'); res.json({ publicKey: store.setting('vapid').publicKey }); });
  app.post('/api/public/:slug/subscribe', (req, res) => {
    limited(req, 'subscribe', 30); const t = tenant(req, req.params.slug); feature(t, 'notifications');
    fail(t.published || memberOf(store, req.user, t.id), 404, 'Business not found.');
    const input = z.object({ subscription: z.object({ endpoint: z.url().max(2000), expirationTime: z.number().nullable().optional(), keys: z.object({ p256dh: z.string().regex(/^[\w-]{80,100}$/), auth: z.string().regex(/^[\w-]{20,30}$/) }) }), private: z.boolean().default(false) }).parse(req.body);
    const url = new URL(input.subscription.endpoint);
    fail(url.protocol === 'https:' && !url.port && !url.username && !url.password && ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'web.push.apple.com', 'notify.windows.com'].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain)), 400, 'Unsupported push service endpoint.');
    let userId = input.private ? req.user?.id : null;
    if (input.private) fail(userId && memberOf(store, req.user, t.id), 403, 'Business membership is required for private alerts.');
    const previous=store.get('SELECT * FROM subscriptions WHERE tenant_id=? AND endpoint=?',t.id,input.subscription.endpoint);
    const publicEnabled=input.private?(previous?parse(previous.payload).publicEnabled??!previous.user_id:false):true;
    if(!input.private&&previous?.user_id===req.user?.id&&memberOf(store,req.user,t.id))userId=previous.user_id;
    store.run('INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id,endpoint) DO UPDATE SET user_id=excluded.user_id,payload=excluded.payload,last_seen=excluded.last_seen', uid('sub_'), t.id, userId || null, input.subscription.endpoint, json({...input.subscription,publicEnabled}), now(), now());
    res.status(201).json({ ok: true });
  });
  app.post('/api/public/:slug/subscription-status',(req,res)=>{
    const t=tenant(req,req.params.slug),input=z.object({endpoint:z.url().max(2000),private:z.boolean().default(false)}).parse(req.body),row=store.get('SELECT * FROM subscriptions WHERE tenant_id=? AND endpoint=?',t.id,input.endpoint);
    const subscribed=!!t.features.notifications&&!!row&&(input.private?!!req.user&&row.user_id===req.user.id&&!!memberOf(store,req.user,t.id):(parse(row.payload).publicEnabled??!row.user_id));res.json({subscribed});
  });
  app.delete('/api/public/:slug/subscribe', (req, res) => {
    const t=tenant(req,req.params.slug),endpoint=z.url().max(2000).parse(req.body.endpoint),row=store.get('SELECT * FROM subscriptions WHERE tenant_id=? AND endpoint=?',t.id,endpoint);
    if(row){const payload=parse(row.payload),privateScope=req.body.private??(!!req.user&&row.user_id===req.user.id);if(privateScope){fail(req.user&&row.user_id===req.user.id,403,'Sign in to disable your private work alerts.');if(payload.publicEnabled??!row.user_id)store.run('UPDATE subscriptions SET user_id=NULL WHERE id=?',row.id);else store.run('DELETE FROM subscriptions WHERE id=?',row.id);}else if(req.user&&row.user_id===req.user.id&&memberOf(store,req.user,t.id)){payload.publicEnabled=false;store.run('UPDATE subscriptions SET payload=? WHERE id=?',json(payload),row.id);}else store.run('DELETE FROM subscriptions WHERE id=?',row.id);}
    res.json({ok:true,removeDeviceSubscription:!store.get('SELECT id FROM subscriptions WHERE endpoint=?',endpoint)});
  });
  app.get('/api/invitations/:token', (req, res) => {
    limited(req, 'invitation_view', 60); const row = store.get('SELECT * FROM invitations WHERE token=? AND used_at IS NULL AND expires_at>?', hash(req.params.token), now()); fail(row, 404, 'This invitation has expired or been revoked.');
    const t = tenant(req, row.tenant_id); res.json({ business: { name: t.name, slug: t.slug, accent: t.accent }, email: row.email, permissions: parse(row.permissions, []), requiresLogin: !!store.get('SELECT id FROM users WHERE email=?', row.email) });
  });
  app.post('/api/invitations/:token/accept', async (req, res) => {
    limited(req, 'invitation_accept', 10); const row = store.get('SELECT * FROM invitations WHERE token=? AND used_at IS NULL AND expires_at>?', hash(req.params.token), now()); fail(row, 404, 'This invitation has expired or been revoked.');
    const t = tenant(req, row.tenant_id); feature(t, 'staff'); fail(statusOf(store, t) === 'active', 423, 'This business account is on hold.');
    let user = store.get('SELECT id,email,name,role FROM users WHERE email=?', row.email);
    if (user) fail(req.user?.id === user.id, 401, 'Sign in with the email address on this invitation.');
    else { const input = z.object({ name: z.string().trim().min(2).max(100), password: z.string().min(10).max(128) }).parse(req.body); user = await createUser(store, { ...input, email: row.email }); }
    store.tx(() => {
      const current = store.get('SELECT used_at FROM invitations WHERE id=?', row.id); fail(!current.used_at, 409, 'This invitation has already been used.');
      store.run('INSERT INTO memberships VALUES(?,?,?,?,?,?) ON CONFLICT(tenant_id,user_id) DO UPDATE SET permissions=excluded.permissions,event_ids=excluded.event_ids,role=excluded.role', uid('mem_'), row.tenant_id, user.id, row.role || 'staff', row.permissions, row.event_ids);
      store.run('UPDATE invitations SET used_at=? WHERE id=?', now(), row.id); store.audit(row.tenant_id, user.id, 'staff.joined');
    });
    logIn(req, res, user); res.json({ business: { slug: t.slug, name: t.name } });
  });
}
