// Only an expiring, single-file upload URL reaches the browser.
export async function uploadCloudForm(path,options,api){
 const form=options.body,files=[...form.entries()].filter(([,value])=>value instanceof Blob);
 if(files.length!==1)throw new Error('Choose one file at a time.');
 const [field,file]=files[0],fields={};
 for(const [key,value]of form.entries())if(key!==field){if(typeof value!=='string')throw new Error('Invalid upload field.');fields[key]=value;}
 const {id,uploadUrl}=await api('/api/uploads/start',{method:'POST',headers:options.headers,body:{target:path,name:file.name||'upload',mime:file.type,size:file.size}});
 const url=new URL(uploadUrl);if(url.protocol!=='https:'||!url.hostname.endsWith('.supabase.co'))throw new Error('Invalid media destination.');
 const response=await fetch(url,{method:'PUT',body:file,headers:{'Content-Type':file.type,'cache-control':'max-age=0','x-upsert':'false'},credentials:'omit',signal:options.signal});
 if(!response.ok)throw new Error('The upload failed. Please select your file and try again.');
 return api(path,{...options,body:{...fields,uploadIntent:id}});
}
