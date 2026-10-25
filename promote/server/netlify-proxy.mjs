import {createHmac,timingSafeEqual} from 'node:crypto';
import {fail} from './core.mjs';

function publicOrigin(value) {
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('APP_URL must be the public HTTPS website origin.');
  return url.origin;
}
function hostInfo(value) {
  fail(typeof value==='string'&&value.length<=255&&!/[\s,@/#?\\]/.test(value),403,'Invalid proxy host.');
  let url;try{url=new URL('https://'+value);}catch{fail(false,403,'Invalid proxy host.');}
  return {host:url.host.toLowerCase(),hostname:url.hostname.toLowerCase()};
}
export function netlifyProxyPolicy(env) {
  const secret=env.PROMOTE_PROXY_SECRET;
  if(!secret)return null;
  if(secret.length<32||!env.NETLIFY_SITE_ID||!env.APP_URL)throw new Error('Netlify proxy requires PROMOTE_PROXY_SECRET (32+ characters), NETLIFY_SITE_ID and APP_URL.');
  return {secret,siteId:env.NETLIFY_SITE_ID,origin:publicOrigin(env.APP_URL)};
}
export function netlifyPublicHost(req,policy) {
  const token=req.get('x-nf-sign');
  if(!token)return null;
  fail(policy&&token.length<8192,403,'Invalid proxy signature.');
  const parts=token.split('.');fail(parts.length===3&&parts.every(part=>/^[A-Za-z0-9_-]+$/.test(part)),403,'Invalid proxy signature.');
  let header,claims;try{header=JSON.parse(Buffer.from(parts[0],'base64url'));claims=JSON.parse(Buffer.from(parts[1],'base64url'));}catch{fail(false,403,'Invalid proxy signature.');}
  fail(header?.alg==='HS256',403,'Invalid proxy signature.');
  const signature=Buffer.from(parts[2],'base64url'),expected=createHmac('sha256',policy.secret).update(parts[0]+'.'+parts[1]).digest();
  fail(signature.length===expected.length&&timingSafeEqual(signature,expected),403,'Invalid proxy signature.');
  fail(claims?.iss==='netlify'&&claims.netlify_id===policy.siteId&&Number.isInteger(claims.exp)&&claims.exp>Math.floor(Date.now()/1000),403,'Expired or untrusted proxy signature.');
  let origin;try{origin=publicOrigin(claims.site_url);}catch{fail(false,403,'Untrusted proxy website.');}
  fail(origin===policy.origin,403,'Untrusted proxy website.');
  // Netlify forwards the original visitor host. Only use it after verifying Netlify's signature.
  const forwarded=req.get('x-forwarded-host');
  return hostInfo(forwarded?forwarded.split(',')[0].trim():new URL(origin).host);
}
