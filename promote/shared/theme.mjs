const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
const rgb=hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));
const hex=values=>'#'+values.map(n=>Math.round(clamp(n,0,255)).toString(16).padStart(2,'0')).join('');
export const mix=(a,b,weight)=>hex(rgb(a).map((n,i)=>n*(1-weight)+rgb(b)[i]*weight));
export function luminance(color){const values=rgb(color).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;});return values[0]*.2126+values[1]*.7152+values[2]*.0722;}
export function contrast(a,b){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
export function readable(color,background){const target=luminance(background)<.3?'#ffffff':'#000000';for(let i=0;i<=20;i++){const candidate=mix(color,target,i/20);if(contrast(candidate,background)>=4.5)return candidate;}return target;}
function hueOf(color){const [r,g,b]=rgb(color).map(n=>n/255),max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;if(!d)return null;let h=max===r?((g-b)/d)%6:max===g?(b-r)/d+2:(r-g)/d+4;return (Math.round(h*60)+360)%360;}
function hsl(h,s,l){s/=100;l/=100;const a=s*Math.min(l,1-l),f=n=>{const k=(n+h/30)%12;return 255*(l-a*Math.max(-1,Math.min(k-3,9-k,1)));};return hex([f(0),f(8),f(4)]);}
export function makeTheme(value='#c5f36b',mode='dark'){
  const accent=/^#[0-9a-f]{6}$/i.test(value)?value:'#c5f36b',hue=hueOf(accent),h=hue??220,s=hue===null?3:18,dark=mode!=='light';
  const background=hsl(h,s,dark?6:97),surface=hsl(h,s,dark?9:99),raised=hsl(h,s,dark?12:94),text=hsl(h,Math.min(s,12),dark?94:15),muted=readable(hsl(h,10,dark?62:44),background);
  const onAccent=contrast('#111111',accent)>=4.5?'#111111':contrast('#ffffff',accent)>=4.5?'#ffffff':'#000000';
  return {accent,onAccent,background,surface,raised,text,muted,border:hsl(h,s,dark?21:84),soft:mix(accent,surface,dark?.9:.92),ink:readable(accent,background),strong:readable(accent,surface),hover:mix(accent,onAccent==='#ffffff'?'#000000':'#ffffff',.10),mode:dark?'dark':'light'};
}
export function themeStyle(business={},forcedMode){const t=makeTheme(business.accent,forcedMode||business.themeMode||'dark'),form=makeTheme(business.accent,'light');return {'--accent':t.accent,'--on-accent':t.onAccent,'--accent-hover':t.hover,'--brand-ink':t.ink,'--brand-strong':t.strong,'--brand-soft':t.soft,'--page-bg':t.background,'--surface':t.surface,'--surface-raised':t.raised,'--text':t.text,'--muted':t.muted,'--border':t.border,'--line':t.border,'--header-bg':t.background,'--brand-shadow':t.accent+'16','--form-bg':form.surface,'--form-text':form.text,'--form-muted':form.muted,'--form-border':form.border,'--form-soft':form.soft,'--form-raised':form.raised,'--form-ink':form.ink};}
