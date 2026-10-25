import { z } from 'zod';
import { resolveTxt } from 'node:dns/promises';
import { fail, uid, secret, hash, now, json, parse, permissions, professions, featureNames, readTenant, saveTenant, statusOf, metricsFor, invoiceResult, sweep } from './core.mjs';
import { accountsSchema } from './routes-business.mjs';
import { currencySchema } from './routes-public.mjs';
import {professionBlueprints,professionFor} from '../shared/professions.mjs';
import {addServiceTemplates,catalogue} from './professional-data.mjs';

const featureSchema = z.partialRecord(z.enum(Object.keys(featureNames)), z.boolean());
const makeInvitation = (store, tenantId, email, role) => {
  const id = uid('invite_'), token = secret();
  store.run('INSERT INTO invitations VALUES(?,?,?,?,?,?,?,?,?,?)', id, tenantId, email.toLowerCase(), hash(token), json(permissions), '[]', new Date(Date.now() + 7 * 86400000).toISOString(), null, now(), role);
  return `/invite/${token}`;
};
export function adminRoutes(app, ctx) {
  const { store, admin, auth, access, feature, notice } = ctx;
  app.get('/api/admin/overview', admin, (req, res) => {
    sweep(store);
    const businesses = store.all('SELECT id FROM tenants ORDER BY created_at DESC').map(row => {
      const t = readTenant(store, row.id); return { ...t, status: statusOf(store, t), stats: metricsFor(store, t.id), owners: store.all("SELECT u.name,u.email FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.tenant_id=? AND m.role='owner'", t.id) };
    });
    const invoices = store.all('SELECT i.*,t.name AS business_name,t.slug FROM invoices i JOIN tenants t ON i.tenant_id=t.id ORDER BY i.created_at DESC').map(row => invoiceResult(store, row));
    res.json({ businesses, invoices,
      settings: { directoryEnabled: store.setting('directoryEnabled', true), billingEnabled: store.setting('billingEnabled', false), publicRegistration: store.setting('publicRegistration', true), platformAccounts: store.setting('platformAccounts', []), platformName: store.setting('platformName', 'Promote') },
      plans: store.all('SELECT * FROM plans').map(plan => ({ ...plan, features: parse(plan.features, []) })),
      proofs: store.all("SELECT p.*,t.name AS business_name FROM proofs p JOIN tenants t ON p.tenant_id=t.id WHERE p.kind='invoice' ORDER BY p.created_at DESC"),
      activity: store.all('SELECT a.*,u.name,t.name AS business_name FROM activity a LEFT JOIN users u ON a.user_id=u.id LEFT JOIN tenants t ON a.tenant_id=t.id ORDER BY a.created_at DESC LIMIT 60').map(a => ({ ...a, detail: parse(a.detail) })),
      delivery: store.all('SELECT status,COUNT(*) AS count FROM push_jobs GROUP BY status'),
      domain: process.env.BASE_DOMAIN || 'localhost',
    });
  });
  app.get('/api/admin/live', admin, (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
    let latest = store.get('SELECT COUNT(*) AS n FROM activity').n;
    res.write('retry: 5000\n\n');
    const interval = setInterval(() => { if(!store.get('SELECT token FROM sessions WHERE token=? AND expires_at>?', req.sessionHash||'', now())){res.end();return;} const current = store.get('SELECT COUNT(*) AS n FROM activity').n; if (current !== latest) { latest = current; res.write(`data: ${JSON.stringify({ type: 'refresh' })}\n\n`); } else res.write(': connected\n\n'); }, 3000);
    req.on('close', () => clearInterval(interval));
  });
  app.patch('/api/admin/settings', admin, (req, res) => {
    const input = z.object({ directoryEnabled: z.boolean().optional(), billingEnabled: z.boolean().optional(), publicRegistration: z.boolean().optional(), platformAccounts: accountsSchema.optional(), platformName: z.string().trim().min(2).max(60).optional() }).parse(req.body);
    if ((input.billingEnabled ?? store.setting('billingEnabled', false)) && (input.billingEnabled === true || input.platformAccounts)) {
      fail(store.setting('platformAccounts', []).length > 0 || input.platformAccounts?.length > 0, 400, 'Configure Techverse payment accounts before enabling billing.');
      const openCurrencies = store.all("SELECT DISTINCT currency FROM invoices WHERE status NOT IN ('paid','void')").map(i => i.currency);
      const accounts = input.platformAccounts || store.setting('platformAccounts', []);
      fail(openCurrencies.every(c => accounts.some(a => a.currency === c)), 400, 'Add Techverse receiving accounts for every outstanding invoice currency.');
    }
    if (input.billingEnabled === true && !store.setting('billingEnabled', false)) store.setSetting('billingActivatedAt', now());
    for (const [key, value] of Object.entries(input)) store.setSetting(key, value);
    store.audit(null, req.user.id, 'platform.settings_changed', { keys: Object.keys(input) }); sweep(store); res.json({ ok: true });
  });
  app.post('/api/admin/businesses', admin, (req, res) => {
    const input = z.object({ name: z.string().trim().min(2).max(80), slug: z.string().regex(/^[a-z][a-z0-9-]{2,35}$/), professions: z.array(z.enum(store.setting('professions', professions).map(p => p.id))).min(1).max(20), ownerEmail: z.email(), location: z.string().max(150).default('') }).parse(req.body);
    fail(!['www', 'admin', 'api', 'app', 'mail', 'platform', 'billing', 'support', 'techverse', 'promote'].includes(input.slug) && !readTenant(store, input.slug), 409, 'Choose another business address.');
    const id = uid('tn_'); let path;
    store.tx(() => {
      store.run('INSERT INTO tenants VALUES(?,?,?,?,?,?)', id, input.slug, input.name, 0, json({ professions: input.professions, tagline: '', headline: professionFor(input.professions[0],catalogue(store)).title, bio: '', location: input.location, email: input.ownerEmail, phone: '', areas: [], accent: '#c5f36b', avatar: '', cover: '', gallery: [], social: {}, paymentAccounts: [], features: Object.fromEntries(Object.keys(featureNames).map(k => [k, k !== 'customDomain'])), timezone: 'Africa/Lagos', blocks: [], verified: false }), now());
      addServiceTemplates(store,readTenant(store,id)); path = makeInvitation(store, id, input.ownerEmail, 'owner'); store.audit(id, req.user.id, 'business.created_by_admin');
    });
    res.status(201).json({ id, slug: input.slug, invitation: path });
  });
  app.post('/api/admin/businesses/:id/owner-invitation', admin, (req, res) => {
    const t = readTenant(store, req.params.id); fail(t, 404, 'Business not found.'); const email = z.email().parse(req.body.email);
    const path = makeInvitation(store, t.id, email, 'owner'); store.audit(t.id, req.user.id, 'owner.invited'); res.status(201).json({ invitation: path });
  });
  app.patch('/api/admin/businesses/:id', admin, (req, res) => {
    const t = readTenant(store, req.params.id); fail(t, 404, 'Business not found.');
    const input = z.object({ features: featureSchema.optional(), suspended: z.boolean().optional(), verified: z.boolean().optional(), published: z.boolean().optional() }).parse(req.body);
    if (input.features) t.features = { ...t.features, ...input.features };
    for (const key of ['suspended', 'verified', 'published']) if (input[key] !== undefined) t[key] = input[key];
    saveTenant(store, t); store.audit(t.id, req.user.id, 'business.access_changed', input); res.json({ ok: true });
  });
  app.post('/api/admin/professions', admin, (req,res) => {
    const input = z.object({id:z.string().regex(/^[a-z][a-z0-9-]{1,35}$/),name:z.string().trim().min(2).max(80),blueprint:z.enum(['generic',...Object.keys(professionBlueprints)]).default('generic'),icon:z.enum(['Mic','Disc3','Megaphone','CalendarDays','Compass','Camera','Music2','Smile','Aperture','Video','Sparkles']).default('Sparkles')}).parse(req.body);
    const list=store.setting('professions',professions);fail(!list.some(p=>p.id===input.id),409,'This profession identifier already exists.');
    store.setSetting('professions',[...list,input]);store.audit(null,req.user.id,'profession.created',{id:input.id});res.status(201).json({profession:input});
  });
  const planSchema = z.object({ name: z.string().trim().min(2).max(100), amount: z.number().int().min(0).max(1000000000), currency: currencySchema, features: z.array(z.enum(Object.keys(featureNames))).min(1), period: z.enum(['monthly', 'yearly']), active: z.boolean().default(true) });
  app.post('/api/admin/plans', admin, (req, res) => {
    const input = planSchema.parse(req.body), id = uid('plan_'); store.run('INSERT INTO plans VALUES(?,?,?,?,?,?,?)', id, input.name, input.amount, input.currency, json(input.features), input.period, input.active ? 1 : 0); store.audit(null, req.user.id, 'plan.created', { planId: id }); res.status(201).json({ id });
  });
  app.put('/api/admin/plans/:id', admin, (req, res) => {
    const input = planSchema.parse(req.body); fail(store.get('SELECT id FROM plans WHERE id=?', req.params.id), 404, 'Plan not found.');
    store.run('UPDATE plans SET name=?,amount=?,currency=?,features=?,period=?,active=? WHERE id=?', input.name, input.amount, input.currency, json(input.features), input.period, input.active ? 1 : 0, req.params.id); store.audit(null, req.user.id, 'plan.updated', { planId: req.params.id }); res.json({ ok: true });
  });
  app.post('/api/admin/businesses/:id/plan', admin, (req, res) => {
    const t = readTenant(store, req.params.id); fail(t, 404, 'Business not found.');
    const input = z.object({ planId: z.string(), nextIssueAt: z.iso.datetime(), graceDays: z.number().int().min(1).max(60) }).parse(req.body);
    const plan = store.get('SELECT * FROM plans WHERE id=? AND active=1', input.planId); fail(plan, 404, 'Plan not found.');
    t.billingPlan = input; t.features = Object.fromEntries(Object.keys(featureNames).map(k => [k, parse(plan.features, []).includes(k)])); saveTenant(store, t);
    store.audit(t.id, req.user.id, 'plan.assigned', { planId: plan.id }); sweep(store); res.json({ ok: true });
  });
  app.post('/api/admin/invoices', admin, (req, res) => {
    const input = z.object({ tenantId: z.string(), title: z.string().trim().min(3).max(180), amount: z.number().int().min(1).max(1000000000), currency: currencySchema, dueAt: z.iso.datetime(), holdAt: z.iso.datetime() }).refine(v => v.holdAt >= v.dueAt, 'The hold time must be on or after the payment deadline.').parse(req.body);
    const t = readTenant(store, input.tenantId); fail(t, 404, 'Business not found.');
    const id = uid('inv_'); store.run('INSERT INTO invoices VALUES(?,?,?,?,?,?,?,?,?,?)', id, t.id, 'unpaid', input.amount, input.currency, input.dueAt, input.holdAt, null, json({ title: input.title }), now());
    store.audit(t.id, req.user.id, 'invoice.created', { invoiceId: id }); notice(t.id, 'private', 'New Techverse invoice', 'Your platform invoice is available in Billing.', `/dashboard/${t.slug}/billing`); res.status(201).json({ id });
  });
  app.post('/api/admin/invoices/:id/void', admin, (req, res) => {
    const invoice = store.get('SELECT * FROM invoices WHERE id=?', req.params.id); fail(invoice && !['paid', 'void', 'awaiting_review'].includes(invoice.status), 409, 'This invoice cannot be voided.');
    store.run("UPDATE invoices SET status='void' WHERE id=?", invoice.id); store.audit(invoice.tenant_id, req.user.id, 'invoice.voided', { invoiceId: invoice.id }); res.json({ ok: true });
  });
  app.post('/api/admin/proofs/:id/review', admin, (req, res) => {
    const input = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(1000).default('') }).parse(req.body);
    if (input.decision === 'reject') fail(input.note.trim().length >= 3, 400, 'Add a reason for rejecting the payment proof.');
    store.tx(() => {
      const proof = store.get("SELECT * FROM proofs WHERE id=? AND kind='invoice'", req.params.id); fail(proof && proof.status === 'pending', 409, 'This payment has already been reviewed or does not exist.');
      const invoice = store.get('SELECT * FROM invoices WHERE id=?', proof.reference_id); fail(invoice && invoice.status === 'awaiting_review', 409, 'Invoice is not awaiting review.');
      store.run('UPDATE proofs SET status=?,reviewed_by=?,note=? WHERE id=?', input.decision === 'approve' ? 'approved' : 'rejected', req.user.id, input.note, proof.id);
      store.run('UPDATE invoices SET status=? WHERE id=?', input.decision === 'approve' ? 'paid' : 'rejected', invoice.id);
      store.audit(invoice.tenant_id, req.user.id, `invoice.payment_${input.decision}`, { invoiceId: invoice.id });
      const t = readTenant(store, invoice.tenant_id); notice(t.id, 'private', input.decision === 'approve' ? 'Techverse payment confirmed' : 'Payment needs attention', input.decision === 'approve' ? 'Your invoice has been marked paid. Check Billing for your account status.' : input.note, `/dashboard/${t.slug}/billing`);
    });
    res.json({ ok: true });
  });
  app.post('/api/business/:slug/domains', auth, (req, res) => {
    const { t, m } = access(req, req.params.slug, null, null, true); fail(['owner', 'admin'].includes(m.role), 403, 'Owner access required.'); feature(t, 'customDomain');
    const hostname = z.string().toLowerCase().regex(/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/).parse(req.body.hostname);
    fail(!hostname.endsWith('.localhost') && hostname !== 'localhost' && hostname !== process.env.BASE_DOMAIN && !hostname.endsWith('.' + (process.env.BASE_DOMAIN || 'localhost')), 400, 'Choose a custom domain you own. Your platform subdomain is already configured.');
    fail(!store.get('SELECT id FROM domains WHERE hostname=?', hostname), 409, 'This domain is already assigned.');
    const id = uid('domain_'), token = secret(); store.run('INSERT INTO domains VALUES(?,?,?,?,?,?)', id, t.id, hostname, token, 0, now()); store.audit(t.id, req.user.id, 'domain.added', { hostname }); res.status(201).json({ id, token, hostname });
  });
  app.post('/api/business/:slug/domains/:id/verify', auth, async (req, res) => {
    const { t, m } = access(req, req.params.slug, null, null, true); fail(['owner', 'admin'].includes(m.role), 403, 'Owner access required.'); feature(t, 'customDomain');
    const domain = store.get('SELECT * FROM domains WHERE id=? AND tenant_id=?', req.params.id, t.id); fail(domain, 404, 'Domain not found.');
    let records; try { records = await resolveTxt(`_promote.${domain.hostname}`); } catch { fail(false, 400, 'Verification TXT record not found yet. DNS changes can take time.'); }
    fail(records.some(chunks => chunks.join('') === `promote-verification=${domain.token}`), 400, 'The DNS verification value does not match.');
    store.run('UPDATE domains SET verified=1 WHERE id=?', domain.id); store.audit(t.id, req.user.id, 'domain.verified', { hostname: domain.hostname }); res.json({ ok: true, message: 'Ownership verified. Point the domain to your hosting ingress and enable HTTPS before sharing it.' });
  });
  app.delete('/api/business/:slug/domains/:id', auth, (req, res) => {
    const { t, m } = access(req, req.params.slug, null, null, true); fail(['owner', 'admin'].includes(m.role), 403, 'Owner access required.'); store.run('DELETE FROM domains WHERE id=? AND tenant_id=?', req.params.id, t.id); store.audit(t.id, req.user.id, 'domain.removed'); res.json({ ok: true });
  });
}
