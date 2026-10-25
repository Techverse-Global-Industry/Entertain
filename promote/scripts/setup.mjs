import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createApp } from '../server/index.mjs';
import { createUser, uid, json, permissions } from '../server/core.mjs';
const runtime=createApp({scheduler:false});
try{
  if(runtime.store.get("SELECT id FROM users WHERE role='admin'")){console.log('An administrator already exists. Open /login to sign in.');}
  else if(process.env.ADMIN_EMAIL&&process.env.ADMIN_PASSWORD){
    if(process.env.ADMIN_PASSWORD.length<10)throw new Error('ADMIN_PASSWORD must contain at least 10 characters.');
    const user=await createUser(runtime.store,{email:process.env.ADMIN_EMAIL,name:'Techverse Administrator',password:process.env.ADMIN_PASSWORD,role:'admin'});
    runtime.store.run('INSERT INTO memberships VALUES(?,?,?,?,?,?)',uid('mem_'),'tn_henry',user.id,'owner',json(permissions),'[]');
    runtime.store.setSetting('bootstrapHash',null);runtime.store.audit(null,user.id,'platform.setup');
    console.log('Administrator created from environment variables. Start the app and open /login.');
  }else console.log('Start the app, then open /setup to create your administrator account. On a deployed server, use the code in .data/bootstrap-code.txt.');
}finally{runtime.close();}
