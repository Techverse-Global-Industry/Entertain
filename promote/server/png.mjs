import sharp from 'sharp';
import {readFile,fileInfo} from './storage.mjs';
import {fail} from './core.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
export async function iconPng(tenant, size, dataDir, store, assetRoot) {
  if (tenant?.appIcon?.startsWith('/media/uploads/')) {
    const filename = tenant.appIcon.split('/').pop();
    if(store){const asset=store.get('SELECT mime FROM assets WHERE path=? AND tenant_id=?',filename,tenant.id);fail(asset?.mime.startsWith('image/'),404,'App image not found.');if(store.cloud)fail(fileInfo(store,filename)?.bucket==='tg-public',404,'App image not found.');}
    return sharp(store?.cloud?readFile(store,filename):join(dataDir, 'uploads', filename)).resize(size, size, { fit: 'cover' }).png().toBuffer();
  }
  if (tenant?.id === 'tn_henry' && !tenant.appIcon) {
    return sharp(assetRoot?join(assetRoot,'public','media','henry-soiree.jpeg'):join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'media', 'henry-soiree.jpeg')).resize(size, size, { fit: 'cover' }).png().toBuffer();
  }
  const letters = (tenant?.name || 'Promote').split(/\s+/).map(w => w[0]).slice(0, 2).join('').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#101413"/><circle cx="256" cy="256" r="178" fill="${tenant?.accent || '#c5f36b'}"/><text x="256" y="302" font-family="Arial,sans-serif" font-weight="900" font-size="140" text-anchor="middle" fill="#101413">${letters}</text></svg>`;
  return sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
}
export async function validateImage(file) {
  if (!file || file.buffer.length>8*1024*1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return false;
  try { const info = await sharp(file.buffer, { limitInputPixels: 24000000 }).metadata(); return ['jpeg', 'png', 'webp'].includes(info.format) && info.width > 8 && info.height > 8; } catch { return false; }
}
export async function normalizeImage(buffer){return sharp(buffer,{limitInputPixels:24000000}).rotate().resize({width:2400,height:2400,fit:'inside',withoutEnlargement:true}).webp({quality:88}).toBuffer();}
