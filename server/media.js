// 存在本机的文件：页面用 /media/... 这样的地址指它们，这里把地址对应到文件，需要时内嵌进发给模型的请求。

import fs from 'node:fs';
import path from 'node:path';
import { HttpError, MIME } from './http.js';

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
