import {applyCloudEnvironment} from '../../server/cloud-environment.mjs';
import {createServer,request as httpRequest} from 'node:http';
import {createApp} from '../../server/index.mjs';
import {openCloudStore} from '../../server/cloud-store.mjs';
import {finishMediaImport} from '../../server/storage.mjs';
let booting;
export async function startRuntime(store,options={}){
 const runtime=createApp({...options,store,seed:false,scheduler:false});
 const server=createServer(runtime.app);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});server.unref();
 return {...runtime,origin:'http://127.0.0.1:'+server.address().port,stop:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));runtime.close();}};
}
async function runtime(){
 if(!booting)booting=(async()=>{const store=openCloudStore();try{
  if(!store.get("SELECT id FROM users WHERE role='admin'"))throw Object.assign(new Error('Import the existing business database before publishing.'),{code:'CLOUD_DATABASE_NOT_IMPORTED'});
  finishMediaImport(store);return await startRuntime(store);
 }catch(error){store.db.close();throw error;}})().catch(error=>{booting=null;throw error;});
 const current=await booting;if(!current.store.db.healthy){booting=null;return runtime();}return current;
}
export async function forwardRequest(request,context,current){
 const url=new URL(request.url),headers=new Headers(request.headers),target=new URL(current.origin);
 for(const key of ['connection','transfer-encoding','keep-alive','content-length','expect','upgrade','te','trailer','x-nf-sign','x-forwarded-host','x-forwarded-for','x-forwarded-proto'])headers.delete(key);
 headers.set('host',url.host);headers.set('x-forwarded-for',context.ip||'127.0.0.1');headers.set('x-forwarded-proto',url.protocol.slice(0,-1));
 const body=['GET','HEAD'].includes(request.method)?null:Buffer.from(await request.arrayBuffer());
 if(body)headers.set('content-length',String(body.length));
 // Node 24 fetch rewrites Host for loopback requests. The native HTTP client
 // preserves the verified public host for tenant routing and same-origin checks.
 return new Promise((resolve,reject)=>{
  const proxy=httpRequest({hostname:target.hostname,port:target.port,path:url.pathname+url.search,method:request.method,headers:Object.fromEntries(headers),signal:AbortSignal.timeout(45000)},incoming=>{
   const chunks=[];incoming.on('error',reject);incoming.on('data',chunk=>chunks.push(chunk));incoming.on('end',()=>{
    try{
     const outgoing=new Headers();
     for(let i=0;i<incoming.rawHeaders.length;i+=2){const name=incoming.rawHeaders[i];if(!['connection','transfer-encoding','keep-alive'].includes(name.toLowerCase()))outgoing.append(name,incoming.rawHeaders[i+1]);}
     const status=incoming.statusCode||502,payload=request.method==='HEAD'||[204,205,304].includes(status)?null:Buffer.concat(chunks);
     resolve(new Response(payload,{status,headers:outgoing}));
    }catch(error){reject(error);}
   });
  });proxy.on('error',reject);proxy.end(body);
 });
}
export default async (request,context)=>{
 applyCloudEnvironment();
 try{
  const current=await runtime(),response=await forwardRequest(request,context,current);
  if(!['GET','HEAD'].includes(request.method))context.waitUntil(current.flushPush({deadline:Date.now()+18000}));
  return response;
 }catch(error){console.error('[api]',error.code||'REQUEST_FAILED');return Response.json({error:'The application could not complete this request. Please try again.'},{status:503,headers:{'Cache-Control':'no-store'}});}
};
export const config={path:['/api/*','/media/uploads/*']};
