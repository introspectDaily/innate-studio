// 本地素材库和公网发布：素材默认留在本机，只有需要分享或模型必须读取公网地址时才上传到 TOS。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, readJsonBody, route } from '../http.js';
import { mediaInfo, recordInfo } from '../media.js';
import { publicationsFor, publishLocalMedia } from '../publishing.js';
import { tosConfigView } from '../tos.js';

const KIND_BY_EXT = { '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.webp': 'image', '.mp4': 'video', '.mov': 'video', '.webm': 'video', '.mp3': 'audio', '.wav': 'audio' };
const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };

function materialView(space, item) {
  return { ...item, publications: publicationsFor(space, item.url) };
}

// 旧版本上传的文件没有 metadata：第一次打开素材库时补上，之后就能正常改名、删除。
function localMaterials(space) {
  if (!Array.isArray(space.materials)) space.materials = [];
  const known = new Set(space.materials.map((item) => item.url));
  let changed = false;
  for (const file of fs.readdirSync(space.dir('uploads'))) {
    const url = `/media/uploads/${file}`;
    if (known.has(url)) continue;
    const ext = path.extname(file).toLowerCase();
    const kind = KIND_BY_EXT[ext];
    if (!kind) continue;
    const stat = fs.statSync(path.join(space.dir('uploads'), file));
    space.materials.push({ id: `mat_${crypto.randomUUID()}`, url, name: file, kind, size: stat.size, contentType: MIME_BY_EXT[ext] || 'application/octet-stream', createdAt: stat.mtimeMs });
    changed = true;
  }
  if (changed) space.save('materials');
  return [...space.materials]
    .filter((item) => fs.existsSync(path.join(space.dir('uploads'), path.basename(item.url))))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map((item) => materialView(space, item));
}

function findMaterial(space, id) {
  const item = space.materials?.find((entry) => entry.id === id);
  if (!item) throw new HttpError(404, 'material_not_found', '素材不存在或已被删除');
  return item;
}

route('GET', /^\/api\/materials$/, async ({ space }) => ({ items: localMaterials(space) }));

route('PUT', /^\/api\/materials\/([\w-]+)$/, async ({ req, space, params }) => {
  const { name } = await readJsonBody(req);
  const item = findMaterial(space, params[0]);
  const value = String(name || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 160);
  if (!value) throw new HttpError(400, 'invalid_material_name', '请输入素材名称');
  item.name = value;
  space.save('materials');
  return materialView(space, item);
});

route('DELETE', /^\/api\/materials\/([\w-]+)$/, async ({ space, params }) => {
  const item = findMaterial(space, params[0]);
  if (!item.url.startsWith('/media/uploads/')) throw new HttpError(400, 'invalid_material', '只能删除本地上传的素材');
  try {
    fs.unlinkSync(path.join(space.dir('uploads'), path.basename(item.url)));
  } catch {
    /* 文件已经不在了，继续清元数据 */
  }
  space.materials = space.materials.filter((entry) => entry.id !== item.id);
  space.publications = (space.publications || []).filter((entry) => entry.localUrl !== item.url);
  space.save('materials');
  space.save('publications');
  return null;
});

// 给 agent 用的一个总入口：把一个记录 id 或 /media/... 地址换成「文件在哪」。
// 本机有文件就给绝对路径（agent 直接读，不用下载），没有就给能取的链接——两边都不假装成功。
route('GET', /^\/api\/media$/, async ({ query, space }) => {
  const recordId = String(query.get('record') || '').trim();
  const url = String(query.get('url') || '').trim();
  if (!recordId && !url) throw new HttpError(400, 'invalid_request', '要带 ?record=<记录id> 或 ?url=/media/...');
  if (recordId) return { record: recordId, ...recordInfo(space, recordId) };
  if (/^https?:\/\//i.test(url)) return { url, localPath: null, exists: false, remote: true, note: '公网链接，本机没有对应文件' };
  const info = mediaInfo(space, url);
  const kind = KIND_BY_EXT[path.extname(url.split('?')[0]).toLowerCase()] || null;
  return { ...info, kind, name: path.basename(url.split('?')[0]) || null, contentType: MIME_BY_EXT[path.extname(url.split('?')[0]).toLowerCase()] || null };
});

route('POST', /^\/api\/materials\/publish$/, async ({ req, space }) => {
  const { url, purpose } = await readJsonBody(req);
  const published = await publishLocalMedia(space, String(url || ''), { purpose: purpose === 'reference' ? 'reference' : 'share' });
  return {
    ...published,
    publications: publicationsFor(space, String(url || '')),
  };
});

route('GET', /^\/api\/storage\/status$/, async () => {
  const tos = tosConfigView({ includeCredentials: false });
  return {
    preferred: tos.configured ? 'tos' : '',
    direct: tos.configured ? 'tos' : '',
    tos,
  };
});
