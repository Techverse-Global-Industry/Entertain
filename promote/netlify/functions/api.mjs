import {applyCloudEnvironment} from '../../server/cloud-environment.mjs';
import {createServer} from 'node:http';
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
 const url=new URL(request.url),headers=new Headers(request.headers);
 for(const key of ['connection','transfer-encoding','x-nf-sign','x-forwarded-host','x-forwarded-for'])headers.delete(key);
 headers.set('host',url.host);headers.set('x-forwarded-for',context.ip||'127.0.0.1');
 const response=await fetch(current.origin+url.pathname+url.search,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer(),redirect:'manual',signal:AbortSignal.timeout(45000)});
 const outgoing=new Headers(response.headers);for(const key of ['connection','transfer-encoding','keep-alive'])outgoing.delete(key);
 // Preserve multiple secure session/delivery cookies independently.
 outgoing.delete('set-cookie');for(const cookie of response.headers.getSetCookie())outgoing.append('set-cookie',cookie);
 return new Response(response.body,{status:response.status,headers:outgoing});
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
