import {writeFileSync,readFileSync,unlinkSync,existsSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fail,now} from './core.mjs';
const valid=path=>fail(typeof path==='string'&&/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(path),400,'Invalid media file.');
export function putFile(store,path,buffer,{tenantId,mime='application/octet-stream',private:privateFile=false}={}){
 valid(path);if(!store.cloud){writeFileSync(join(store.dir,'uploads',path),buffer,{mode:privateFile?0o600:0o644});return;}
 const bucket=privateFile?'tg-private':'tg-public',intent=store.requestContext.getStore()?.uploadIntent;
 store.tx(()=>{
  const used=store.get('SELECT COALESCE(SUM(size),0) AS n FROM file_objects').n,reserved=store.get('SELECT COALESCE(SUM(reserved),0) AS n FROM upload_intents').n;
  fail(used+reserved+(intent?0:buffer.length)<=Number(process.env.MEDIA_PROJECT_BYTES||800*1024*1024),413,'Media storage is full. Contact Techverse to free some space.');
  if(intent){const row=store.get('SELECT reserved FROM upload_intents WHERE id=?',intent);fail(row&&row.reserved>=buffer.length,413,'This processed file exceeds its upload allowance.');store.run('UPDATE upload_intents SET reserved=reserved-? WHERE id=?',buffer.length,intent);}
  store.run('INSERT INTO file_objects VALUES(?,?,?,?,?,?)',path,tenantId||null,bucket,mime,buffer.length,now());
 });
 try{store.rpc('storage.put',{bucket,path,bytes:buffer.toString('base64'),mime});}catch(error){store.run('DELETE FROM file_objects WHERE path=?',path);throw error;}
}
export function removeFile(store,path){
 valid(path);if(!store.cloud){unlinkSync(join(store.dir,'uploads',path));return;}
 const file=store.get('SELECT bucket FROM file_objects WHERE path=?',path);if(!file)return;store.rpc('storage.remove',{bucket:file.bucket,path});store.run('DELETE FROM file_objects WHERE path=?',path);
}
export function fileInfo(store,path){
 valid(path);if(store.cloud)return store.get('SELECT size,mime,bucket FROM file_objects WHERE path=?',path);
 const location=join(store.dir,'uploads',path);return existsSync(location)?{size:statSync(location).size}:null;
}
export function readFile(store,path){
 valid(path);if(!store.cloud)return readFileSync(join(store.dir,'uploads',path));const file=fileInfo(store,path);fail(file,404,'Media not found.');return Buffer.from(store.rpc('storage.get',{bucket:file.bucket,path}),'base64');
}
export function sendFile(store,res,path,{public:publicFile=false,download}={}){
 valid(path);if(!store.cloud)return res.sendFile(path,{root:join(store.dir,'uploads'),dotfiles:'deny'});
 const file=fileInfo(store,path);fail(file&&(!publicFile||file.bucket==='tg-public'),404,'Media not found.');
 if(publicFile){const url=new URL(process.env.SUPABASE_URL||process.env.SUPABASE_DATABASE_URL);return res.redirect(302,url.origin+'/storage/v1/object/public/tg-public/'+path);}
 res.set('Cache-Control','private,no-store');return res.redirect(302,store.rpc('storage.sign',{bucket:file.bucket,path,download}));
}
export function finishMediaImport(store){
 if(!store.cloud)return;
 for(const row of store.all('SELECT path FROM file_imports ORDER BY path')){
  store.tx(()=>{
   const file=store.get('SELECT * FROM file_imports WHERE path=?',row.path);if(!file)return;
   const buffer=Buffer.from(file.body,'base64');fail(createHash('sha256').update(buffer).digest('hex')===file.sha256,500,'Media import checksum failed.');
   store.rpc('storage.put',{bucket:file.bucket,path:file.path,bytes:file.body,mime:file.mime,upsert:true});
   const saved=Buffer.from(store.rpc('storage.get',{bucket:file.bucket,path:file.path}),'base64');
   fail(createHash('sha256').update(saved).digest('hex')===file.sha256,503,'Media import verification failed.');
   store.run('INSERT INTO file_objects VALUES(?,?,?,?,?,?) ON CONFLICT(path) DO NOTHING',file.path,file.tenant_id,file.bucket,file.mime,buffer.length,now());
   store.run('DELETE FROM file_imports WHERE path=?',file.path);
  });
 }
}
