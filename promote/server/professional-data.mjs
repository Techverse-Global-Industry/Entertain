import {professions,featureNames,readTenant,saveTenant,uid,now,json,parse,fail} from './core.mjs';
import {professionalRoles,hasModule,serviceTemplates} from '../shared/professions.mjs';
export const catalogue=store=>store.setting('professions',professions);
export const rolesFor=(store,t)=>professionalRoles(t,catalogue(store));
export const moduleFor=(store,t,module)=>hasModule(t,module,catalogue(store));
export function requireModule(store,t,module){fail(moduleFor(store,t,module),403,'Choose the matching profession in Profile & branding to use this tool.');}
export function ensureProfessionalDefaults(store){for(const row of store.all('SELECT id FROM tenants')){const t=readTenant(store,row.id);t.features||={};let changed=false;for(const key of ['showcase','music','mediaKit','planning','clientDelivery'])if(t.features[key]===undefined){t.features[key]=true;changed=true;}if(changed)saveTenant(store,t);}}
export function addServiceTemplates(store,t,roleIds=t.professions){const existing=new Set(store.all('SELECT doc FROM services WHERE tenant_id=?',t.id).map(row=>parse(row.doc).category));let count=0;for(const template of serviceTemplates(t,catalogue(store))){if(!roleIds.includes(template.category)||existing.has(template.category))continue;const {templateId,...doc}=template;store.run('INSERT INTO services VALUES(?,?,?,?)',uid('svc_'),t.id,json(doc),now());count++;}return count;}
export const studioSettings=(store,tenantId)=>parse(store.get('SELECT doc FROM professional_profiles WHERE tenant_id=?',tenantId)?.doc,{profiles:{},audience:[]});
export function studioRows(store,table,tenantId){fail(['professional_work','music_tracks','event_plans','client_deliveries'].includes(table),500,'Invalid professional collection.');return store.all(`SELECT * FROM ${table} WHERE tenant_id=? ORDER BY created_at DESC`,tenantId).map(row=>{const {token,...safe}=row;return {...parse(row.doc),...safe,doc:undefined};});}
export function publicStudio(store,t){
  const roles=rolesFor(store,t),ids=new Set(t.professions),settings=studioSettings(store,t.id);
  return {roles:roles.map(({id,name,shortName,icon,workTitle,modules,baseId})=>({id,name,shortName,icon,workTitle,modules,baseId})),profiles:t.features.showcase?Object.fromEntries(Object.entries(settings.profiles||{}).filter(([id])=>ids.has(id))):{},audience:t.features.mediaKit&&moduleFor(store,t,'mediaKit')?(settings.audience||[]):[],
    work:t.features.showcase?studioRows(store,'professional_work',t.id).filter(w=>ids.has(w.profession)&&w.published&&!w.archived):[],
    tracks:t.features.music&&moduleFor(store,t,'audio')?studioRows(store,'music_tracks',t.id).filter(track=>ids.has(track.profession)&&track.published&&!track.archived).sort((a,b)=>a.position-b.position||a.created_at.localeCompare(b.created_at)):[]};
}
export function validatePublicAsset(store,t,url,type){
  if(!url)return;
  if(url.startsWith('/media/uploads/')){const row=store.get('SELECT mime FROM assets WHERE path=? AND tenant_id=?',url.split('/').pop(),t.id);fail(row&&row.mime.startsWith(type+'/'),400,`Choose ${type} media uploaded to this business.`);}
  else fail(type==='image'&&t.id==='tn_henry'&&['/media/henry-soiree.jpeg','/media/henry-rebirth.jpeg','/media/henry-identity.jpeg'].includes(url),400,'Choose media uploaded to this business.');
}
