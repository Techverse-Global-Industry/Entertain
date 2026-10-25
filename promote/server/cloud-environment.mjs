// Read scoped Netlify secrets before starting the existing server and I/O worker.
export function applyCloudEnvironment(){
 const keys=['DATABASE_URL','DATABASE_SSL_CA','SUPABASE_URL','SUPABASE_DATABASE_URL','SUPABASE_SERVICE_ROLE_KEY','APP_URL','BASE_DOMAIN','TENANT_ROUTING','NODE_ENV','TRUST_PROXY','VAPID_SUBJECT','MEDIA_PROJECT_BYTES','MEDIA_BUSINESS_BYTES'];
 for(const key of keys){const value=globalThis.Netlify?.env?.get(key)??process.env[key];if(typeof value==='string')process.env[key]=value;}
}
