import {uploadCloudForm} from '../src/cloud-api.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import sharp from 'sharp';
import {openStore,seedTenant,ensureKeys,readTenant,saveTenant,hash,now,json} from '../server/core.mjs';
import {createApp} from '../server/index.mjs';
import {postgresSql} from '../server/postgres-sql.mjs';
import {configureBackend} from '../netlify/plugins/backend/configuration.mjs';
import {startRuntime,forwardRequest} from '../netlify/functions/api.mjs';

test('Postgres translation preserves literals, parameter positions, aliases and idempotent inserts',()=>{
 assert.equal(postgresSql("SELECT '?' AS label,? AS observedInstalls FROM metrics WHERE tenant_id=?"),"SELECT '?' AS \"label\",$1 AS \"observedInstalls\" FROM promote.metrics WHERE tenant_id=$2");
 assert.equal(postgresSql("INSERT OR IGNORE INTO notices VALUES(?)"),'INSERT INTO promote.notices VALUES($1) ON CONFLICT DO NOTHING');
 assert.equal(postgresSql("SELECT 'FROM users' AS sample FROM users WHERE email=?"),"SELECT 'FROM users' AS \"sample\" FROM promote.users WHERE email=$1");
 const metrics=postgresSql("SELECT COUNT(*) AS n FROM subscriptions WHERE COALESCE(json_extract(payload,'$.publicEnabled'),CASE WHEN user_id IS NULL THEN 1 ELSE 0 END)=1 AND tenant_id=?");
 assert.match(metrics,/payload::jsonb/);assert.match(metrics,/tenant_id=\$1/);
});
test('Supabase Netlify configuration permits production and blocks previews sharing production data',()=>{
 assert.doesNotThrow(()=>configureBackend({},{PROMOTE_HOSTING:'supabase',CONTEXT:'production'}));
 assert.throws(()=>configureBackend({},{PROMOTE_HOSTING:'supabase',CONTEXT:'deploy-preview'}),/separate Supabase/);
});
test('Native Netlify Request forwarding preserves binary output, secure session cookies and rejects cross-site writes',async()=>{
 mkdirSync('.data/tests',{recursive:true});const store=openStore(mkdtempSync(resolve('.data/tests/bridge-')));seedTenant(store);ensureKeys(store);
 const current=await startRuntime(store),context={ip:'198.51.100.2'};
 try{
  const setup=await forwardRequest(new Request('http://localhost/api/setup',{method:'POST',headers:{'X-Promote-Request':'1','Content-Type':'application/json'},body:JSON.stringify({name:'Cloud Test Owner',email:'bridge@test.example',password:'A-very-strong-bridge-password'})}),context,current);
  assert.equal(setup.status,201);const cookie=setup.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);
  const me=await forwardRequest(new Request('http://localhost/api/auth/me',{headers:{Cookie:cookie.split(';')[0]}}),context,current);assert.equal((await me.json()).user.email,'bridge@test.example');
  const icon=await forwardRequest(new Request('http://localhost/api/brand/mchenry/icon.png'),context,current);assert.equal(icon.status,200);assert.equal(Buffer.from(await icon.arrayBuffer()).subarray(1,4).toString(),'PNG');
  const denied=await forwardRequest(new Request('http://localhost/api/auth/login',{method:'POST',headers:{'X-Promote-Request':'1','Content-Type':'application/json',Origin:'https://other.example'},body:JSON.stringify({email:'bridge@test.example',password:'A-very-strong-bridge-password'})}),context,current);assert.equal(denied.status,403);
 }finally{await current.stop();}
});
test('Cloud uploads enforce authentication, single-use staging, quotas and private screenshot delivery',async()=>{
 mkdirSync('.data/tests',{recursive:true});const store=openStore(mkdtempSync(resolve('.data/tests/cloud-')));
 store.db.exec('CREATE TABLE file_objects(path TEXT PRIMARY KEY,tenant_id TEXT,bucket TEXT,mime TEXT,size INTEGER,created_at TEXT); CREATE TABLE upload_intents(id TEXT PRIMARY KEY,tenant_id TEXT,target TEXT,owner TEXT,doc TEXT,state TEXT,reserved INTEGER,expires_at TEXT,cleanup_at TEXT);');
 const objects=new Map();store.cloud=true;store.requestContext=new AsyncLocalStorage();store.rpc=(method,args)=>{
  const key=args.bucket+'/'+args.path;
  if(method==='storage.upload')return 'https://cloud-test.supabase.co/storage/v1/object/upload/sign/'+key+'?token=isolated-test';
  if(method==='storage.put'){objects.set(key,Buffer.from(args.bytes,'base64'));return true;}
  if(method==='storage.get'){assert.ok(objects.has(key));return objects.get(key).toString('base64');}
  if(method==='storage.remove'){objects.delete(key);return true;}
  if(method==='storage.sign')return 'https://cloud-test.supabase.co/storage/v1/object/sign/'+key+'?token=private-test';
  throw Error('Unexpected storage method');
 };
 const previous=process.env.SUPABASE_URL;process.env.SUPABASE_URL='https://cloud-test.supabase.co';
 const runtime=createApp({store,scheduler:false}),server=runtime.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const origin='http://127.0.0.1:'+server.address().port;
 let cookie='';
 const request=async(path,{method='GET',body,headers={},authenticated=true}={})=>{
  const res=await fetch(origin+path,{method,redirect:'manual',headers:{'X-Promote-Request':'1',...(body?{'Content-Type':'application/json'}:{}),...(authenticated&&cookie?{Cookie:cookie}:{}),...headers},body:body?JSON.stringify(body):undefined});let data;try{data=await res.clone().json();}catch{}return {res,data};
 };
 try{
  const setup=await request('/api/setup',{method:'POST',body:{name:'Cloud Test Owner',email:'cloud@test.example',password:'A-strong-cloud-test-password'}});assert.equal(setup.res.status,201);cookie=setup.res.headers.get('set-cookie').split(';')[0];
  const bytes=await sharp({create:{width:40,height:40,channels:3,background:'#804c85'}}).png().toBuffer();
  const fields={target:'/api/business/mchenry/assets',name:'profile.png',mime:'image/png',size:bytes.length};
  assert.equal((await request('/api/uploads/start',{method:'POST',body:fields,authenticated:false})).res.status,401);
  const intent=await request('/api/uploads/start',{method:'POST',body:fields});assert.equal(intent.res.status,200,JSON.stringify(intent.data));const row=store.get('SELECT * FROM upload_intents WHERE id=?',intent.data.id),doc=JSON.parse(row.doc);objects.set(doc.bucket+'/'+doc.path,bytes);
  const saved=await request(fields.target,{method:'POST',body:{uploadIntent:row.id}});assert.equal(saved.res.status,201,JSON.stringify(saved.data));assert.equal(objects.get(doc.bucket+'/'+doc.path).length,0);
  assert.equal((await request(fields.target,{method:'POST',body:{uploadIntent:row.id}})).res.status,409);
  const media=await request(saved.data.url,{authenticated:false});assert.equal(media.res.status,302);assert.match(media.res.headers.get('location'),/object\/public\/tg-public/);
  const limit=process.env.MEDIA_BUSINESS_BYTES;process.env.MEDIA_BUSINESS_BYTES='1';assert.equal((await request('/api/uploads/start',{method:'POST',body:fields})).res.status,413);if(limit===undefined)delete process.env.MEDIA_BUSINESS_BYTES;else process.env.MEDIA_BUSINESS_BYTES=limit;
  const t=readTenant(store,'mchenry');t.paymentAccounts=[{currency:'NGN',holder:'Test Owner',number:'1234567890'}];saveTenant(store,t);
  store.run('INSERT INTO bookings VALUES(?,?,?,?,?,?,?,?)','b_cloud',t.id,hash('cloud-guest-token'),'awaiting_payment',now(),new Date(Date.now()+3600000).toISOString(),json({amount:100,currency:'NGN',name:'Client',payBy:new Date(Date.now()+3600000).toISOString()}),now());
  const target='/api/guest/bookings/b_cloud/proof',headers={Authorization:'Bearer cloud-guest-token'};
  const proofIntent=await request('/api/uploads/start',{method:'POST',authenticated:false,headers,body:{...fields,target}});
  assert.equal(proofIntent.res.status,200,JSON.stringify(proofIntent.data));
  const proofDoc=JSON.parse(store.get('SELECT doc FROM upload_intents WHERE id=?',proofIntent.data.id).doc);objects.set(proofDoc.bucket+'/'+proofDoc.path,bytes);
  const proof=await request(target,{method:'POST',authenticated:false,headers,body:{uploadIntent:proofIntent.data.id,amount:100,currency:'NGN',reference:'Cloud transfer'}});
  assert.equal(proof.res.status,201,JSON.stringify(proof.data));
  const privateFile=store.get('SELECT * FROM proofs WHERE id=?',proof.data.id);assert.equal(store.get('SELECT bucket FROM file_objects WHERE path=?',privateFile.path).bucket,'tg-private');
  assert.equal((await request('/media/uploads/'+privateFile.path,{authenticated:false})).res.status,404);
  assert.equal((await request('/api/proofs/'+proof.data.id+'/image',{authenticated:false})).res.status,401);
  const permitted=await request('/api/proofs/'+proof.data.id+'/image');assert.equal(permitted.res.status,302);assert.match(permitted.res.headers.get('location'),/object\/sign\/tg-private/);assert.match(permitted.res.headers.get('cache-control'),/private,no-store/);
  t.appIcon='/media/uploads/'+privateFile.path;saveTenant(store,t);assert.equal((await request('/api/brand/mchenry/icon.png',{authenticated:false})).res.status,404);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));runtime.close();if(previous===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=previous;}
});

test('Direct upload keeps guest credentials off the storage host and preserves payment fields',async()=>{
 const body=new FormData();body.append('proof',new File(['sample'],'proof.png',{type:'image/png'}));body.append('reference','Transfer ref');body.append('amount','100');
 const original=globalThis.fetch,requests=[];
 globalThis.fetch=async(url,options)=>{assert.equal(new URL(url).hostname,'test.supabase.co');assert.equal(options.credentials,'omit');assert.equal(options.headers.Authorization,undefined);assert.equal(options.method,'PUT');return new Response('{}',{status:200});};
 try{
  const headers={Authorization:'Bearer private-guest-link'};
  const api=async(path,options)=>{requests.push({path,options});return path==='/api/uploads/start'?{id:'up_abcdefabcdefabcdefabcdef',uploadUrl:'https://test.supabase.co/storage/v1/object/upload/sign/test?token=one-file'}:{ok:true};};
  const result=await uploadCloudForm('/api/guest/bookings/example/proof',{method:'POST',headers,body},api);assert.equal(result.ok,true);assert.equal(requests[0].options.headers,headers);assert.equal(requests[1].options.headers,headers);assert.equal(requests[1].options.body.reference,'Transfer ref');assert.equal(requests[1].options.body.amount,'100');assert.equal(requests[1].options.body.uploadIntent,'up_abcdefabcdefabcdefabcdef');
 }finally{globalThis.fetch=original;}
});
