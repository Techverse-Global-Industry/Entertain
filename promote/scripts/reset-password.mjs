import { createApp } from '../server/index.mjs';
import bcrypt from 'bcryptjs';
const email=process.env.RECOVERY_EMAIL,password=process.env.RECOVERY_PASSWORD;
if(!email||!password||password.length<10)throw new Error('Set RECOVERY_EMAIL and a RECOVERY_PASSWORD of at least 10 characters in the server environment.');
const runtime=createApp({scheduler:false});
try{
  const user=runtime.store.get('SELECT id FROM users WHERE email=?',email.toLowerCase().trim());
  if(!user)throw new Error('No account matches this email.');
  const encoded=await bcrypt.hash(password,12);
  runtime.store.tx(()=>{runtime.store.run('UPDATE users SET password=? WHERE id=?',encoded,user.id);runtime.store.run('DELETE FROM sessions WHERE user_id=?',user.id);runtime.store.audit(null,null,'account.operator_password_reset',{userId:user.id});});
  console.log('Password reset. All existing sessions for this account have been revoked. Remove the recovery values from your environment.');
}finally{runtime.close();}
