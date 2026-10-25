import {parentPort} from 'node:worker_threads';
import pg from 'pg';
import {postgresSql} from './postgres-sql.mjs';
pg.types.setTypeParser(20,value=>{const n=Number(value);if(!Number.isSafeInteger(n))throw new Error('Integer out of range.');return n;});
let client,transaction=false;
async function database(){
 if(client)return client;
 const url=new URL(process.env.DATABASE_URL);for(const name of ['sslmode','sslcert','sslkey','sslrootcert'])url.searchParams.delete(name);
 const connection=new pg.Client({connectionString:url.toString(),ssl:{rejectUnauthorized:true,...(process.env.DATABASE_SSL_CA?{ca:process.env.DATABASE_SSL_CA}:{})},connectionTimeoutMillis:8000,query_timeout:12000,statement_timeout:10000,idle_in_transaction_session_timeout:20000,application_name:'tg-entertainment'});
 connection.on('error',()=>{client=null;});await connection.connect();client=connection;return client;
}
async function media(method,args){
 const bucket=args.bucket;if(!/^(tg-public|tg-private|tg-stage-(image|photo|audio|video))$/.test(bucket))throw new Error('Invalid bucket.');
 const origin=process.env.SUPABASE_URL||process.env.SUPABASE_DATABASE_URL,root=new URL('/storage/v1/',origin),key=process.env.SUPABASE_SERVICE_ROLE_KEY,headers={apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:'Bearer '+key})};
 const target=encodeURIComponent(bucket)+'/'+encodeURIComponent(args.path);let route,verb='GET',body;
 if(method==='storage.put'){route='object/'+target;verb='POST';body=Buffer.from(args.bytes,'base64');headers['content-type']=args.mime;headers['cache-control']=bucket==='tg-public'?'max-age=31536000':'max-age=0';headers['x-upsert']=String(!!args.upsert);}
 else if(method==='storage.get')route='object/authenticated/'+target;
 else if(method==='storage.remove'){route='object/'+encodeURIComponent(bucket);verb='DELETE';body=JSON.stringify({prefixes:[args.path]});}
 else if(method==='storage.sign'){route='object/sign/'+target;verb='POST';body=JSON.stringify({expiresIn:60});}
 else if(method==='storage.upload'){route='object/upload/sign/'+target;verb='POST';body='{}';}
 else throw new Error('Unsupported storage operation.');
 if(typeof body==='string')headers['content-type']='application/json';
 const response=await fetch(new URL(route,root),{method:verb,headers,body,signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw Object.assign(new Error('Storage request failed.'),{code:String(response.status)});
 if(method==='storage.get'){if(Number(response.headers.get('content-length'))>40*1024*1024)throw new Error('File too large.');const buffer=Buffer.from(await response.arrayBuffer());if(buffer.length>40*1024*1024)throw new Error('File too large.');return buffer.toString('base64');}
 if(method==='storage.sign'||method==='storage.upload'){const data=await response.json(),url=new URL('/storage/v1'+(data.signedURL||data.url),origin);if(args.download)url.searchParams.set('download',args.download);return url.toString();}
 return true;
}
async function execute(method,args){
 if(method==='close'){await client?.end();client=null;return true;}
 if(method.startsWith('storage.'))return media(method,args);
 const db=await database();
 if(method==='ping'){await db.query('SELECT 1');return true;}
 if(method==='begin'){await db.query("BEGIN; SET LOCAL statement_timeout='10000'; SELECT pg_advisory_xact_lock(164370021)");transaction=true;return true;}
 if(method==='commit'||method==='rollback'){try{await db.query(method.toUpperCase());}finally{transaction=false;}return true;}
 const sql=postgresSql(args.sql),own=!/^\s*SELECT\b/i.test(sql)&&!transaction;
 try{
  if(own)await db.query("BEGIN; SET LOCAL statement_timeout='10000'; SELECT pg_advisory_xact_lock(164370021)");
  const data=await db.query(sql,args.values);if(own)await db.query('COMMIT');return method==='get'?data.rows[0]:method==='all'?data.rows:{changes:data.rowCount};
 }catch(error){if(own)await db.query('ROLLBACK').catch(()=>{});throw error;}
}
let queue=Promise.resolve();
parentPort.on('message',message=>{queue=queue.then(async()=>{
 const control=new Int32Array(message.response,0,2),output=new Uint8Array(message.response,8);let data;
 try{data={value:await execute(message.method,message.args)};}catch(error){data={error:{message:error.code==='23505'?'A record with these details already exists.':'Cloud storage could not complete this request.',code:error.code||'CLOUD_IO'}};}
 let bytes=Buffer.from(JSON.stringify(data));if(bytes.length>output.length)bytes=Buffer.from(JSON.stringify({error:{message:'This response is too large. Narrow your selection.',code:'RESULT_TOO_LARGE'}}));
 output.set(bytes);Atomics.store(control,1,bytes.length);Atomics.store(control,0,1);Atomics.notify(control,0);
}).catch(()=>{});});
