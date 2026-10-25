import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {createApp} from '../server/index.mjs';
import {netlifyProxyPolicy} from '../server/netlify-proxy.mjs';
import {configureBackend} from '../netlify/plugins/backend/configuration.mjs';

const secret='an-isolated-test-signing-key-of-at-least-32-characters',siteId='test-netlify-site',publicOrigin='https://promote-test.netlify.app';
const token=(claims={},algorithm='HS256')=>{
  const header=Buffer.from(JSON.stringify({alg:algorithm,typ:'JWT'})).toString('base64url'),payload=Buffer.from(JSON.stringify({iss:'netlify',netlify_id:siteId,site_url:publicOrigin,exp:Math.floor(Date.now()/1000)+120,...claims})).toString('base64url');
  return header+'.'+payload+'.'+createHmac('sha256',secret).update(header+'.'+payload).digest('base64url');
};
test('Netlify builds require a persistent backend and signed proxy configuration',()=>{
  assert.throws(()=>configureBackend({},{}),/PROMOTE_BACKEND_URL/);
  for(const url of ['http://backend.example','https://localhost','https://backend.example/path','https://backend.example/?key=private','https://user:pass@backend.example','https://another-site.netlify.app'])assert.throws(()=>configureBackend({},{PROMOTE_BACKEND_URL:url,PROMOTE_PROXY_SECRET:secret}));
  assert.throws(()=>configureBackend({},{PROMOTE_BACKEND_URL:'https://backend.example',PROMOTE_PROXY_SECRET:'short'}),/32/);
  assert.throws(()=>configureBackend({},{PROMOTE_BACKEND_URL:'https://backend.example',PROMOTE_PROXY_SECRET:secret,CONTEXT:'deploy-preview'}),/staging/);
  const config={redirects:[{from:'/*',to:'/index.html',status:200}]};configureBackend(config,{PROMOTE_BACKEND_URL:'https://backend.example',PROMOTE_PROXY_SECRET:secret,CONTEXT:'production'});
  assert.deepEqual(config.redirects.map(r=>r.from),['/api/*','/media/uploads/*','/*']);assert.equal(config.redirects[0].signed,'PROMOTE_PROXY_SECRET');assert.equal(config.redirects[0].to,'https://backend.example/api/:splat');assert.equal(JSON.stringify(config).includes(secret),false);
  assert.throws(()=>netlifyProxyPolicy({PROMOTE_PROXY_SECRET:secret}),/NETLIFY_SITE_ID/);
});
test('Production requests through Netlify preserve login, tenant identity and private access',async t=>{
  const values={NODE_ENV:'production',APP_URL:publicOrigin,BASE_DOMAIN:'promote-test.netlify.app',TENANT_ROUTING:'path',PROMOTE_PROXY_SECRET:secret,NETLIFY_SITE_ID:siteId},previous=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));Object.assign(process.env,values);
  mkdirSync('.data/tests',{recursive:true});const dataDir=mkdtempSync(resolve('.data/tests/hosting-')),runtime=createApp({dataDir,scheduler:false}),server=runtime.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const request=(path,{method='GET',body,headers={},signed=true,cookie=''}={})=>new Promise((resolve,reject)=>{const outgoing=httpRequest(origin+path,{method,headers:{Host:'backend.example','X-Promote-Request':'1',...(signed?{'x-nf-sign':token(),'x-forwarded-host':'promote-test.netlify.app'}:{}),...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json',Origin:publicOrigin}:{}),...headers}},response=>{let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);response.on('end',()=>{try{resolve({status:response.statusCode,data:JSON.parse(text),headers:new Headers(Object.entries(response.headers).map(([key,value])=>[key,Array.isArray(value)?value.join(', '):String(value)]))});}catch(error){reject(error);}});});outgoing.on('error',reject);outgoing.end(body?JSON.stringify(body):undefined);});
  let cookie;
  try{
    await t.test('health checks work while untrusted backend host forwarding is rejected',async()=>{
      assert.equal((await request('/api/health',{signed:false})).status,200);
      assert.equal((await request('/api/bootstrap',{signed:false,headers:{'x-forwarded-host':'promote-test.netlify.app'}})).status,404);
      const r=await request('/api/bootstrap');assert.equal(r.status,200);assert.equal(r.data.tenantRouting,'path');assert.equal(r.data.requireTenantHost,false);
      assert.equal((await request('/api/public/mchenry')).status,200);
    });
    await t.test('forged, expired, cross-project and cross-site signatures are rejected',async()=>{
      for(const signature of ['forged',token({exp:1}),token({netlify_id:'other-site'}),token({site_url:'https://another.netlify.app'}),token({},'none')])assert.equal((await request('/api/bootstrap',{headers:{'x-nf-sign':signature}})).status,403);
      assert.equal((await request('/api/bootstrap',{headers:{'x-forwarded-host':'unconnected.example'}})).status,404);
    });
    await t.test('administrator setup creates a secure session through the public origin',async()=>{
      const code=readFileSync(join(dataDir,'bootstrap-code.txt'),'utf8');
      const r=await request('/api/setup',{method:'POST',body:{name:'Hosting Test Admin',email:'hosting@test.example',password:'A-strong-hosting-test-password',code}});assert.equal(r.status,201,JSON.stringify(r.data));
      const setCookie=r.headers.get('set-cookie');assert.match(setCookie,/HttpOnly/i);assert.match(setCookie,/Secure/i);assert.match(setCookie,/SameSite=Lax/i);cookie=setCookie.split(';')[0];
      const me=await request('/api/auth/me',{cookie});assert.equal(me.data.user.email,'hosting@test.example');
      assert.equal((await request('/api/business/mchenry/dashboard',{cookie})).status,200);
      assert.equal((await request('/api/business/mchenry/dashboard')).status,401);
    });
    await t.test('cross-origin writes remain blocked behind the signed proxy',async()=>{
      const r=await request('/api/auth/login',{method:'POST',body:{email:'hosting@test.example',password:'A-strong-hosting-test-password'},headers:{Origin:'https://unrelated.example'}});assert.equal(r.status,403);
    });
    await t.test('path-mode PWA identity and future tenant host boundaries remain valid',async()=>{
      const r=await request('/api/brand/mchenry/manifest.webmanifest');assert.equal(r.data.start_url,'/p/mchenry');assert.equal(r.data.name,'MC Henry');
      const other=await request('/api/register',{method:'POST',body:{name:'Other Owner',email:'other-hosting@test.example',password:'A-strong-hosting-test-password',businessName:'Other Host',slug:'otherhost',professions:['dj']}});assert.equal(other.status,201);
      const profile=await request('/api/public/mchenry',{headers:{'x-forwarded-host':'mchenry.promote-test.netlify.app'}});assert.equal(profile.status,200);
      const wrongTenant=await request('/api/public/otherhost',{headers:{'x-forwarded-host':'mchenry.promote-test.netlify.app'}});assert.equal(wrongTenant.status,404);
    });
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));runtime.close();for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
