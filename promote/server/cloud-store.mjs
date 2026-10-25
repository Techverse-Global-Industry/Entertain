import 'pg'; // Trace the worker driver into the function bundle.
import {Worker} from 'node:worker_threads';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import {uid,json,parse,now,AppError} from './core.mjs';
// One invocation per Netlify instance. Run async Postgres I/O in a worker to
// preserve the established synchronous, atomic booking/payment transactions.
export function openCloudStore(env=process.env){
 if(!env.DATABASE_URL||!(env.SUPABASE_URL||env.SUPABASE_DATABASE_URL)||!env.SUPABASE_SERVICE_ROLE_KEY)throw Object.assign(new Error('Missing database or Supabase Functions configuration.'),{code:'CLOUD_CONFIG_MISSING'});
 const task=env.LAMBDA_TASK_ROOT||process.cwd(),candidates=[new URL('./cloud-worker.mjs',import.meta.url),resolve(process.cwd(),'server/cloud-worker.mjs'),resolve(process.cwd(),'promote/server/cloud-worker.mjs'),resolve(task,'server/cloud-worker.mjs'),resolve(task,'promote/server/cloud-worker.mjs'),new URL('../../server/cloud-worker.mjs',import.meta.url)];
 const filename=candidates.find(path=>existsSync(path));
 if(!filename){console.error('[cloud-startup]',JSON.stringify({cwd:process.cwd(),module:import.meta.url,candidates:candidates.map(String)}));throw Object.assign(new Error('Database worker is missing from the function bundle.'),{code:'CLOUD_WORKER_MISSING'});}
 let broken=false,inTransaction=false;
 const worker=new Worker(filename,{env:{...process.env,...env}});worker.unref();worker.on('error',error=>{broken=true;console.error('[cloud-worker]',error.code||error.name);});
 const response=new SharedArrayBuffer(64*1024*1024+8),control=new Int32Array(response,0,2),bytes=new Uint8Array(response,8);
 function rpc(method,args={}){
  if(broken)throw new AppError(503,'The connection needs to restart. Please try again.');
  Atomics.store(control,0,0);worker.postMessage({method,args,response});
  if(Atomics.wait(control,0,0,25000)==='timed-out'){broken=true;void worker.terminate();throw Object.assign(new AppError(503,'The server took too long. Please try again.'),{code:'CLOUD_TIMEOUT'});}
  const data=JSON.parse(Buffer.from(bytes.subarray(0,Atomics.load(control,1))).toString('utf8'));
  if(data.error)throw Object.assign(new AppError(data.error.code==='23505'?409:503,data.error.message),{code:data.error.code});
  return data.value;
 }
 const get=(sql,...values)=>rpc('get',{sql,values}),all=(sql,...values)=>rpc('all',{sql,values}),run=(sql,...values)=>rpc('run',{sql,values});
 const tx=fn=>{
  if(inTransaction)return fn();rpc('begin');inTransaction=true;
  try{const value=fn();if(value?.then)throw new Error('Transaction callbacks must be synchronous.');rpc('commit');return value;}
  catch(error){try{rpc('rollback');}catch{}throw error;}finally{inTransaction=false;}
 };
 const store={cloud:true,dir:'/tmp/tg-entertainment',requestContext:new AsyncLocalStorage(),rpc,get,all,run,tx,
  db:{close:()=>{try{rpc('close');}finally{void worker.terminate();}},get healthy(){return !broken;}},
  setting:(key,fallback=null)=>{const row=get('SELECT value FROM settings WHERE key=?',key);return row?parse(row.value):fallback;},
  setSetting:(key,value)=>run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,json(value)),
  audit:(tenant,user,action,detail={})=>run('INSERT INTO activity VALUES(?,?,?,?,?,?)',uid('a_'),tenant||null,user||null,action,json(detail),now())};
 try{rpc('ping');}catch(error){void worker.terminate();throw error;}return store;
}
