import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, cpSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
const source=resolve(process.env.DATA_DIR||'.data');
if(!existsSync(join(source,'promote.sqlite')))throw new Error('No database found. Start the app first.');
const target=join(source,'backups',new Date().toISOString().replaceAll(':','-').replaceAll('.','-'));
mkdirSync(target,{recursive:true});const db=new DatabaseSync(join(source,'promote.sqlite'));
try{await backup(db,join(target,'promote.sqlite'));if(existsSync(join(source,'uploads')))cpSync(join(source,'uploads'),join(target,'uploads'),{recursive:true});console.log(`Backup created: ${target}`);}finally{db.close();}
