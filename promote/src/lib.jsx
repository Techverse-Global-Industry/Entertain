import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowUpRight, X, Check, AlertCircle, Loader2, Download, Bell, Radio, ExternalLink, CheckCircle2, ChevronDown, Plus, Camera, Images, Video, Image as ImageIcon, Upload } from 'lucide-react';
import {makeTheme} from '../shared/theme.mjs';

export async function api(path, options = {}) {
  const headers = { 'X-Promote-Request': '1', ...options.headers };
  let body = options.body;
  if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  const response = await fetch(path, { ...options, headers, body, credentials: 'same-origin' });
  let data; try { data = await response.json(); } catch { throw new Error('The server could not be reached. Please try again.'); }
  if (!response.ok) { const error = new Error(data.error || 'Request failed.'); error.status = response.status; error.data = data; throw error; }
  return data;
}
const SessionContext = createContext(null), ToastContext = createContext(null), InstallContext = createContext(null);
export function Providers({ children }) {
  const [session, setSession] = useState({ loading: true, user: null, memberships: [] });
  const [bootstrap, setBootstrap] = useState(null), [toast, setToast] = useState(null), [installPrompt, setInstallPrompt] = useState(null), [installed, setInstalled] = useState(() => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true);
  useEffect(()=>{const active=new Set(),exclusive=event=>{const media=event.target;if(!(media instanceof HTMLMediaElement))return;const others=[...document.querySelectorAll('audio,video')].filter(other=>other!==media&&!other.paused);if(media.dataset.partnerMedia==='true'&&media.muted&&others.some(other=>!other.muted)){media.pause();return;}others.forEach(other=>other.pause());active.add(media);};const observer=new MutationObserver(()=>{for(const media of active)if(!media.isConnected){media.pause();active.delete(media);}});observer.observe(document.body,{childList:true,subtree:true});document.addEventListener('play',exclusive,true);return()=>{observer.disconnect();document.removeEventListener('play',exclusive,true);for(const media of active)media.pause();};},[]);
  const timer = useRef(null),updating=useRef(false);const [waitingWorker,setWaitingWorker]=useState(null);
  const refresh = useCallback(async () => { const data = await api('/api/auth/me'); setSession({ ...data, loading: false }); return data; }, []);
  const refreshBootstrap = useCallback(async () => { const data = await api('/api/bootstrap'); setBootstrap(data); return data; }, []);
  useEffect(() => { Promise.all([refresh(), refreshBootstrap()]).catch(error => { setSession(s => ({ ...s, loading: false, error: error.message })); }); }, [refresh, refreshBootstrap]);
  const notify = useCallback((message, type = 'success') => { clearTimeout(timer.current); setToast({ message, type }); timer.current = setTimeout(() => setToast(null), 5500); }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    const before = event => { event.preventDefault(); setInstallPrompt(event); };
    const done = () => { setInstalled(true); setInstallPrompt(null); window.dispatchEvent(new Event('promote:installed')); };
    window.addEventListener('beforeinstallprompt', before); window.addEventListener('appinstalled', done);
    const changed=()=>{if(updating.current)window.location.reload();};
    if ('serviceWorker' in navigator) {navigator.serviceWorker.addEventListener('controllerchange',changed);navigator.serviceWorker.register('/sw.js').then(registration=>{if(registration.waiting)setWaitingWorker(registration.waiting);registration.addEventListener('updatefound',()=>{const worker=registration.installing;worker?.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)setWaitingWorker(worker);});});}).catch(()=>{});}
    return () => { window.removeEventListener('beforeinstallprompt', before); window.removeEventListener('appinstalled', done);if('serviceWorker' in navigator)navigator.serviceWorker.removeEventListener('controllerchange',changed); };
  }, []);
  return <SessionContext.Provider value={{ ...session, bootstrap, refresh, refreshBootstrap }}><ToastContext.Provider value={notify}><InstallContext.Provider value={{ installPrompt, installed }}>{children}{waitingWorker&&<div className="app-update-notice" role="status"><span><strong>A fresh version is ready.</strong><small>Save your changes before reloading.</small></span><button onClick={()=>{updating.current=true;waitingWorker.postMessage({type:'SKIP_WAITING'});}}>Reload <ArrowUpRight size={14}/></button><button onClick={()=>setWaitingWorker(null)} aria-label="Dismiss update notice"><X size={15}/></button></div>}{toast && <div role="status" className={`toast ${toast.type}`}>{toast.type === 'error' ? <AlertCircle size={20}/> : <CheckCircle2 size={20}/>}<span>{toast.message}</span><button aria-label="Dismiss message" onClick={() => setToast(null)}><X size={16}/></button></div>}</InstallContext.Provider></ToastContext.Provider></SessionContext.Provider>;
}
export const useSession = () => useContext(SessionContext);
export const useToast = () => useContext(ToastContext);
export function useRemote(path) {
  const [state, setState] = useState({ path:null,data: null, loading: true, error: null });
  const requestRef = useRef(0);
  const refresh = useCallback(async () => {
    if (!path) return;
    const current = ++requestRef.current;
    try { const data = await api(path); if (current === requestRef.current) setState({ path,data, loading: false, error: null,refreshError:null }); return data; }
    catch (e) { if (current === requestRef.current) setState(s => {const preserve=s.path===path&&s.data&&(!e.status||e.status>=500||e.status===429);return {path,data:preserve?s.data:null,loading:false,error:preserve?null:e.message,refreshError:e.message};}); }
  }, [path]);
  useEffect(() => { setState({ path,data: null, loading: !!path, error: null }); refresh(); return () => { requestRef.current++; }; }, [refresh, path]);
  return { ...state,data:state.path===path?state.data:null,error:state.path===path?state.error:null,loading:state.path===path?state.loading:!!path, refresh };
}
export function useLive(slug, onRefresh) {
  const callback = useRef(onRefresh); useEffect(() => { callback.current = onRefresh; }, [onRefresh]);
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!slug) return;
    const source = new EventSource(slug === '__admin' ? '/api/admin/live' : `/api/live/${slug}`);
    source.onopen = () => setLive(true); source.onerror = () => setLive(false); source.onmessage = () => callback.current?.();
    const fallback = setInterval(() => { if (document.visibilityState === 'visible') callback.current?.(); }, 30000);
    return () => { source.close(); clearInterval(fallback); setLive(false); };
  }, [slug]);
  return live;
}
export function Brand({ dark = false, small = false }) { const {bootstrap}=useSession(); const name=bootstrap?.platformName||'Promote';return <Link to="/" className={`brand ${dark ? 'on-dark' : ''}`} aria-label={`${name} home`}><span className="brand-mark">{name[0].toLowerCase()}<span>↗</span></span><span className="brand-word">{name.toLowerCase()}<span className="brand-dot">.</span>{!small && <small>BY TECHVERSE</small>}</span></Link>; }
export function Button({ children, variant = 'primary', className = '', busy, icon, ...props }) { return <button className={`btn btn-${variant} ${className}`} disabled={busy || props.disabled} {...props}>{busy ? <Loader2 size={17} className="spin"/> : icon}{children}</button>; }
export function Field({ label, hint, error, children, className = '' }) {
  const id=React.useId(),grouped=children?.props?.className?.includes('profession-options'),Tag=grouped?'div':'label';
  const describedBy=[children?.props?.['aria-describedby'],hint&&id+'-hint',error&&id+'-error'].filter(Boolean).join(' ');
  const control=React.isValidElement(children)&&['input','textarea','select'].includes(children.type)?React.cloneElement(children,{'aria-labelledby':children.props['aria-labelledby']||id+'-label',...(describedBy?{'aria-describedby':describedBy}:{})}):children;
  return <Tag className={`field ${className}`} {...(grouped?{role:'group','aria-labelledby':id+'-label'}:{})}><span id={id+'-label'}>{label}</span>{control}{hint&&<small id={id+'-hint'}>{hint}</small>}{error&&<small id={id+'-error'} className="text-danger">{error}</small>}</Tag>;
}
export function Empty({ icon: Icon = Radio, title, children, action }) { return <div className="empty"><span className="empty-icon"><Icon size={25}/></span><h3>{title}</h3><p>{children}</p>{action}</div>; }
export function Loading({ text = 'Getting things ready…' }) { return <div className="loading" role="status"><Loader2 className="spin" size={25}/><span>{text}</span></div>; }
export function ErrorState({ error, retry }) { return <Empty icon={AlertCircle} title="Something needs attention" action={retry && <Button onClick={retry}>Try again</Button>}>{error}</Empty>; }
export function Badge({ children, status, className = '' }) { return <span className={`badge ${status || ''} ${className}`}>{children || String(status || '').replaceAll('_', ' ')}</span>; }
export function Stat({ label, value, icon: Icon, detail }) { return <div className="stat"><div><span>{label}</span>{Icon && <Icon size={18}/>}</div><strong>{value ?? '0'}</strong><small>{detail}</small></div>; }
const modalStack=[];
let originalBodyOverflow='';
export function Modal({ title, children, onClose, wide = false }) {
  const ref=useRef(null),close=useRef(onClose);
  useEffect(()=>{close.current=onClose;},[onClose]);
  useEffect(()=>{
    const dialog=ref.current,previous=document.activeElement;
    if(!modalStack.length){originalBodyOverflow=document.body.style.overflow;document.body.style.overflow='hidden';}
    modalStack.push(dialog);dialog.focus();
    const key=event=>{
      if(modalStack.at(-1)!==dialog)return;
      if(event.key==='Escape'){event.preventDefault();close.current();}
      if(event.key==='Tab'){
        const nodes=[...dialog.querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]')].filter(node=>!node.disabled&&node.tabIndex>=0&&node.getClientRects().length),first=nodes[0],last=nodes.at(-1);
        if(!first){event.preventDefault();dialog.focus();}
        else if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog)){event.preventDefault();last.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
      }
    };
    document.addEventListener('keydown',key);
    return()=>{const index=modalStack.indexOf(dialog);if(index>=0)modalStack.splice(index,1);document.removeEventListener('keydown',key);if(!modalStack.length)document.body.style.overflow=originalBodyOverflow;if(previous?.isConnected)previous.focus();};
  },[]);
  return <div className="modal-backdrop" onClick={e=>{if(e.target===e.currentTarget)onClose();}}><section ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={`modal ${wide?'wide':''}`}><header><h2>{title}</h2><button type="button" className="icon-btn" aria-label="Close dialog" onClick={onClose}><X size={21}/></button></header>{children}</section></div>;
}
export function useAction() {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''); const toast = useToast();
  const run = async (fn, message) => { setBusy(true); setError(''); try { const value = await fn(); if (message) toast(message); return value; } catch (e) { setError(e.message); toast(e.message, 'error'); return null; } finally { setBusy(false); } };
  return { busy, error, run, setError };
}
export const money = (amount, currency = 'NGN') => new Intl.NumberFormat('en-NG', { style: 'currency', currency, maximumFractionDigits: currency === 'XOF' ? 0 : 2 }).format((amount || 0) / (currency === 'XOF' ? 1 : 100));
export const minor = (value, currency) => Math.round(Number(value) * (currency === 'XOF' ? 1 : 100));
export const major = (value, currency) => (value || 0) / (currency === 'XOF' ? 1 : 100);
export const date = (value, options = {}) => value ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', ...options }).format(new Date(value)) : '—';
export const datetime = value => date(value, { hour: '2-digit', minute: '2-digit' });
export const localDate = value => { const d = value ? new Date(value) : new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
export const initials = name => (name || 'P').split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase();
export function Avatar({ business, size = '', className = '' }) { return <span className={`avatar ${size} ${className}`} style={{ background: business.accent || '#c5f36b' }}>{business.avatar || business.appIcon ? <img src={business.avatar || business.appIcon} alt=""/> : initials(business.name)}</span>; }
export function PageHeading({ eyebrow, title, description, action }) { return <div className="page-heading"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>; }
export function UploadField({ label, value, slug, onChange, allowVideo=false,allowAudio=false,professional=false }) {
  const fileInput=useRef(null),action=useAction(),[preview,setPreview]=useState(null),[library,setLibrary]=useState(false),[failed,setFailed]=useState(false),[uploaded,setUploaded]=useState(false);
  useEffect(()=>{setFailed(false);setPreview(null);},[value]);
  useEffect(()=>()=>{if(preview?.url)URL.revokeObjectURL(preview.url);},[preview?.url]);
  const select=async event=>{const input=event.currentTarget,file=input.files?.[0];input.value='';if(!file)return;action.setError('');setFailed(false);setUploaded(false);
    const video=file.type.startsWith('video/'),accepted=allowAudio?['audio/mpeg','audio/mp4','audio/x-m4a','audio/ogg','audio/wav','audio/x-wav']:['image/jpeg','image/png','image/webp',...(allowVideo?['video/mp4','video/webm']:[])];
    if(!accepted.includes(file.type)){action.setError(allowAudio?'Choose an MP3, M4A, OGG or WAV audio file.':allowVideo?'Choose a JPG, PNG, WebP, MP4 or WebM file.':'Choose a JPG, PNG or WebP image. Export HEIC photos as JPG first.');return;}
    if(file.size>(allowAudio?25:video?40:8)*1024*1024){action.setError(allowAudio?'Audio must be smaller than 25 MB.':video?'Video must be smaller than 40 MB.':'Image must be smaller than 8 MB.');return;}
    setPreview({url:URL.createObjectURL(file),video,audio:allowAudio});
    const result=await action.run(async()=>{const body=new FormData();body.append(allowVideo||allowAudio||professional?'media':'image',file);const asset=await api(`/api/business/${slug}/${allowAudio||professional?'professional-assets':allowVideo?'sponsor-assets':'assets'}`,{method:'POST',body});onChange(asset.url,asset);return asset;});
    if(result)setUploaded(true);else setPreview(null);
  };
  const source=preview?.url||value,isAudio=allowAudio||/\.(mp3|m4a|ogg|wav)$/i.test(value||''),isVideo=preview?preview.video:/\.(mp4|webm)$/i.test(value||'');
  return <div className={'upload-field media-picker '+(allowAudio?'media-audio':'')} data-upload-label={label}><div className={`media-picker-preview ${source?'has-media':''}`}>{source&&!failed?(isAudio?<audio src={source} controls preload="metadata" onError={()=>setFailed(true)} aria-label={`${label} preview`}/>:isVideo?<video src={source} controls playsInline muted preload="metadata" onError={()=>setFailed(true)} aria-label={`${label} preview`}/>:<img src={source} alt={label} onError={()=>setFailed(true)}/>):<span>{failed?<AlertCircle size={25}/>:allowVideo?<Video size={25}/>:<ImageIcon size={25}/>}<small>{failed?'This file could not load.':allowAudio?'Choose your audio':allowVideo?'Image, flyer or video':'Choose your image'}</small></span>}{action.busy&&<span className="media-uploading"><Loader2 className="spin" size={20}/> Uploading…</span>}</div><div className="media-picker-actions"><button type="button" className="btn btn-secondary" disabled={action.busy} onClick={()=>fileInput.current?.click()}><Upload size={16}/>{action.busy?'Uploading…':label}</button><input ref={fileInput} aria-label={label} type="file" accept={allowAudio?'audio/mpeg,audio/mp4,audio/x-m4a,audio/ogg,audio/wav,audio/x-wav':allowVideo?'image/jpeg,image/png,image/webp,video/mp4,video/webm':'image/jpeg,image/png,image/webp'} hidden disabled={action.busy} onChange={select}/><button type="button" className="media-library-link" onClick={()=>setLibrary(true)} disabled={action.busy}><Images size={14}/>Choose from uploads</button>{value&&<button type="button" className="media-remove-link" onClick={()=>{onChange('',{type:allowAudio?'audio':'image'});action.setError('');setUploaded(false);setFailed(false);}} disabled={action.busy}>Remove selection</button>}<small className="media-hint">{allowAudio?'MP3, M4A, OGG or WAV \u00b7 up to 25 MB':allowVideo?'Images up to 8 MB · MP4 / WebM up to 40 MB':'JPG, PNG or WebP · up to 8 MB'}</small>{uploaded&&<small role="status" className="media-upload-success"><CheckCircle2 size={13}/> Ready. Save your changes to publish.</small>}{action.error&&<small role="alert" className="media-upload-error">{action.error}</small>}</div>{library&&<AssetLibrary slug={slug} allowVideo={allowVideo} allowAudio={allowAudio} onClose={()=>setLibrary(false)} onChoose={asset=>{onChange(asset.url,asset);action.setError('');setLibrary(false);setUploaded(true);setFailed(false);}}/>}</div>;
}
function AssetLibrary({slug,allowVideo,allowAudio,onClose,onChoose}){
  const remote=useRemote(`/api/business/${slug}/assets`),[filter,setFilter]=useState('all');const assets=(remote.data?.assets||[]).filter(a=>(allowAudio?a.type==='audio':allowVideo?['image','video'].includes(a.type):a.type==='image')&&(filter==='all'||a.type===filter));
  return <Modal title="Your uploads" wide onClose={onClose}><div className="modal-body asset-library"><p>Reuse a file you’ve already uploaded to this business.</p>{allowVideo&&<div className="filter-chips">{['all','image','video'].map(f=><button type="button" key={f} className={filter===f?'selected':''} onClick={()=>setFilter(f)}>{f==='all'?'Everything':f==='image'?'Pictures & flyers':'Videos'}</button>)}</div>}{remote.loading?<Loading text="Loading your uploads…"/>:remote.error?<ErrorState error={remote.error} retry={remote.refresh}/>:assets.length?<div className="asset-library-grid">{assets.map((asset,i)=><button type="button" key={asset.id} onClick={()=>onChoose(asset)} aria-label={`Choose uploaded ${asset.type} ${i+1}`}><div>{asset.type==='video'||asset.type==='audio'?<Video size={34}/>:<img src={asset.url} alt={`Uploaded image ${i+1}`} loading="lazy"/>}<Badge>{asset.type==='video'?'Video':asset.type==='audio'?'Audio':'Image'}</Badge></div><span>{date(asset.createdAt)}<small>{(asset.size/1024/1024).toFixed(1)} MB</small></span></button>)}</div>:<Empty icon={Images} title="Your uploads will live here">Upload an image or video first, then reuse it across your profile and brand features.</Empty>}</div></Modal>;
}
export function InstallButton({ business, compact = false }) {
  const { installPrompt, installed } = useContext(InstallContext), [help, setHelp] = useState(false), toast = useToast();
  const install = async () => {
    if (installed) return toast('You’re already using the installed app.');
    if (installPrompt) { await installPrompt.prompt(); return; }
    setHelp(true);
  };
  return <><Button variant="secondary" onClick={install} icon={installed ? <Check size={16}/> : <Download size={16}/>} className="install-btn">{compact ? 'Install app' : installed ? 'App installed' : `Get ${business?.name || 'the'} app`}</Button>{help && <Modal title={`Install ${business?.name || 'Promote'}`} onClose={() => setHelp(false)}><div className="modal-body"><div className="install-preview"><img src={`/api/brand/${business?.slug || 'platform'}/icon.png?size=192`} alt="App icon"/><strong>{business?.name || 'Promote'}</strong></div><p>Add this website to your home screen to open it like an app.</p><ol className="steps"><li>Open this page in Safari on iPhone or Chrome on Android.</li><li>Open <strong>Share</strong> on iPhone, or the browser menu on Android.</li><li>Choose <strong>Add to Home Screen</strong> or <strong>Install app</strong>.</li><li>Open your new app and enable notifications for event updates.</li></ol><p className="muted small">On phones, use the deployed HTTPS address. A development address on another computer cannot install an app on your phone.</p></div></Modal>}</>;
}
function base64Bytes(value) { return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), char => char.charCodeAt(0)); }
export function PushButton({ business, privateAlerts = false }) {
  const action = useAction(), [subscribed, setSubscribed] = useState(false), [help, setHelp] = useState(false);
  useEffect(() => { let alive=true;if ('serviceWorker' in navigator && 'PushManager' in window) navigator.serviceWorker.ready.then(r=>r.pushManager.getSubscription()).then(async sub=>{const status=sub?await api(`/api/public/${business.slug}/subscription-status`,{method:'POST',body:{endpoint:sub.endpoint,private:privateAlerts}}):{subscribed:false};if(alive)setSubscribed(status.subscribed);}).catch(()=>{});return()=>{alive=false;}; }, [business.slug,privateAlerts]);
  const toggle = () => action.run(async () => {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!('PushManager' in window) || !('Notification' in window) || !('serviceWorker' in navigator)) { setHelp(true); return; }
    if (ios && !(navigator.standalone || window.matchMedia('(display-mode: standalone)').matches)) { setHelp(true); return; }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Notifications are disabled. Allow them in your browser or phone settings to receive updates.');
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (subscribed && subscription) { const result=await api(`/api/public/${business.slug}/subscribe`, { method: 'DELETE', body: { endpoint: subscription.endpoint,private:privateAlerts } }); if(result.removeDeviceSubscription)await subscription.unsubscribe(); setSubscribed(false); return; }
    const { publicKey } = await api(`/api/public/${business.slug}/push-key`);
    subscription = subscription || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64Bytes(publicKey) });
    await api(`/api/public/${business.slug}/subscribe`, { method: 'POST', body: { subscription: subscription.toJSON(), private: privateAlerts } }); setSubscribed(true);
  });
  return <><Button variant="secondary" onClick={toggle} busy={action.busy} icon={subscribed ? <Check size={17}/> : <Bell size={17}/>}>{subscribed ? 'Updates enabled' : privateAlerts ? 'Enable work alerts' : 'Get event updates'}</Button>{help && <Modal title="Stay in the loop" onClose={() => setHelp(false)}><div className="modal-body"><Bell size={36}/><p>On iPhone, install this app on your home screen first, open it from the icon, then tap <strong>Get event updates</strong>.</p><p className="muted">Push needs a supported browser, HTTPS and your permission. You can always read announcements on the Events page.</p><InstallButton business={business}/></div></Modal>}</>;
}
export function TenantIdentity({ business }) {
  const location = useLocation();
  useEffect(() => {
    const slug = business?.slug || 'platform';
    document.title = business ? `${business.name} · ${business.tagline || 'Bookings & experiences'}` : 'Promote — by Techverse';
    const manifest = document.querySelector('link[rel="manifest"]'); manifest.href = `/api/brand/${slug}/manifest.webmanifest`;
    document.querySelector('link[rel="icon"]').href = `/api/brand/${slug}/icon.svg`;
    document.querySelector('link[rel="apple-touch-icon"]').href = `/api/brand/${slug}/icon.png?size=192&v=${business?.brandVersion||'1'}`;
    document.querySelector('meta[name="theme-color"]').content = business ? makeTheme(business.accent,business.themeMode).background : '#f5f5ef';
    if('serviceWorker' in navigator){const theme=makeTheme(business?.accent,business?business.themeMode:'light');navigator.serviceWorker.ready.then(registration=>(navigator.serviceWorker.controller||registration.active)?.postMessage({type:'BRAND',brand:{name:business?.name||'Promote',background:theme.background,text:theme.text,muted:theme.muted,accent:theme.accent,onAccent:theme.onAccent}})).catch(()=>{});}
  }, [business?.slug, business?.name, business?.tagline,business?.accent,business?.themeMode,business?.brandVersion]);
  useEffect(() => { if (!business?.slug) return;
    let device; try { device = localStorage.getItem('promote.device.v1') || crypto.randomUUID(); localStorage.setItem('promote.device.v1', device); } catch { return; }
    const send = kind => api(`/api/public/${business.slug}/metrics`, { method: 'POST', body: { device, kind } }).catch(() => {});
    send('visit'); if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) send('app_open');
    const installed = () => send('install'); window.addEventListener('promote:installed', installed); return () => window.removeEventListener('promote:installed', installed);
  }, [business?.slug]);
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }); }, [location.pathname]);
  return null;
}
