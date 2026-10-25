import {z} from 'zod';
import {fail,hash,uid,now,json,parse} from './core.mjs';
import {requireModule} from './professional-data.mjs';
const MB=1024*1024,stageCaps={image:8*MB,photo:20*MB,audio:25*MB,video:40*MB};
const bodySchema=z.object({target:z.string().max(250),name:z.string().min(1).max(180),mime:z.enum(['image/jpeg','image/png','image/webp','video/mp4','video/webm','audio/mpeg','audio/mp4','audio/x-m4a','audio/ogg','audio/wav','audio/x-wav']),size:z.number().int().min(1).max(40*MB)});
export function cloudUploadTools(ctx){
 const {store,access,feature,tenant,limited}=ctx;
 const owner=req=>req.user?'user:'+req.user.id:'guest:'+hash(req.get('Authorization')||'');
 function scope(req,target,mime){
  const business=/^\/api\/business\/([a-z][a-z0-9-]{2,35})\/(assets|sponsor-assets|professional-assets|delivery-assets|invoices\/([a-zA-Z0-9_-]+)\/proof)$/.exec(target);
  const guest=/^\/api\/guest\/(bookings|orders)\/([a-zA-Z0-9_-]+)\/proof$/.exec(target);
  let t,kind='image';
  if(business){
   const [,slug,type,invoiceId]=business;
   if(invoiceId){
    const result=access(req,slug,null,null,true);t=result.t;fail(['owner','admin'].includes(result.m.role),403,'Only the owner can pay platform invoices.');
    const invoice=store.get('SELECT status FROM invoices WHERE id=? AND tenant_id=?',invoiceId,t.id);fail(invoice&&['unpaid','rejected'].includes(invoice.status),409,'This invoice is not awaiting payment.');
   }else{
    t=access(req,slug,type==='delivery-assets'?'deliveries':'content').t;
    if(type==='delivery-assets'){feature(t,'clientDelivery');requireModule(store,t,'deliveries');kind=mime.startsWith('image/')?'photo':'video';}
    else if(type==='sponsor-assets'){feature(t,'sponsors');kind=mime.startsWith('image/')?'image':'video';}
    else if(type==='professional-assets'){fail(t.features.showcase||t.features.music,403,'Professional media is not enabled.');kind=mime.startsWith('audio/')?'audio':mime.startsWith('video/')?'video':'image';if(kind==='audio'){feature(t,'music');requireModule(store,t,'audio');}if(kind==='video')feature(t,'showcase');}
   }
  }else if(guest){
   const row=store.get('SELECT * FROM '+guest[1]+' WHERE id=?',guest[2]),bearer=req.get('Authorization')?.replace(/^Bearer /,'')||'';
   fail(row&&bearer&&row.token===hash(bearer),404,'This payment link is invalid.');t=tenant(req,row.tenant_id);fail(row.status==='awaiting_payment',409,'Payment is not currently due.');
  }else fail(false,404,'This upload destination is unavailable.');
  fail((['image','photo'].includes(kind)&&mime.startsWith('image/'))||(kind==='video'&&mime.startsWith('video/'))||(kind==='audio'&&mime.startsWith('audio/')),400,'Choose the correct file type.');
  return {t,kind,field:business&&!business[3]&&business[2]!=='assets'?'media':business?.[2]==='assets'?'image':'proof'};
 }
 const tombstone=doc=>store.rpc('storage.put',{bucket:doc.bucket,path:doc.path,bytes:'',mime:doc.mime,upsert:true});
 function start(req,res){
  limited(req,'cloud-upload',40);const input=bodySchema.parse(req.body),{t,kind,field}=scope(req,input.target,input.mime),cap=stageCaps[kind];fail(input.size<=cap,413,'This file exceeds the upload limit.');
  const output=['image','photo'].includes(kind)?input.size+24*MB:input.size,reserved=cap+output,id=uid('up_'),path=id+'.bin';
  const doc={...input,field,bucket:'tg-stage-'+kind,path,output};
  store.tx(()=>{
   const global=Number(store.get('SELECT COALESCE(SUM(size),0) AS n FROM file_objects').n)+Number(store.get('SELECT COALESCE(SUM(reserved),0) AS n FROM upload_intents').n);
   const business=Number(store.get('SELECT COALESCE(SUM(size),0) AS n FROM file_objects WHERE tenant_id=?',t.id).n)+Number(store.get('SELECT COALESCE(SUM(reserved),0) AS n FROM upload_intents WHERE tenant_id=?',t.id).n);
   const projectLimit=Number(process.env.MEDIA_PROJECT_BYTES||800*MB),available=field==='proof'?projectLimit:Math.max(0,projectLimit-64*MB);
   fail(global+reserved<=available,413,'Project storage is full. Contact Techverse for storage help.');
   fail(field==='proof'||business+reserved<=Number(process.env.MEDIA_BUSINESS_BYTES||200*MB),413,'This business has reached its media allowance. Contact Techverse for storage help.');
   store.run('INSERT INTO upload_intents VALUES(?,?,?,?,?,?,?,?,?)',id,t.id,input.target,owner(req),json(doc),'pending',reserved,new Date(Date.now()+20*60000).toISOString(),new Date(Date.now()+125*60000).toISOString());
  });
  try{res.json({id,uploadUrl:store.rpc('storage.upload',{bucket:doc.bucket,path})});}catch(error){store.run('DELETE FROM upload_intents WHERE id=?',id);throw error;}
 }
 const wrap=multer=>({single:field=>(req,res,next)=>{
  if(!store.cloud)return multer.single(field)(req,res,next);
  try{
   const id=z.string().regex(/^up_[a-f0-9]{24}$/).parse(req.body?.uploadIntent);
   let doc;
   store.tx(()=>{
    const row=store.get('SELECT * FROM upload_intents WHERE id=?',id);fail(row&&row.owner===owner(req)&&row.target===req.path&&row.state==='pending'&&row.expires_at>now(),409,'This upload has expired or is already used. Select the file again.');
    doc=parse(row.doc);const current=scope(req,row.target,doc.mime);fail(doc.field===field&&current.t.id===row.tenant_id,403,'Upload access has changed.');
    store.run("UPDATE upload_intents SET state='processing' WHERE id=?",id);
   });
   let wiped=false;
   try{
    const buffer=Buffer.from(store.rpc('storage.get',{bucket:doc.bucket,path:doc.path}),'base64');
    fail(buffer.length===doc.size,400,'The uploaded file size changed. Select it again.');
    tombstone(doc);wiped=true;store.run('UPDATE upload_intents SET reserved=? WHERE id=?',doc.output,id);
    req.file={fieldname:field,originalname:doc.name,mimetype:doc.mime,size:buffer.length,buffer};
    store.requestContext.getStore().uploadIntent=id;
    const finish=()=>{res.off('close',finish);res.off('finish',finish);store.run("UPDATE upload_intents SET state='done',reserved=0 WHERE id=?",id);};
    res.on('finish',finish);res.on('close',finish);next();
   }catch(error){
    if(!wiped)try{tombstone(doc);wiped=true;}catch{}
    store.run("UPDATE upload_intents SET state='failed',reserved=? WHERE id=?",wiped?0:stageCaps[doc.bucket.slice(9)],id);throw error;
   }
  }catch(error){next(error);}
 }});
 function cleanup(){
  for(const row of store.all('SELECT id,doc FROM upload_intents WHERE cleanup_at<? LIMIT 50',now())){
   const doc=parse(row.doc);store.rpc('storage.remove',{bucket:doc.bucket,path:doc.path});store.run('DELETE FROM upload_intents WHERE id=?',row.id);
  }
 }
 return {start,wrap,cleanup};
}
