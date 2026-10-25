import {putFile,removeFile,fileInfo,sendFile} from './storage.mjs';
import { z } from 'zod';
import { writeFileSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fail, uid, secret, hash, now, json, parse, permissions, professions, featureNames, readTenant, saveTenant, statusOf, sanitizeTenant, documents, metricsFor, allowedEvents, can, issueTickets, invoiceResult } from './core.mjs';
import { currencySchema } from './routes-public.mjs';
import { validateImage, normalizeImage } from './png.mjs';
import {addServiceTemplates} from './professional-data.mjs';
import {tourSchema,requireEventFeature,checkTourAvailability} from './professional-events.mjs';

export const accountsSchema = z.array(z.object({ id: z.string().max(80), label: z.string().trim().min(2).max(80), type: z.enum(['bank', 'momo']), currency: currencySchema, provider: z.string().trim().min(2).max(100), holder: z.string().trim().min(2).max(120), number: z.string().trim().min(5).max(80), instructions: z.string().max(500).default('') })).max(10);
const questionSchema = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), label: z.string().trim().min(2).max(160), type: z.enum(['text', 'textarea', 'number', 'select']), required: z.boolean(), options: z.array(z.string().min(1).max(100)).max(20).optional() }).refine(v => v.type !== 'select' || v.options?.length, 'Select questions need options.');
const serviceSchema = z.object({ title: z.string().trim().min(2).max(120), description: z.string().max(1800), category: z.string().regex(/^[a-z][a-z0-9-]{1,35}$/), duration: z.number().min(0.5).max(168), active: z.boolean(), priceMode: z.enum(['quote', 'fixed']), price: z.number().int().min(0).max(1000000000), currency: currencySchema, questions: z.array(questionSchema).max(20), icon: z.string().max(30).optional(), deliverables:z.array(z.string().max(180)).max(20).default([]) }).refine(v => new Set(v.questions.map(q => q.key)).size === v.questions.length, 'Question keys must be unique.');
const imagePath = z.string().max(250).refine(v => v === '' || /^\/media\/[a-zA-Z0-9/_.-]+$/.test(v), 'Choose an uploaded image.');
const socialSchema = z.record(z.string().max(30), z.string().max(300).refine(v => v === '' || /^https:\/\//.test(v), 'Use a full https:// social link.'));
const eventSchema = z.object({ kind:z.enum(['event','tour']).default('event'),tour:tourSchema.optional(),lineup:z.array(z.object({name:z.string().trim().min(2).max(100),role:z.string().max(100).default('')})).max(30).default([]),title: z.string().trim().min(3).max(140), description: z.string().max(4000), venue: z.string().trim().min(2).max(160), address: z.string().max(300), startsAt: z.iso.datetime(), endsAt: z.iso.datetime(), salesEnd: z.iso.datetime().optional().or(z.literal('')), capacity: z.number().int().min(1).max(1000000), currency: currencySchema, image: imagePath, published: z.boolean(), cancelled: z.boolean().default(false), tiers: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/), name: z.string().trim().min(2).max(80), price: z.number().int().min(0).max(1000000000) })).min(1).max(10) }).refine(v=>v.kind!=='tour'||!!v.tour,'Add the tour itinerary and meeting point.').refine(v => v.endsAt > v.startsAt, 'Event end must be after its start.').refine(v => new Set(v.tiers.map(t => t.id)).size === v.tiers.length, 'Ticket types must have unique identifiers.');

export function businessRoutes(app, ctx) {
  const { store, access, auth, admin, feature, upload, notice, tenant, limited } = ctx;
  app.get('/api/business/:slug/dashboard', auth, (req, res) => {
    const { t, m } = access(req, req.params.slug);
    const business = { ...t, status: statusOf(store, t) };
    if (!can(m, 'payments') && !['owner', 'admin'].includes(m.role)) delete business.paymentAccounts;
    const events = can(m, 'events') || can(m, 'scan') ? allowedEvents(m, documents(store, 'events', t.id)) : [];
    const proofs = can(m, 'payments') ? store.all("SELECT p.* FROM proofs p WHERE p.tenant_id=? AND p.kind!='invoice' ORDER BY created_at DESC", t.id).filter(p => {
      if (p.kind !== 'order' || !m.eventIds.length || ['owner', 'admin'].includes(m.role)) return true;
      return can(m, 'payments', store.get('SELECT event_id FROM orders WHERE id=?', p.reference_id)?.event_id);
    }).map(p => ({ ...p, customer: p.kind === 'booking' ? parse(store.get('SELECT doc FROM bookings WHERE id=?', p.reference_id)?.doc).name : parse(store.get('SELECT doc FROM orders WHERE id=?', p.reference_id)?.doc).name })) : [];
    const owner = ['owner', 'admin'].includes(m.role);
    res.json({ business, membership: m,
      stats: can(m, 'analytics') ? metricsFor(store, t.id) : null,
      services: can(m, 'content') || can(m, 'bookings') ? documents(store, 'services', t.id) : [],
      campaigns: can(m,'content') && t.features.sponsors ? documents(store,'sponsor_campaigns',t.id) : [],
      sponsorStats: can(m,'analytics') || can(m,'content') ? store.all("SELECT campaign_id,kind,COUNT(*) AS count FROM sponsor_activity WHERE tenant_id=? GROUP BY campaign_id,kind",t.id) : [],
      events,
      bookings: can(m, 'bookings') ? documents(store, 'bookings', t.id) : [], proofs,
      orders: can(m, 'events') ? documents(store, 'orders', t.id).filter(o => can(m, 'events', o.event_id)) : [],
      staff: can(m, 'staff') ? store.all('SELECT m.id,m.role,m.permissions,m.event_ids,u.name,u.email FROM memberships m JOIN users u ON m.user_id=u.id WHERE m.tenant_id=?', t.id).map(m => ({ ...m, permissions: parse(m.permissions, []), eventIds: parse(m.event_ids, []) })) : [],
      invitations: can(m, 'staff') ? store.all('SELECT id,email,permissions,event_ids,expires_at,used_at FROM invitations WHERE tenant_id=? AND used_at IS NULL AND expires_at>?', t.id, now()).map(i => ({ ...i, permissions: parse(i.permissions, []), eventIds: parse(i.event_ids, []) })) : [],
      invoices: owner ? store.all('SELECT * FROM invoices WHERE tenant_id=? ORDER BY created_at DESC', t.id).map(i => invoiceResult(store, i)) : [],
      billingEnabled: store.setting('billingEnabled', false), platformAccounts: owner ? store.setting('platformAccounts', []) : [],
      notices: store.all('SELECT * FROM notices WHERE tenant_id=? ORDER BY created_at DESC LIMIT 30', t.id).filter(n => n.audience === 'public' || !n.permission || can(m, n.permission, n.event_id)),
      domains: owner ? store.all('SELECT id,hostname,verified,token FROM domains WHERE tenant_id=?', t.id) : [],
      activity: owner ? store.all('SELECT a.*,u.name FROM activity a LEFT JOIN users u ON a.user_id=u.id WHERE a.tenant_id=? ORDER BY a.created_at DESC LIMIT 30', t.id).map(a => ({ ...a, detail: parse(a.detail) })) : [],
    });
  });
  app.patch('/api/business/:slug/profile', auth, (req, res) => {
    const { t, m } = access(req, req.params.slug, 'content');
    const input = z.object({ name: z.string().trim().min(2).max(80), tagline: z.string().max(120), headline: z.string().max(180), bio: z.string().max(3000), location: z.string().max(160), areas: z.array(z.string().max(80)).max(20), professions: z.array(z.enum(store.setting('professions', professions).map(p => p.id))).min(1).max(20), email: z.email().or(z.literal('')), phone: z.string().max(40), accent: z.string().regex(/^#[a-fA-F0-9]{6}$/), themeMode: z.enum(['dark','light']).default('dark'), avatar: imagePath, cover: imagePath, appIcon: imagePath.optional(), social: socialSchema, gallery: z.array(z.object({ url: imagePath, caption: z.string().max(180) })).max(30), timezone: z.string().max(80), published: z.boolean() }).parse(req.body);
    try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }); } catch { fail(false, 400, 'Choose a valid time zone.'); }
    if (input.published) fail(input.bio.length >= 20 && input.location && input.email, 400, 'Add a biography, location and contact email before publishing.');
    const addedProfessions=input.professions.filter(id=>!t.professions.includes(id));Object.assign(t, input);addServiceTemplates(store,t,addedProfessions); t.brandVersion=uid('brand_'); saveTenant(store, t); store.audit(t.id, req.user.id, 'profile.updated', { published: t.published });
    res.json({ business: t });
  });
  app.post('/api/business/:slug/assets', auth, upload.single('image'), async (req, res) => {
    const { t } = access(req, req.params.slug, 'content'); limited(req, 'assets', 50);
    fail(await validateImage(req.file), 400, 'Upload a valid JPG, PNG or WebP image up to 8 MB.');
    const id = uid('asset_'), filename = `${id}.webp`, buffer=await normalizeImage(req.file.buffer);
    putFile(store,filename,buffer,{tenantId:t.id,mime:'image/webp'});
    try { store.run('INSERT INTO assets VALUES(?,?,?,?,?)', id, t.id, filename, 'image/webp', now()); } catch(error){removeFile(store,filename);throw error;}
    res.status(201).json({ id, url: `/media/uploads/${filename}`, mime:'image/webp', type:'image' });
  });
  app.get('/api/business/:slug/assets', auth, (req,res)=>{
    const {t}=access(req,req.params.slug,'content',null,true);
    const assets=store.all('SELECT id,path,mime,created_at FROM assets WHERE tenant_id=? ORDER BY created_at DESC LIMIT 200',t.id).filter(a=>fileInfo(store,a.path)).map(a=>({id:a.id,url:`/media/uploads/${a.path}`,mime:a.mime,type:a.mime.startsWith('video/')?'video':a.mime.startsWith('audio/')?'audio':'image',size:fileInfo(store,a.path).size,createdAt:a.created_at}));
    res.json({assets});
  });
  app.get('/media/uploads/:filename', (req, res) => {
    const row = store.get('SELECT * FROM assets WHERE path=?', req.params.filename); fail(row, 404, 'Media not found.'); res.type(row.mime).set('Cache-Control','public,max-age=31536000,immutable');sendFile(store,res,row.path,{public:true});
  });
  app.put('/api/business/:slug/payment-accounts', auth, (req, res) => {
    const { t, m } = access(req, req.params.slug, 'payments'); fail(['owner', 'admin'].includes(m.role), 403, 'Only the owner can change receiving accounts.');
    t.paymentAccounts = accountsSchema.parse(req.body.accounts); saveTenant(store, t); store.audit(t.id, req.user.id, 'payment_accounts.updated'); res.json({ ok: true });
  });
  app.post('/api/business/:slug/services', auth, (req, res) => {
    const { t } = access(req, req.params.slug, 'content'); feature(t, 'bookings'); const input = serviceSchema.parse(req.body); fail(t.professions.includes(input.category), 400, 'Choose a profession selected on this business profile.');
    const id = uid('svc_'); store.run('INSERT INTO services VALUES(?,?,?,?)', id, t.id, json(input), now()); store.audit(t.id, req.user.id, 'service.created', { serviceId: id }); res.status(201).json({ id });
  });
  app.put('/api/business/:slug/services/:id', auth, (req, res) => {
    const { t } = access(req, req.params.slug, 'content'); feature(t, 'bookings'); const input = serviceSchema.parse(req.body); fail(t.professions.includes(input.category), 400, 'Choose a profession selected on this business profile.');
    fail(store.get('SELECT id FROM services WHERE id=? AND tenant_id=?', req.params.id, t.id), 404, 'Service not found.');
    store.run('UPDATE services SET doc=? WHERE id=? AND tenant_id=?', json(input), req.params.id, t.id); res.json({ ok: true });
  });
  app.post('/api/business/:slug/bookings/:id/decision', auth, (req, res) => {
    const { t } = access(req, req.params.slug, 'bookings'); feature(t, 'bookings');
    const input = z.object({ action: z.enum(['accept', 'decline', 'cancel']), amount: z.number().int().min(0).max(1000000000).optional(), currency: currencySchema.optional(), payBy: z.iso.datetime().optional(), note: z.string().max(1500).default('') }).parse(req.body);
    store.tx(() => {
      const row = store.get('SELECT * FROM bookings WHERE id=? AND tenant_id=?', req.params.id, t.id); fail(row, 404, 'Booking not found.'); const doc = parse(row.doc);
      fail(!['declined', 'cancelled', 'expired'].includes(row.status), 409, 'This request is already closed.');
      if (input.action === 'accept') {
        fail(row.status === 'requested', 409, 'Only a new request can be accepted.');
        fail(input.amount !== undefined && input.currency, 400, 'Enter the agreed price and currency.');
        if (input.amount > 0) { fail(input.payBy && input.payBy > now() && input.payBy < row.starts_at, 400, 'Set a payment deadline before the booking starts.'); fail((t.paymentAccounts || []).some(a => a.currency === input.currency), 400, 'Add a receiving account for this currency in Payment accounts first.'); }
        fail(!store.get("SELECT id FROM bookings WHERE tenant_id=? AND id!=? AND status IN ('awaiting_payment','awaiting_review','confirmed') AND starts_at<? AND ends_at>?", t.id, row.id, row.ends_at, row.starts_at), 409, 'Another accepted booking overlaps this time.');
        fail(!(t.blocks || []).some(b => b.start < row.ends_at && b.end > row.starts_at), 409, 'This time is blocked in your calendar.');
        const departure=store.all('SELECT doc FROM events WHERE tenant_id=?',t.id).map(event=>parse(event.doc)).some(event=>event.kind==='tour'&&event.published&&!event.cancelled&&event.startsAt<row.ends_at&&event.endsAt>row.starts_at);fail(!departure,409,'This time is reserved for a scheduled tour departure.');
        Object.assign(doc, { amount: input.amount, currency: input.currency, payBy: input.payBy || null, response: input.note });
        store.run('UPDATE bookings SET status=?,doc=? WHERE id=?', input.amount > 0 ? 'awaiting_payment' : 'confirmed', json(doc), row.id);
      } else {
        fail(row.status !== 'awaiting_review', 409, 'Review the submitted payment before closing this booking.');
        doc.response = input.note;
        store.run('UPDATE bookings SET status=?,doc=? WHERE id=?', input.action === 'decline' ? 'declined' : 'cancelled', json(doc), row.id);
      }
      store.audit(t.id, req.user.id, `booking.${input.action}`, { bookingId: row.id });
      notice(t.id, 'private', 'Booking updated', 'A booking status changed.', `/dashboard/${t.slug}/bookings`, 'bookings');
    });
    res.json({ ok: true });
  });
  app.put('/api/business/:slug/calendar', auth, (req, res) => {
    const { t } = access(req, req.params.slug, 'bookings');
    const blocks = z.array(z.object({ id: z.string().max(60), start: z.iso.datetime(), end: z.iso.datetime(), label: z.string().max(100) }).refine(b => b.end > b.start, 'Block end must be after its start.')).max(100).parse(req.body.blocks);
    t.blocks = blocks; saveTenant(store, t); res.json({ ok: true });
  });
  app.post('/api/business/:slug/events', auth, (req, res) => {
    const { t, m } = access(req, req.params.slug, 'events'); fail(!m.eventIds.length || ['owner', 'admin'].includes(m.role), 403, 'Event-restricted staff cannot create new events.');
    const input = eventSchema.parse(req.body);requireEventFeature(store,t,input,feature);checkTourAvailability(store,t,input); fail(input.startsAt > now(), 400, 'Choose a future event date.');
    if (input.published && input.tiers.some(tier => tier.price > 0)) fail((t.paymentAccounts || []).some(a => a.currency === input.currency), 400, 'Add a receiving account for this currency before publishing paid tickets.');
    const id = uid('evt_'); store.run('INSERT INTO events VALUES(?,?,?,?)', id, t.id, json(input), now()); store.audit(t.id, req.user.id, 'event.created', { eventId: id });
    if (input.published) notice(t.id, 'public', 'A new event just dropped', input.title, `/p/${t.slug}/events/${id}`, null, id);
    res.status(201).json({ id });
  });
  app.put('/api/business/:slug/events/:id', auth, (req, res) => {
    const { t } = access(req, req.params.slug, 'events', req.params.id);
    const input = eventSchema.parse(req.body), row = store.get('SELECT * FROM events WHERE id=? AND tenant_id=?', req.params.id, t.id); fail(row, 404, 'Event not found.'); const old = parse(row.doc);requireEventFeature(store,t,input,feature);checkTourAvailability(store,t,input,row.id);
    const used = store.get("SELECT COALESCE(SUM(quantity),0) AS n FROM orders WHERE event_id=? AND status IN ('confirmed','awaiting_review','awaiting_payment')", row.id).n;
    fail(input.capacity >= used, 409, 'Capacity cannot be below the number of reserved tickets.');
    if(used)fail(input.kind===(old.kind||'event'),409,'An event cannot change type after ticket orders exist.');
    if (used) fail(input.currency === old.currency, 409, 'Currency cannot change after ticket orders exist.');
    if (input.published && input.tiers.some(tier => tier.price > 0)) fail((t.paymentAccounts || []).some(a => a.currency === input.currency), 400, 'Add a receiving account for this currency before publishing.');
    store.run('UPDATE events SET doc=? WHERE id=?', json({ ...input, reminderSent: old.reminderSent && old.startsAt === input.startsAt }), row.id);
    store.audit(t.id, req.user.id, 'event.updated', { eventId: row.id });
    if (input.published && (!old.published || input.cancelled !== old.cancelled || input.startsAt !== old.startsAt || input.venue !== old.venue)) notice(t.id, 'public', input.cancelled ? 'Event cancelled' : old.published ? 'Event update' : 'New event', input.cancelled ? `${input.title} has been cancelled. Contact the organiser about existing orders.` : `${input.title} · ${input.venue}`, `/p/${t.slug}/events/${row.id}`, null, row.id);
    res.json({ ok: true });
  });
  app.get('/api/business/:slug/events/:id/attendees', auth, (req, res) => {
    const { t } = access(req, req.params.slug, 'scan', req.params.id, true);
    const attendees = store.all('SELECT tk.id,tk.checked_at,tk.order_id,o.doc FROM tickets tk JOIN orders o ON tk.order_id=o.id WHERE tk.tenant_id=? AND tk.event_id=? AND o.status=? ORDER BY tk.created_at', t.id, req.params.id, 'confirmed').map(row => ({ id: row.id, checkedAt: row.checked_at, name: parse(row.doc).name, tier: parse(row.doc).tierName }));
    res.json({ attendees });
  });
  app.post('/api/business/:slug/scan', auth, (req, res) => {
    const code = z.string().min(10).max(200).parse(req.body.code).replace(/^PROMOTE:/, '').trim();
    const t = tenant(req, req.params.slug), row = store.get('SELECT * FROM tickets WHERE code=? AND tenant_id=?', code, t.id); fail(row, 404, 'Ticket not found for this business.');
    access(req, req.params.slug, 'scan', row.event_id, true);
    const event = store.get('SELECT doc FROM events WHERE id=?', row.event_id); fail(event && !parse(event.doc).cancelled, 409, 'This event has been cancelled.');
    const order = store.get('SELECT * FROM orders WHERE id=?', row.order_id); fail(order.status === 'confirmed', 409, 'This ticket is not valid.');
    const doc = parse(order.doc);
    if (row.checked_at) return res.status(409).json({ error: 'This ticket has already been used.', checkedAt: row.checked_at, name: doc.name });
    const result = store.run('UPDATE tickets SET checked_at=?,checked_by=? WHERE id=? AND checked_at IS NULL', now(), req.user.id, row.id); fail(result.changes === 1, 409, 'This ticket has just been checked in by another staff member.');
    store.audit(t.id, req.user.id, 'ticket.checked_in', { ticketId: row.id, eventId: row.event_id });
    res.json({ ok: true, name: doc.name, tier: doc.tierName, event: parse(event.doc).title, ticketId: row.id });
  });
  app.get('/api/proofs/:id/image', auth, (req, res) => {
    const row = store.get('SELECT * FROM proofs WHERE id=?', req.params.id); fail(row, 404, 'Proof not found.');
    if (row.kind === 'invoice') fail(req.user.role === 'admin' || ['owner', 'admin'].includes(access(req, row.tenant_id, null, null, true).m.role), 403, 'Owner access required.');
    else { const eventId = row.kind === 'order' ? store.get('SELECT event_id FROM orders WHERE id=?', row.reference_id)?.event_id : null; access(req, row.tenant_id, 'payments', eventId, true); }
    res.type(row.mime).set('Cache-Control','private,no-store');sendFile(store,res,row.path);
  });
  app.post('/api/business/:slug/proofs/:id/review', auth, (req, res) => {
    const t = tenant(req, req.params.slug), proof = store.get("SELECT * FROM proofs WHERE id=? AND tenant_id=? AND kind!='invoice'", req.params.id, t.id); fail(proof, 404, 'Payment proof not found.');
    const eventId = proof.kind === 'order' ? store.get('SELECT event_id FROM orders WHERE id=?', proof.reference_id)?.event_id : null;
    access(req, t.id, 'payments', eventId);
    const input = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(1000).default('') }).parse(req.body);
    if (input.decision === 'reject') fail(input.note.trim().length >= 3, 400, 'Tell the customer why the payment proof was rejected.');
    store.tx(() => {
      const current = store.get('SELECT status FROM proofs WHERE id=?', proof.id); fail(current.status === 'pending', 409, 'This payment has already been reviewed.');
      const table = proof.kind === 'booking' ? 'bookings' : 'orders', row = store.get(`SELECT * FROM ${table} WHERE id=?`, proof.reference_id), doc = parse(row.doc);
      fail(row.status === 'awaiting_review', 409, 'This request is not awaiting payment review.');
      const status = input.decision === 'approve' ? 'confirmed' : 'awaiting_payment';
      if (input.decision === 'approve' && table === 'orders') { fail(!parse(store.get('SELECT doc FROM events WHERE id=?', row.event_id).doc).cancelled, 409, 'This event was cancelled. Resolve the payment with the customer.'); issueTickets(store, row); }
      if (table === 'bookings') { if (input.decision === 'reject') doc.payBy = new Date(Math.min(Date.now() + 48 * 3600000, new Date(row.starts_at).getTime() - 60000)).toISOString(); store.run('UPDATE bookings SET status=?,doc=? WHERE id=?', status, json(doc), row.id); }
      else store.run('UPDATE orders SET status=?,expires_at=? WHERE id=?', status, new Date(Date.now() + 30 * 60000).toISOString(), row.id);
      store.run('UPDATE proofs SET status=?,reviewed_by=?,note=? WHERE id=?', input.decision === 'approve' ? 'approved' : 'rejected', req.user.id, input.note, proof.id);
      store.audit(t.id, req.user.id, `payment.${input.decision}`, { proofId: proof.id }); notice(t.id, 'private', 'Payment reviewed', input.decision === 'approve' ? 'Payment verified and the request confirmed.' : 'Payment proof rejected for resubmission.', `/dashboard/${t.slug}/payments`, 'payments', eventId);
    });
    res.json({ ok: true });
  });
  app.post('/api/business/:slug/staff/invite', auth, (req, res) => {
    const { t, m } = access(req, req.params.slug, 'staff'); feature(t, 'staff');
    const input = z.object({ email: z.email().max(180), permissions: z.array(z.enum(permissions)).min(1).max(permissions.length), eventIds: z.array(z.string()).max(100).default([]) }).parse(req.body);
    if (m.role === 'staff') { fail(input.permissions.every(p => m.permissions.includes(p)), 403, 'You can only grant permissions you already have.'); if (m.eventIds.length) fail(input.eventIds.length && input.eventIds.every(id => m.eventIds.includes(id)), 403, 'Choose only events you can manage.'); }
    for (const eventId of input.eventIds) fail(store.get('SELECT id FROM events WHERE id=? AND tenant_id=?', eventId, t.id), 400, 'One of these events does not belong to this business.');
    fail(!store.get('SELECT m.id FROM memberships m JOIN users u ON m.user_id=u.id WHERE m.tenant_id=? AND u.email=?', t.id, input.email.toLowerCase()), 409, 'This person is already a member. Edit their permissions instead.');
    const id = uid('invite_'), token = secret(); store.run('INSERT INTO invitations VALUES(?,?,?,?,?,?,?,?,?,?)', id, t.id, input.email.toLowerCase(), hash(token), json(input.permissions), json(input.eventIds), new Date(Date.now() + 7 * 86400000).toISOString(), null, now(), 'staff');
    store.audit(t.id, req.user.id, 'staff.invited', { invitationId: id }); res.status(201).json({ id, path: `/invite/${token}` });
  });
  app.patch('/api/business/:slug/staff/:id', auth, (req, res) => {
    const { t, m } = access(req, req.params.slug, 'staff'); feature(t, 'staff'); fail(['owner', 'admin'].includes(m.role), 403, 'Only the owner can edit staff permissions.');
    const input = z.object({ permissions: z.array(z.enum(permissions)).min(1), eventIds: z.array(z.string()).default([]) }).parse(req.body);
    for (const id of input.eventIds) fail(store.get('SELECT id FROM events WHERE id=? AND tenant_id=?', id, t.id), 400, 'Event not found for this business.');
    fail(store.get("SELECT id FROM memberships WHERE id=? AND tenant_id=? AND role='staff'", req.params.id, t.id), 404, 'Staff member not found.');
    store.run('UPDATE memberships SET permissions=?,event_ids=? WHERE id=?', json(input.permissions), json(input.eventIds), req.params.id); store.audit(t.id, req.user.id, 'staff.permissions_changed', { membershipId: req.params.id }); res.json({ ok: true });
  });
  app.delete('/api/business/:slug/staff/:id', auth, (req, res) => {
    const { t, m } = access(req, req.params.slug, 'staff'); fail(['owner', 'admin'].includes(m.role), 403, 'Only the owner can remove staff.');
    const result = store.run("DELETE FROM memberships WHERE id=? AND tenant_id=? AND role='staff'", req.params.id, t.id); fail(result.changes, 404, 'Staff member not found.'); store.audit(t.id, req.user.id, 'staff.removed', { membershipId: req.params.id }); res.json({ ok: true });
  });
  app.delete('/api/business/:slug/invitations/:id', auth, (req, res) => { const { t } = access(req, req.params.slug, 'staff'); store.run('DELETE FROM invitations WHERE id=? AND tenant_id=? AND used_at IS NULL', req.params.id, t.id); res.json({ ok: true }); });
  app.post('/api/business/:slug/announcements', auth, (req, res) => {
    const { t, m } = access(req, req.params.slug, 'notifications'); feature(t, 'notifications');
    const input = z.object({ title: z.string().trim().min(3).max(100), body: z.string().trim().min(3).max(500), eventId: z.string().optional() }).parse(req.body);
    if (m.role === 'staff' && m.eventIds.length) fail(input.eventId, 403, 'Choose one of your assigned events for this announcement.');
    if (input.eventId) { access(req, t.id, 'notifications', input.eventId); fail(store.get('SELECT id FROM events WHERE id=? AND tenant_id=?', input.eventId, t.id), 404, 'Event not found.'); }
    const id = notice(t.id, 'public', input.title, input.body, input.eventId ? `/p/${t.slug}/events/${input.eventId}` : `/p/${t.slug}/events`, null, input.eventId || null);
    store.audit(t.id, req.user.id, 'announcement.sent', { noticeId: id }); res.status(201).json({ id, queued: store.get('SELECT COUNT(*) AS n FROM push_jobs WHERE notice_id=?', id).n });
  });
  app.post('/api/business/:slug/invoices/:id/proof', auth, upload.single('proof'), async (req, res) => {
    const { t, m } = access(req, req.params.slug, null, null, true); fail(['owner', 'admin'].includes(m.role), 403, 'Only the owner can pay platform invoices.');
    const invoice = store.get('SELECT * FROM invoices WHERE id=? AND tenant_id=?', req.params.id, t.id); fail(invoice && ['unpaid', 'rejected'].includes(invoice.status), 409, 'This invoice is not awaiting payment.');
    fail(await validateImage(req.file), 400, 'Upload a valid payment screenshot up to 8 MB.');
    fail(Number(req.body.amount) === invoice.amount && req.body.currency === invoice.currency, 400, 'Amount and currency must match this invoice.');
    const reference = z.string().trim().min(2).max(120).parse(req.body.reference), id = uid('proof_'), filename = `${id}.image`;
    fail(store.setting('platformAccounts', []).some(a => a.currency === invoice.currency), 409, 'Techverse needs to configure a receiving account for this currency.');
    putFile(store,filename,req.file.buffer,{tenantId:t.id,mime:req.file.mimetype,private:true});
    try { store.tx(() => { const current = store.get('SELECT status FROM invoices WHERE id=?', invoice.id); fail(['unpaid','rejected'].includes(current.status), 409, 'Payment proof has already been submitted.'); store.run('INSERT INTO proofs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', id, t.id, 'invoice', invoice.id, filename, req.file.mimetype, invoice.amount, invoice.currency, reference, 'pending', null, '', now()); store.run("UPDATE invoices SET status='awaiting_review' WHERE id=?", invoice.id); store.audit(t.id, req.user.id, 'invoice.proof_submitted', { invoiceId: invoice.id }); notice(t.id, 'private', 'Platform payment proof', 'A business payment is ready for Techverse verification.', '/admin/billing', 'platform_admin'); }); } catch(e) { removeFile(store,filename); throw e; }
    res.status(201).json({ ok: true });
  });
  app.get('/api/business/:slug/export/:kind', auth, (req, res) => {
    fail(['bookings', 'orders'].includes(req.params.kind), 404, 'Export not found.');
    const { t, m } = access(req, req.params.slug, req.params.kind === 'orders' ? 'events' : 'bookings', null, true);
    const rows = documents(store, req.params.kind, t.id).filter(row => !row.event_id || can(m, 'events', row.event_id));
    const columns = req.params.kind === 'bookings' ? ['id', 'name', 'email', 'phone', 'serviceTitle', 'starts_at', 'status', 'amount', 'currency'] : ['id', 'name', 'email', 'phone', 'eventTitle', 'tierName', 'quantity', 'status', 'amount', 'currency'];
    const escape = value => { let s = String(value ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replaceAll('"', '""') + '"'; };
    res.type('text/csv').attachment(`${t.slug}-${req.params.kind}.csv`).send([columns.join(','), ...rows.map(row => columns.map(c => escape(row[c])).join(','))].join('\r\n'));
  });
  ctx.tasks.push(() => {
    const inDay = new Date(Date.now() + 24 * 3600000).toISOString();
    for (const row of store.all('SELECT * FROM events')) {
      const event = parse(row.doc), t = readTenant(store, row.tenant_id);
      if (!event.published || event.cancelled || event.reminderSent || event.startsAt < now() || event.startsAt > inDay || !t.features.notifications || !t.published || statusOf(store, t) !== 'active') continue;
      store.tx(() => { notice(t.id, 'public', 'Coming up soon', `${event.title} · ${event.venue}`, `/p/${t.slug}/events/${row.id}`, null, row.id); event.reminderSent = true; store.run('UPDATE events SET doc=? WHERE id=?', json(event), row.id); });
    }
  });
}
