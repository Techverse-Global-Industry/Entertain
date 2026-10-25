import {applyCloudEnvironment} from '../../server/cloud-environment.mjs';
import {openCloudStore} from '../../server/cloud-store.mjs';
import {createApp} from '../../server/index.mjs';
import {cloudUploadTools} from '../../server/cloud-uploads.mjs';
export default async()=>{
 applyCloudEnvironment();
 const store=openCloudStore();let runtime;
 try{runtime=createApp({store,seed:false,scheduler:false});runtime.runScheduled();cloudUploadTools({store}).cleanup();await runtime.flushPush({deadline:Date.now()+18000});return new Response(null,{status:204});}
 finally{if(runtime)runtime.close();else store.db.close();}
};
export const config={schedule:'* * * * *'};
