// 存在本机的文件：页面用 /media/... 这样的地址指它们，这里把地址对应到文件，需要时内嵌进发给模型的请求。

import fs from 'node:fs';
import path from 'node:path';
import { HttpError, MIME } from './http.js';
import { MEDIA_DIRS } from './config.js';

export const MEDIA_PATH = /^\/media\/(videos|images|audio|uploads|thumbs)\/([\w-]+(?:\.[\w-]+)*\.(mp4|mov|webm|jpg|jpeg|png|webp|mp3|wav))$/;
export const UPLOAD_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav' };

// 把页面传来的 /media/... 地址对应到本机文件。只认这几个目录下的文件名，不接受带路径的写法。
export function localMediaFile(space, url) {
  const match = MEDIA_PATH.exec(String(url || '').split('?')[0]);
  const file = match && path.join(space.dir(match[1]), match[2]);
  if (!file || !fs.existsSync(file)) throw new HttpError(400, 'file_not_found', '文件不存在或已被删除');
  return file;
}

// 只存在本机的文件要直接放进请求：首尾帧（frame_images）和参考素材（input_references）。
// 页面传来的是本机地址，发给模型前换成 data URL；记录里存的仍是原来的短地址。
// 参考音频也能这样内嵌（文档：音频 URL、Base64 编码、素材 ID 都收，单个不超过 15 MB），类型写文件格式本身：audio/mp3、audio/wav。
export function withLocalFiles(space, payload) {
  const inline = (holder, audio = false) => {
    const url = holder?.url;
    if (typeof url !== 'string' || !url.startsWith('/media/')) return holder;
    const file = localMediaFile(space, url);
    const ext = path.extname(file).toLowerCase();
    const type = audio ? `audio/${ext.slice(1)}` : MIME[ext] || 'image/jpeg';
    return { ...holder, url: `data:${type};base64,${fs.readFileSync(file).toString('base64')}` };
  };
  const next = { ...payload };
  for (const field of ['frame_images', 'input_references']) {
    if (!Array.isArray(payload[field])) continue;
    next[field] = payload[field].map((entry) => {
      // 参考视频在 routes/generate.js 里已经按需换成公网直链；这里只做最后一道校验。
      if (entry?.video_url) {
        if (!/^https:\/\//i.test(entry.video_url.url || '')) throw new HttpError(400, 'invalid_request', '参考视频须为可公开访问的 https 链接');
        return entry;
      }
      if (entry?.audio_url) {
        const url = String(entry.audio_url.url || '');
        if (!url.startsWith('/media/') && !/^https:\/\//i.test(url)) throw new HttpError(400, 'invalid_request', '参考音频须为本机文件或可公开访问的 https 链接');
        return { ...entry, audio_url: inline(entry.audio_url, true) };
      }
      return entry?.image_url ? { ...entry, image_url: inline(entry.image_url) } : entry;
    });
  }
  return next;
}

// ---------- 给 agent 用的「这个文件在哪」 ----------
// 画布节点、生成记录里存的都是 /media/... 这种短地址，页面按它取文件；agent 要直接看（读图、看视频首帧），
// 需要的是本机绝对路径。下面三个函数把三种存法都归到同一形状：{ url, localPath, exists }。

const LOCAL_MEDIA = /^\/media\/([\w-]+)\/([\w-]+(?:\.[\w-]+)*)$/;

// 一个 /media/... 地址 → 本机文件。文件可能已经被删了，所以 exists 单独给，不在这里抛错。
export function mediaInfo(space, url) {
  const value = String(url || '');
  if (!value) return { url: null, localPath: null, exists: false };
  // 发布过的素材是公网直链，本机没有对应文件（也不一定有），只能给链接。
  if (/^https:\/\//i.test(value)) return { url: value, localPath: null, exists: false, remote: true };
  const match = LOCAL_MEDIA.exec(value.split('?')[0]);
  if (!match) return { url: value, localPath: null, exists: false };
  const file = path.join(space.dir(match[1]), match[2]);
  const exists = fs.existsSync(file);
  return { url: value, localPath: exists ? file : null, exists, ...(exists ? { bytes: fs.statSync(file).size } : {}) };
}

// 生成记录 id → 结果文件。记录被删了、或者结果还没下载到本机，都如实说，不给一个不存在的路径。
export function recordInfo(space, recordId) {
  const item = space.history.find((h) => h.id === recordId);
  if (!item) return { recordId, localPath: null, exists: false, note: '生成记录已不存在（可能被删掉了）' };
  const mediaUrl = item.localFile ? `/media/${MEDIA_DIRS[item.kind] || MEDIA_DIRS.video}/${item.localFile}` : item.remoteUrl || null;
  const file = item.localFile ? path.join(space.resultDir(item), item.localFile) : null;
  const exists = Boolean(file && fs.existsSync(file));
  return {
    recordId,
    kind: item.kind,
    status: item.status,
    model: item.model,
    prompt: item.prompt,
    mediaUrl,
    localPath: exists ? file : null,
    exists,
    ...(exists ? { bytes: fs.statSync(file).size } : {}),
  };
}

// 节点里现在放着的那一份内容：生成出来的（recordId）或上传/挂上去的（upload、selfFrame）。纯文本节点没有文件。
export function nodeContentInfo(space, node) {
  const data = node?.data || {};
  if (data.recordId) return { via: 'record', ...recordInfo(space, data.recordId) };
  const upload = data.upload || data.selfFrame;
  if (upload?.url) return { via: 'upload', name: upload.name || null, ...mediaInfo(space, upload.url) };
  if (node?.type === 'text') return { via: 'text', text: String(data.text || ''), exists: true, localPath: null, url: null };
  return null;
}
