import {z} from 'zod';
import {writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {uid,now,json,parse,fail,statusOf,documents} from './core.mjs';
import {validateImage,normalizeImage} from './png.mjs';

const mediaPath=z.string().max(250).regex(/^\/media\/[a-zA-Z0-9/_.-]+$/,'Choose media from your uploads.');
const optionalImage=mediaPath.or(z.literal('')).default('');
const campaignSchema=z.object({brand:z.string().trim().min(2).max(90),title:z.string().trim().min(3).max(120),teaser:z.string().trim().min(3).max(180),description:z.string().max(2500).default(''),cta:z.string().trim().min(2).max(35).default('Explore this brand'),destination:z.string().max(1500).refine(value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password;}catch{return false;}},'Enter a full https:// destination link.'),mediaType:z.enum(['image','video']),mediaUrl:mediaPath,posterUrl:optionalImage,logoUrl:optionalImage,placement:z.enum(['sidecard','banner']).default('sidecard'),active:z.boolean().default(false),autoplay:z.boolean().default(true),allowSound:z.boolean().default(true),startsAt:z.iso.datetime().or(z.literal('')).default(''),endsAt:z.iso.datetime().or(z.literal('')).default(''),priority:z.number().int().min(0).max(99).default(0)}).refine(v=>!v.startsAt||!v.endsAt||v.endsAt>v.startsAt,'The end date must follow the start date.');
export function activeCampaigns(store,t){if(!t.published||!t.features.sponsors||statusOf(store,t)!=='active')return [];const timestamp=now();return documents(store,'sponsor_campaigns',t.id).filter(c=>c.active&&!c.archived&&(!c.startsAt||c.startsAt<=timestamp)&&(!c.endsAt||c.endsAt>timestamp)).sort((a,b)=>b.priority-a.priority||b.created_at.localeCompare(a.created_at));}
export function validateVideo(file){
  if(!file||file.size>40*1024*1024)return false;const bytes=file.buffer;
  if(file.mimetype==='video/webm')return bytes.length>100&&bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))&&bytes.subarray(0,4096).includes(Buffer.from('webm'))&&bytes.includes(Buffer.from([0x1f,0x43,0xb6,0x75]));
  if(file.mimetype==='video/mp4'){const header=bytes.subarray(0,128);return bytes.length>100&&header.includes(Buffer.from('ftyp'))&&bytes.includes(Buffer.from('moov'))&&bytes.includes(Buffer.from('mdat'))&&bytes.includes(Buffer.from('vide'));}
  return false;
}
function validateAsset(store,tenantId,url,type){
  if(!url)return;
  if(url.startsWith('/media/uploads/')){const row=store.get('SELECT mime FROM assets WHERE path=? AND tenant_id=?',url.split('/').pop(),tenantId);fail(row&&row.mime.startsWith(type+'/'),400,`Choose a ${type} from this business’s uploads.`);}
  else fail(type==='image'&&['/media/henry-soiree.jpeg','/media/henry-rebirth.jpeg','/media/henry-identity.jpeg'].includes(url)&&tenantId==='tn_henry',400,'Choose media owned by this business.');
}
export function sponsorRoutes(app,ctx){
  const {store,auth,access,feature,tenant,notice,limited,mediaUpload}=ctx;
  app.get('/api/public/:slug/sponsors',(req,res)=>{const t=tenant(req,req.params.slug,true);res.json({campaigns:activeCampaigns(store,t)});});
  app.post('/api/business/:slug/sponsor-assets',auth,(req,res,next)=>{const {t}=access(req,req.params.slug,'content');feature(t,'sponsors');limited(req,'sponsor-media',30);next();},mediaUpload.single('media'),async(req,res)=>{
    const {t}=access(req,req.params.slug,'content'),file=req.file;fail(file,400,'Choose an image or video to upload.');
    const id=uid('asset_');let bytes,mime,extension;
    if(file.mimetype.startsWith('image/')){fail(file.size<=8*1024*1024&&await validateImage(file),400,'Use a JPG, PNG or WebP image up to 8 MB.');bytes=await normalizeImage(file.buffer);mime='image/webp';extension='webp';}
    else {fail(validateVideo(file),400,'Use an MP4 or WebM video up to 40 MB.');bytes=file.buffer;mime=file.mimetype;extension=mime==='video/mp4'?'mp4':'webm';}
    const filename=`${id}.${extension}`;writeFileSync(join(store.dir,'uploads',filename),bytes);
    try{store.run('INSERT INTO assets VALUES(?,?,?,?,?)',id,t.id,filename,mime,now());}catch(error){unlinkSync(join(store.dir,'uploads',filename));throw error;}
    res.status(201).json({id,url:`/media/uploads/${filename}`,mime,type:mime.startsWith('video/')?'video':'image'});
  });
  for(const method of ['post','put'])app[method](`/api/business/:slug/sponsors${method==='put'?'/:id':''}`,auth,(req,res)=>{
    const {t}=access(req,req.params.slug,'content');feature(t,'sponsors');const body=campaignSchema.parse(req.body);
    validateAsset(store,t.id,body.mediaUrl,body.mediaType);validateAsset(store,t.id,body.posterUrl,'image');validateAsset(store,t.id,body.logoUrl,'image');
    let id=req.params.id,old;
    if(id){old=store.get('SELECT * FROM sponsor_campaigns WHERE id=? AND tenant_id=?',id,t.id);fail(old,404,'Brand partnership not found.');fail(!parse(old.doc).archived,409,'Restore this partnership before editing it.');store.run('UPDATE sponsor_campaigns SET doc=? WHERE id=?',json({...body,updatedAt:now()}),id);}
    else {id=uid('sp_');store.run('INSERT INTO sponsor_campaigns VALUES(?,?,?,?)',id,t.id,json({...body,updatedAt:now()}),now());}
    store.audit(t.id,req.user.id,old?'sponsor.updated':'sponsor.created',{campaignId:id});notice(t.id,'private','Brand partnership updated','Your website’s partner features have been updated.',`/dashboard/${t.slug}/sponsors`,'content');
    res.status(old?200:201).json({id});
  });
  app.patch('/api/business/:slug/sponsors/:id/state',auth,(req,res)=>{
    const {t}=access(req,req.params.slug,'content');feature(t,'sponsors');const input=z.object({action:z.enum(['enable','pause','archive','restore'])}).parse(req.body),row=store.get('SELECT * FROM sponsor_campaigns WHERE id=? AND tenant_id=?',req.params.id,t.id);fail(row,404,'Brand partnership not found.');const doc=parse(row.doc);
    if(input.action==='enable')fail(!doc.archived,409,'Restore this feature first.');
    if(input.action==='archive')doc.archived=true;if(input.action==='restore')doc.archived=false;doc.active=input.action==='enable';doc.updatedAt=now();store.run('UPDATE sponsor_campaigns SET doc=? WHERE id=?',json(doc),row.id);store.audit(t.id,req.user.id,`sponsor.${input.action}`,{campaignId:row.id});notice(t.id,'private','Brand partnership updated','Partner visibility has changed.',`/dashboard/${t.slug}/sponsors`,'content');res.json({ok:true});
  });
  app.post('/api/public/:slug/sponsors/:id/activity',(req,res)=>{
    limited(req,'sponsor-activity',150);const t=tenant(req,req.params.slug,true);fail(activeCampaigns(store,t).some(c=>c.id===req.params.id),404,'This feature is no longer active.');const input=z.object({device:z.string().regex(/^[a-zA-Z0-9_-]{16,100}$/),kind:z.enum(['view','click'])}).parse(req.body);
    store.run('INSERT OR IGNORE INTO sponsor_activity(campaign_id,tenant_id,device,kind,period,created_at) VALUES(?,?,?,?,?,?)',req.params.id,t.id,input.device,input.kind,now().slice(0,10),now());res.json({ok:true});
  });
}
