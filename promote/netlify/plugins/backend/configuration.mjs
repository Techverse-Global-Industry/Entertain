export function configureBackend(netlifyConfig, env) {
  if(env.PROMOTE_HOSTING==='supabase'){
    if(env.CONTEXT&&env.CONTEXT!=='production'&&env.CONTEXT!=='dev')throw new Error('Deploy previews need separate Supabase credentials and data. Production database access is disabled for previews.');
    return;
  }
  let backend;
  try { backend = new URL(env.PROMOTE_BACKEND_URL); } catch { throw new Error('Set PROMOTE_BACKEND_URL to the persistent HTTPS backend before deploying.'); }
  if (backend.protocol !== 'https:' || backend.username || backend.password || backend.pathname !== '/' || backend.search || backend.hash || backend.hostname.endsWith('.netlify.app') || ['localhost','127.0.0.1','0.0.0.0','[::1]'].includes(backend.hostname)) throw new Error('PROMOTE_BACKEND_URL must be a public HTTPS server origin, without credentials, a path or query string.');
  if (!env.PROMOTE_PROXY_SECRET || env.PROMOTE_PROXY_SECRET.length < 32) throw new Error('Set PROMOTE_PROXY_SECRET on Netlify and the backend. Use at least 32 random characters and include the Runtime scope on Netlify.');
  if (env.CONTEXT && env.CONTEXT !== 'production' && env.PROMOTE_ALLOW_PREVIEW_BACKEND !== 'true') throw new Error('Preview deployments need a separate staging backend. Set PROMOTE_ALLOW_PREVIEW_BACKEND=true only with staging infrastructure.');
  const origin=backend.origin;
  netlifyConfig.redirects=[
    {from:'/api/*',to:origin+'/api/:splat',status:200,force:true,signed:'PROMOTE_PROXY_SECRET'},
    {from:'/media/uploads/*',to:origin+'/media/uploads/:splat',status:200,force:true,signed:'PROMOTE_PROXY_SECRET'},
    ...(netlifyConfig.redirects||[])
  ];
}

