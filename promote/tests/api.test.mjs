import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import sharp from 'sharp';
import { createApp } from '../server/index.mjs';
import { now, parse, readTenant, statusOf, nextBillingDate } from '../server/core.mjs';
import {makeTheme,contrast} from '../shared/theme.mjs';

test('Promote: complete business, booking, payment, ticket and billing stories', async t => {
  mkdirSync('.data/tests', { recursive: true });
  const dir=mkdtempSync(resolve('.data/tests/api-')),runtime=createApp({dataDir:dir,scheduler:false});
  const server=runtime.app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const hostRequest=(path,host)=>new Promise((resolve,reject)=>{const request=httpRequest(origin+path,{headers:{Host:host}},response=>{let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>resolve({status:response.statusCode,data:JSON.parse(body)}));});request.on('error',reject);request.end();});
  const client=()=>({cookie:'',async request(path,{method='GET',body,access,headers={}}={}){
    const h={'X-Promote-Request':'1',...headers};if(this.cookie)h.Cookie=this.cookie;if(access)h.Authorization=`Bearer ${access}`;
    if(body&&!(body instanceof FormData)){h['Content-Type']='application/json';body=JSON.stringify(body);}
    const response=await fetch(origin+path,{method,headers:h,body});
    const cookie=response.headers.get('set-cookie');if(cookie)this.cookie=cookie.split(';')[0];
    const type=response.headers.get('content-type')||'';const data=type.includes('json')?await response.json():await response.arrayBuffer();
    return {status:response.status,data,response};
  }});
  const admin=client(),guest=client(),dj=client(),staff=client();
  const future=days=>new Date(Date.now()+days*86400000).toISOString();
  const account={id:'test-account',label:'TEST receiving account',type:'bank',currency:'NGN',provider:'Test Bank',holder:'Test Account',number:'0000000000',instructions:'Test only'};
  const image=await sharp({create:{width:64,height:64,channels:3,background:'#a0be78'}}).png().toBuffer();
  const proof=(amount,currency='NGN')=>{const body=new FormData();body.set('reference','TEST-TRANSFER-001');body.set('amount',String(amount));body.set('currency',currency);body.set('proof',new Blob([image],{type:'image/png'}),'receipt.png');return body;};
  let booking,bookingProof,freeEvent,freeOrder,staffMember,paidOrder,invoice,platformProof,uploadedAsset;
  try {
    await t.test('first-run administrator setup and initial profile',async()=>{
      let r=await admin.request('/api/bootstrap');assert.equal(r.data.setupRequired,true);assert.equal(r.data.professions.length,10);
      r=await admin.request('/api/setup',{method:'POST',body:{name:'Techverse Test Admin',email:'admin@test.example',password:'Test-admin-strong-2026'}});assert.equal(r.status,201,JSON.stringify(r.data));
      r=await admin.request('/api/setup',{method:'POST',body:{}});assert.equal(r.status,409);
      r=await guest.request('/api/public/mchenry');assert.equal(r.status,200);assert.equal(r.data.services.length,3);assert.equal(r.data.events.length,0);assert.equal(r.data.business.paymentAccounts,undefined);
    });
    await t.test('independent business creation and session separation',async()=>{
      const r=await dj.request('/api/register',{method:'POST',body:{name:'DJ Kulture',email:'dj@test.example',password:'Test-kulture-strong-2026',businessName:'DJ Kulture',slug:'djkulture',professions:['dj','organiser']}});assert.equal(r.status,201,JSON.stringify(r.data));
      const other=await dj.request('/api/business/mchenry/dashboard');assert.equal(other.status,403);
      const list=await guest.request('/api/directory');assert.equal(list.data.businesses.length,1);
    });
    await t.test('receiving account configuration and enquiry creation',async()=>{
      let r=await admin.request('/api/business/mchenry/payment-accounts',{method:'PUT',body:{accounts:[account]}});assert.equal(r.status,200,JSON.stringify(r.data));
      const services=(await guest.request('/api/public/mchenry')).data.services;
      const service=services.find(s=>s.category==='mc');
      r=await guest.request('/api/public/mchenry/bookings',{method:'POST',body:{name:'Booking Customer',email:'customer@test.example',phone:'+2348000000000',serviceId:service.id,startsAt:future(5),answers:{location:'Test venue',guests:'50',budget:'NGN 100,000'},notes:'Integration test'}});
      assert.equal(r.status,201,JSON.stringify(r.data));booking=r.data;
      r=await guest.request(`/api/guest/bookings/${booking.id}`);assert.equal(r.status,404);
      r=await guest.request(`/api/guest/bookings/${booking.id}`,{access:booking.access});assert.equal(r.data.paymentAccounts.length,0);assert.equal(r.data.booking.status,'requested');
    });
    await t.test('uploaded pictures render and can be reused from the business library',async()=>{
      const body=new FormData();body.set('image',new Blob([image],{type:'image/png'}),'brand.png');
      let r=await admin.request('/api/business/mchenry/assets',{method:'POST',body});assert.equal(r.status,201,JSON.stringify(r.data));uploadedAsset=r.data;
      r=await guest.request(uploadedAsset.url);assert.equal(r.status,200);assert.match(r.response.headers.get('content-type'),/image\/webp/);assert.equal((await sharp(Buffer.from(r.data)).metadata()).width,64);
      r=await admin.request('/api/business/mchenry/assets');assert(r.data.assets.some(a=>a.url===uploadedAsset.url));
      r=await dj.request('/api/business/mchenry/assets');assert.equal(r.status,403);
      r=await guest.request('/media/uploads/.env');assert.equal(r.status,404);
    });
    await t.test('every chosen colour has readable text and persists to the website and PWA',async()=>{
      for(let sample=0;sample<4096;sample++)for(const mode of ['dark','light']){const color='#'+[sample>>8,(sample>>4)&15,sample&15].map(n=>(n*17).toString(16).padStart(2,'0')).join(''),theme=makeTheme(color,mode);assert(contrast(theme.text,theme.background)>=4.5);assert(contrast(theme.muted,theme.background)>=4.5);assert(contrast(theme.accent,theme.onAccent)>=4.5);assert(contrast(theme.hover,theme.onAccent)>=4.5);assert(contrast(theme.ink,theme.background)>=4.5);}
      const d=(await admin.request('/api/business/mchenry/dashboard')).data;
      let r=await admin.request('/api/business/mchenry/profile',{method:'PATCH',body:{...d.business,accent:'#8771f4',themeMode:'light'}});assert.equal(r.status,200,JSON.stringify(r.data));
      r=await guest.request('/api/public/mchenry');assert.equal(r.data.business.accent,'#8771f4');assert.equal(r.data.business.themeMode,'light');
      r=await guest.request('/api/brand/mchenry/manifest.webmanifest');assert.equal(r.data.background_color,makeTheme('#8771f4','light').background);
    });
    await t.test('availability confirmation unlocks payment and reserves the date',async()=>{
      let r=await admin.request(`/api/business/mchenry/bookings/${booking.id}/decision`,{method:'POST',body:{action:'accept',amount:10000000,currency:'NGN',payBy:future(2),note:'Your date is available.'}});assert.equal(r.status,200,JSON.stringify(r.data));
      r=await guest.request(`/api/guest/bookings/${booking.id}`,{access:booking.access});assert.equal(r.data.booking.status,'awaiting_payment');assert.equal(r.data.paymentAccounts[0].number,'0000000000');
      const service=(await guest.request('/api/public/mchenry')).data.services.find(s=>s.category==='mc');
      r=await guest.request('/api/public/mchenry/bookings',{method:'POST',body:{name:'Overlap Customer',email:'overlap@test.example',phone:'+2348000000000',serviceId:service.id,startsAt:r.data.booking.starts_at,answers:{location:'Test',guests:'10'}}});assert.equal(r.status,409);
    });
    await t.test('screenshot proof is mandatory, private and manually verified',async()=>{
      let r=await guest.request(`/api/guest/bookings/${booking.id}/proof`,{method:'POST',access:booking.access,body:proof(10)});assert.equal(r.status,400);
      r=await guest.request(`/api/guest/bookings/${booking.id}/proof`,{method:'POST',access:booking.access,body:proof(10000000)});assert.equal(r.status,201,JSON.stringify(r.data));bookingProof=r.data.id;
      r=await guest.request(`/api/guest/bookings/${booking.id}`,{access:booking.access});assert.equal(r.data.booking.status,'awaiting_review');
      r=await guest.request(`/api/proofs/${bookingProof}/image`);assert.equal(r.status,401);
      r=await dj.request(`/api/proofs/${bookingProof}/image`);assert.equal(r.status,403);
      r=await admin.request(`/api/proofs/${bookingProof}/image`);assert.equal(r.status,200);assert.match(r.response.headers.get('content-type'),/image\/png/);assert.equal(Buffer.from(r.data).subarray(1,4).toString(),'PNG');
      r=await admin.request(`/api/business/mchenry/proofs/${bookingProof}/review`,{method:'POST',body:{decision:'approve',note:'Verified in test'}});assert.equal(r.status,200,JSON.stringify(r.data));
      r=await guest.request(`/api/guest/bookings/${booking.id}`,{access:booking.access});assert.equal(r.data.booking.status,'confirmed');
      r=await admin.request(`/api/business/mchenry/proofs/${bookingProof}/review`,{method:'POST',body:{decision:'approve'}});assert.equal(r.status,409);
    });
    const eventBody=(title,price=0,capacity=2)=>({title,description:'An isolated test event.',venue:'Test venue',address:'Test address',startsAt:future(7),endsAt:future(7.2),salesEnd:'',capacity,currency:'NGN',image:'',published:true,cancelled:false,tiers:[{id:'general',name:'General admission',price}]});
    const orderBody=eventId=>({name:'Ticket Guest',email:'ticket@test.example',phone:'+2348000000000',eventId,tierId:'general',quantity:2});
    await t.test('free tickets issue immediately and capacity cannot be oversold',async()=>{
      let r=await admin.request('/api/business/mchenry/events',{method:'POST',body:eventBody('Free test event')});assert.equal(r.status,201,JSON.stringify(r.data));freeEvent=r.data.id;
      const outcomes=await Promise.all([guest.request('/api/public/mchenry/orders',{method:'POST',body:orderBody(freeEvent)}),guest.request('/api/public/mchenry/orders',{method:'POST',body:orderBody(freeEvent)})]);
      assert.deepEqual(outcomes.map(o=>o.status).sort(),[201,409]);freeOrder=outcomes.find(o=>o.status===201).data;
      r=await guest.request(`/api/guest/orders/${freeOrder.id}`,{access:freeOrder.access});assert.equal(r.data.order.status,'confirmed');assert.equal(r.data.tickets.length,2);freeOrder.tickets=r.data.tickets;
    });
    await t.test('staff invitations enforce selected event and capability permissions',async()=>{
      let r=await admin.request('/api/business/mchenry/staff/invite',{method:'POST',body:{email:'scanner@test.example',permissions:['scan'],eventIds:[freeEvent]}});assert.equal(r.status,201,JSON.stringify(r.data));const token=r.data.path.split('/').pop();
      r=await staff.request(`/api/invitations/${token}/accept`,{method:'POST',body:{name:'Door Staff',password:'Test-staff-strong-2026'}});assert.equal(r.status,200,JSON.stringify(r.data));
      r=await staff.request('/api/business/mchenry/dashboard');assert.equal(r.status,200);assert.equal(r.data.proofs.length,0);assert.equal(r.data.bookings.length,0);assert.equal(r.data.business.paymentAccounts,undefined);assert.equal(r.data.events.length,1);
      staffMember=(await admin.request('/api/business/mchenry/dashboard')).data.staff.find(s=>s.email==='scanner@test.example');
      r=await staff.request('/api/business/mchenry/events',{method:'POST',body:eventBody('Unauthorised event')});assert.equal(r.status,403);
      r=await staff.request(`/api/proofs/${bookingProof}/image`);assert.equal(r.status,403);
      r=await staff.request('/api/admin/overview');assert.equal(r.status,403);
    });
    await t.test('check-in is single-use and a removed staff member immediately loses access',async()=>{
      let r=await staff.request('/api/business/mchenry/scan',{method:'POST',body:{code:`PROMOTE:${freeOrder.tickets[0].code}`}});assert.equal(r.status,200,JSON.stringify(r.data));
      r=await staff.request('/api/business/mchenry/scan',{method:'POST',body:{code:freeOrder.tickets[0].code}});assert.equal(r.status,409);
      const second=(await admin.request('/api/business/mchenry/events',{method:'POST',body:eventBody('Different test event')})).data;
      const otherOrder=(await guest.request('/api/public/mchenry/orders',{method:'POST',body:orderBody(second.id)})).data;
      const otherTickets=(await guest.request(`/api/guest/orders/${otherOrder.id}`,{access:otherOrder.access})).data.tickets;
      r=await staff.request('/api/business/mchenry/scan',{method:'POST',body:{code:otherTickets[0].code}});assert.equal(r.status,403);
      await admin.request('/api/admin/businesses/tn_henry',{method:'PATCH',body:{features:{staff:false}}});
      r=await staff.request('/api/business/mchenry/dashboard');assert.equal(r.status,403);
      await admin.request('/api/admin/businesses/tn_henry',{method:'PATCH',body:{features:{staff:true}}});
      r=await admin.request(`/api/business/mchenry/staff/${staffMember.id}`,{method:'DELETE'});assert.equal(r.status,200);
      r=await staff.request('/api/business/mchenry/scan',{method:'POST',body:{code:freeOrder.tickets[1].code}});assert.equal(r.status,403);
    });
    await t.test('paid tickets are withheld until a screenshot is verified',async()=>{
      const event=(await admin.request('/api/business/mchenry/events',{method:'POST',body:eventBody('Paid test event',50000,10)})).data;
      let r=await guest.request('/api/public/mchenry/orders',{method:'POST',body:orderBody(event.id)});assert.equal(r.status,201);paidOrder=r.data;
      r=await guest.request(`/api/guest/orders/${paidOrder.id}`,{access:paidOrder.access});assert.equal(r.data.tickets.length,0);assert.equal(r.data.order.amount,100000);
      r=await guest.request(`/api/guest/orders/${paidOrder.id}/proof`,{method:'POST',access:paidOrder.access,body:proof(100000)});assert.equal(r.status,201,JSON.stringify(r.data));
      r=await admin.request(`/api/business/mchenry/proofs/${r.data.id}/review`,{method:'POST',body:{decision:'approve'}});assert.equal(r.status,200,JSON.stringify(r.data));
      r=await guest.request(`/api/guest/orders/${paidOrder.id}`,{access:paidOrder.access});assert.equal(r.data.tickets.length,2);paidOrder.tickets=r.data.tickets;
    });
    await t.test('billing remains dormant until activated and holds new business operations',async()=>{
      let r=await admin.request('/api/admin/invoices',{method:'POST',body:{tenantId:'tn_henry',title:'Test platform invoice',amount:250000,currency:'NGN',dueAt:future(-2),holdAt:future(-1)}});assert.equal(r.status,201);invoice=r.data.id;
      r=await admin.request('/api/business/mchenry/dashboard');assert.equal(r.data.business.status,'active');
      r=await admin.request('/api/admin/settings',{method:'PATCH',body:{billingEnabled:true}});assert.equal(r.status,400);
      r=await admin.request('/api/admin/settings',{method:'PATCH',body:{platformAccounts:[account],billingEnabled:true}});assert.equal(r.status,200,JSON.stringify(r.data));
      r=await admin.request('/api/business/mchenry/dashboard');assert.equal(r.data.business.status,'billing_hold');
      r=await guest.request('/api/public/mchenry/orders',{method:'POST',body:orderBody(freeEvent)});assert.equal(r.status,423);
      r=await admin.request('/api/business/mchenry/scan',{method:'POST',body:{code:paidOrder.tickets[0].code}});assert.equal(r.status,200,'Existing tickets stay usable during a billing hold');
    });
    await t.test('platform screenshot confirmation automatically restores access',async()=>{
      let r=await admin.request(`/api/business/mchenry/invoices/${invoice}/proof`,{method:'POST',body:proof(250000)});assert.equal(r.status,201,JSON.stringify(r.data));
      r=await admin.request('/api/admin/overview');platformProof=r.data.proofs.find(p=>p.reference_id===invoice);assert(platformProof);
      r=await admin.request('/api/business/mchenry/dashboard');assert.equal(r.data.business.status,'billing_hold');
      r=await dj.request(`/api/admin/proofs/${platformProof.id}/review`,{method:'POST',body:{decision:'approve'}});assert.equal(r.status,403);
      r=await admin.request(`/api/admin/proofs/${platformProof.id}/review`,{method:'POST',body:{decision:'approve'}});assert.equal(r.status,200);
      r=await admin.request('/api/business/mchenry/dashboard');assert.equal(r.data.business.status,'active');
    });
    await t.test('brand features support drafts, schedules, ownership, activity and archiving',async()=>{
      const body={brand:'Test Shawarma',title:'Have you met your next favourite?',teaser:'A test recommendation selected by the host.',description:'Isolated test data.',cta:'Explore the menu',destination:'https://example.com/menu',mediaType:'image',mediaUrl:uploadedAsset.url,posterUrl:'',logoUrl:'',placement:'sidecard',active:false,autoplay:true,allowSound:true,startsAt:'',endsAt:'',priority:1};
      let r=await admin.request('/api/business/mchenry/sponsors',{method:'POST',body});assert.equal(r.status,201,JSON.stringify(r.data));const id=r.data.id;
      r=await guest.request('/api/public/mchenry/sponsors');assert.equal(r.data.campaigns.length,0);
      r=await admin.request(`/api/business/mchenry/sponsors/${id}/state`,{method:'PATCH',body:{action:'enable'}});assert.equal(r.status,200);
      r=await guest.request('/api/public/mchenry/sponsors');assert.equal(r.data.campaigns.length,1);
      const device='sponsor_test_device_123456789';await guest.request(`/api/public/mchenry/sponsors/${id}/activity`,{method:'POST',body:{device,kind:'view'}});await guest.request(`/api/public/mchenry/sponsors/${id}/activity`,{method:'POST',body:{device,kind:'view'}});await guest.request(`/api/public/mchenry/sponsors/${id}/activity`,{method:'POST',body:{device,kind:'click'}});
      r=await admin.request('/api/business/mchenry/dashboard');assert.equal(r.data.sponsorStats.find(s=>s.campaign_id===id&&s.kind==='view').count,1);
      r=await dj.request('/api/business/djkulture/sponsors',{method:'POST',body:{...body,active:true}});assert.equal(r.status,400,'Another business cannot use Henry’s uploaded media');
      r=await admin.request('/api/business/mchenry/sponsors',{method:'POST',body:{...body,active:true,startsAt:future(1),endsAt:future(3),priority:99}});assert.equal(r.status,201);
      r=await guest.request('/api/public/mchenry/sponsors');assert.equal(r.data.campaigns.length,1,'Scheduled features stay hidden until their date');
      await admin.request(`/api/business/mchenry/sponsors/${id}/state`,{method:'PATCH',body:{action:'archive'}});r=await guest.request('/api/public/mchenry/sponsors');assert.equal(r.data.campaigns.length,0);
      await admin.request(`/api/business/mchenry/sponsors/${id}/state`,{method:'PATCH',body:{action:'restore'}});r=await guest.request('/api/public/mchenry/sponsors');assert.equal(r.data.campaigns.length,0,'Restoring does not unexpectedly publish an ad');
      const bad=new FormData();bad.set('media',new Blob([Buffer.alloc(200,65)],{type:'video/mp4'}),'fake.mp4');r=await admin.request('/api/business/mchenry/sponsor-assets',{method:'POST',body:bad});assert.equal(r.status,400);
      await admin.request('/api/admin/businesses/tn_henry',{method:'PATCH',body:{features:{sponsors:false}}});r=await admin.request('/api/business/mchenry/sponsors',{method:'POST',body});assert.equal(r.status,403);
      await admin.request('/api/admin/businesses/tn_henry',{method:'PATCH',body:{features:{sponsors:true}}});
    });
    await t.test('feature switches, directory control and recurring invoice idempotency',async()=>{
      assert.equal(nextBillingDate('2027-01-31T12:00:00.000Z','monthly',31),'2027-02-28T12:00:00.000Z');
      assert.equal(nextBillingDate('2027-02-28T12:00:00.000Z','monthly',31),'2027-03-31T12:00:00.000Z');
      assert.equal(nextBillingDate('2027-02-28T12:00:00.000Z','yearly',29),'2028-02-29T12:00:00.000Z');
      let r=await admin.request('/api/admin/settings',{method:'PATCH',body:{directoryEnabled:false}});assert.equal(r.status,200);
      r=await guest.request('/api/directory');assert.equal(r.data.businesses.length,0);
      r=await admin.request('/api/admin/businesses/tn_henry',{method:'PATCH',body:{features:{bookings:false}}});assert.equal(r.status,200);
      r=await guest.request('/api/public/mchenry/bookings',{method:'POST',body:{}});assert.equal(r.status,403);
      const plan=(await admin.request('/api/admin/plans',{method:'POST',body:{name:'Test ticketing plan',amount:50000,currency:'NGN',features:['events','staff','notifications'],period:'monthly',active:true}})).data;
      r=await admin.request('/api/admin/businesses/tn_henry/plan',{method:'POST',body:{planId:plan.id,nextIssueAt:future(-0.1),graceDays:7}});assert.equal(r.status,200);
      const count=runtime.store.get('SELECT COUNT(*) AS n FROM invoices').n;runtime.runScheduled();runtime.runScheduled();assert.equal(runtime.store.get('SELECT COUNT(*) AS n FROM invoices').n,count);
    });
    await t.test('push configuration, announcement queue and measured activity',async()=>{
      let r=await guest.request('/api/public/mchenry/push-key');assert.equal(r.status,200);assert(r.data.publicKey.length>80);
      const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/isolated-test-do-not-send',expirationTime:null,keys:{p256dh:'a'.repeat(87),auth:'a'.repeat(22)}};
      r=await guest.request('/api/public/mchenry/subscribe',{method:'POST',body:{subscription,private:false}});assert.equal(r.status,201,JSON.stringify(r.data));
      r=await guest.request('/api/public/mchenry/subscribe',{method:'POST',body:{subscription:{...subscription,endpoint:'https://127.0.0.1/internal'},private:false}});assert.equal(r.status,400);
      r=await admin.request('/api/business/mchenry/announcements',{method:'POST',body:{title:'Test announcement',body:'A test event update for subscribers.'}});assert.equal(r.status,201);assert.equal(r.data.queued,1);
      const device='test_device_1234567890';await guest.request('/api/public/mchenry/metrics',{method:'POST',body:{device,kind:'install'}});await guest.request('/api/public/mchenry/metrics',{method:'POST',body:{device,kind:'install'}});
      r=await admin.request('/api/business/mchenry/dashboard');assert.equal(r.data.stats.observedInstalls,1);assert.equal(r.data.stats.subscribers,1);
      r=await admin.request('/api/public/mchenry/subscribe',{method:'POST',body:{subscription,private:true}});assert.equal(r.status,201);
      r=await admin.request('/api/public/mchenry/subscription-status',{method:'POST',body:{endpoint:subscription.endpoint,private:true}});assert.equal(r.data.subscribed,true);
      r=await admin.request('/api/public/mchenry/subscription-status',{method:'POST',body:{endpoint:subscription.endpoint,private:false}});assert.equal(r.data.subscribed,true,'Public and private alerts can coexist on a device');
      r=await guest.request('/api/public/mchenry/subscription-status',{method:'POST',body:{endpoint:subscription.endpoint,private:true}});assert.equal(r.data.subscribed,false,'Private alert status requires the subscribed account');
      r=await admin.request('/api/public/mchenry/subscribe',{method:'DELETE',body:{endpoint:subscription.endpoint,private:false}});assert.equal(r.data.removeDeviceSubscription,false);
      r=await admin.request('/api/public/mchenry/subscription-status',{method:'POST',body:{endpoint:subscription.endpoint,private:false}});assert.equal(r.data.subscribed,false);
      r=await admin.request('/api/public/mchenry/subscription-status',{method:'POST',body:{endpoint:subscription.endpoint,private:true}});assert.equal(r.data.subscribed,true,'Disabling public updates preserves private work alerts');
    });
    await t.test('distinct PWA identities, valid PNG icons and CSRF protection',async()=>{
      const a=await guest.request('/api/brand/mchenry/manifest.webmanifest'),b=await guest.request('/api/brand/djkulture/manifest.webmanifest');
      assert.equal(a.data.name,'MC Henry');assert.notEqual(a.data.id,b.data.id);assert.equal(a.data.icons.length,2);
      const png=await guest.request('/api/brand/mchenry/icon.png?size=192');assert.equal(png.status,200);assert.equal(Buffer.from(png.data).subarray(1,4).toString(),'PNG');
      const csrf=await fetch(origin+'/api/auth/logout',{method:'POST'});assert.equal(csrf.status,403);
      const originTest=await guest.request('/api/auth/logout',{method:'POST',headers:{Origin:'https://evil.example'}});assert.equal(originTest.status,403);
    });
    await t.test('new professions are configurable and tenant hosts select their own site',async()=>{
      let r=await admin.request('/api/admin/professions',{method:'POST',body:{id:'makeup-artist',name:'Makeup Artist',icon:'Sparkles'}});assert.equal(r.status,201,JSON.stringify(r.data));
      r=await guest.request('/api/bootstrap');assert.equal(r.data.professions.length,11);
      r=await dj.request('/api/admin/professions',{method:'POST',body:{id:'fake-role',name:'Fake role',icon:'Sparkles'}});assert.equal(r.status,403);
      const own=await hostRequest('/api/bootstrap',`mchenry.localhost:${server.address().port}`);assert.equal(own.data.tenant.slug,'mchenry');
      r=await hostRequest('/api/public/djkulture',`mchenry.localhost:${server.address().port}`);assert.equal(r.status,404);
    });
  } finally { await new Promise(resolve=>server.close(resolve));runtime.close(); }
});
