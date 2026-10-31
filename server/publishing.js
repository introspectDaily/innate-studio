// 公网发布：素材本体永远先留在本地；只有生成请求必须使用公网 URL 时，才在这里上传到 TOS 并把结果缓存起来。
// TOS 是稳定对象地址，复用前用 headObject 确认对象还在。

import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './http.js';
import { localMediaFile } from './media.js';
import { publishLocalFileToTos, tosConfigured, validateTosPublication } from './tos.js';

const CHECK_TTL_MS = 5 * 60 * 1000;
const KIND_BY_EXT = { '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.webp': 'image', '.mp4': 'video', '.mov': 'video', '.webm': 'video', '.mp3': 'audio', '.wav': 'audio' };
const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
const message = (err) => (err instanceof Error ? err.message : String(err));

const publicationsOf = (space) => (Array.isArray(space.publications) ? space.publications : []);

function savePublication(space, record) {
  const list = publicationsOf(space).filter((item) => !(item.localUrl === record.localUrl && item.provider === record.provider && item.purpose === record.purpose));
  space.publications = [record, ...list].slice(0, 500);
  space.save('publications');
}

function expired(record) {
  return Boolean(record.expiresAt && Date.parse(record.expiresAt) <= Date.now() + 60 * 1000);
}

function fileInfo(space, localUrl) {
  const file = localMediaFile(space, localUrl);
  const ext = path.extname(file).toLowerCase();
  const kind = KIND_BY_EXT[ext];
  if (!kind) throw new HttpError(400, 'invalid_request', '该素材类型不支持公网发布');
  return { file, ext, kind, size: fs.statSync(file).size, contentType: MIME_BY_EXT[ext] || 'application/octet-stream', filename: path.basename(file) };
}

async function validatePublication(space, record, purpose) {
  if (!record || expired(record)) return null;
  if (record.provider !== 'tos') return null;
  try {
    const checked = await validateTosPublication(record);
    if (!checked) return null;
    const next = { ...record, ...checked, valid: true };
    savePublication(space, next);
    return next;
  } catch {
    return null;
  }
}

async function cachedFor(space, localUrl, purpose) {
  const candidates = publicationsOf(space)
    .filter((item) => item.localUrl === localUrl && item.provider === 'tos' && (purpose === 'share' || item.direct))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  for (const candidate of candidates) {
    const checked = await validatePublication(space, candidate, purpose);
    if (checked) return { ...checked, reused: true };
  }
  return null;
}

// 发布一份本地素材。purpose:
// - share：供人下载/预览；
// - reference：模型要直接读取文件（Ark 参考视频）。
// 两种用途都走 TOS：它给出稳定、可被模型直接读取的对象地址。
export async function publishLocalMedia(space, localUrl, { purpose = 'share' } = {}) {
  if (!String(localUrl || '').startsWith('/media/')) throw new HttpError(400, 'invalid_request', '只能发布本机素材');
  const info = fileInfo(space, localUrl);
  if (purpose === 'reference' && info.kind !== 'video') throw new HttpError(400, 'invalid_request', '只有视频需要公网参考链接');

  if (!tosConfigured()) {
    throw new HttpError(409, 'public_storage_not_configured', '需要公网链接，但尚未配置 TOS。请先在「管理」中配置火山引擎 TOS。');
  }

  const cached = await cachedFor(space, localUrl, purpose);
  if (cached) return cached;

  let uploaded;
  try {
    uploaded = await publishLocalFileToTos(space, localUrl, { purpose });
  } catch (err) {
    throw err instanceof HttpError ? err : new HttpError(502, 'public_storage_failed', `公网发布失败：${message(err)}`);
  }
  const record = {
    localUrl,
    purpose,
    provider: 'tos',
    remoteId: uploaded.key,
    key: uploaded.key,
    url: uploaded.url,
    expiresAt: null,
    direct: true,
    size: uploaded.size,
    contentType: uploaded.contentType,
    createdAt: Date.now(),
    checkedAt: Date.now(),
    valid: true,
  };
  savePublication(space, record);
  return record;
}

export async function withPublicVideos(space, payload) {
  const next = { ...payload };
  if (!Array.isArray(payload.input_references)) return next;
  next.input_references = [];
  for (const ref of payload.input_references) {
    if (!ref?.video_url) {
      next.input_references.push(ref);
      continue;
    }
    const url = String(ref.video_url.url || '');
    if (url.startsWith('/media/')) {
      const published = await publishLocalMedia(space, url, { purpose: 'reference' });
      next.input_references.push({ ...ref, video_url: { ...ref.video_url, url: published.url } });
      continue;
    }
    if (!/^https:\/\//i.test(url)) throw new HttpError(400, 'invalid_request', '参考视频须为本机文件或可公开访问的 https 链接');
    next.input_references.push(ref);
  }
  return next;
}

export function publicationsFor(space, localUrl) {
  const now = Date.now();
  return publicationsOf(space).filter((item) => item.localUrl === localUrl).map((item) => ({
    provider: item.provider,
    url: item.url,
    expiresAt: item.expiresAt || null,
    direct: Boolean(item.direct),
    // 超过 5 分钟就标成待重新校验；下次发布/生成会调用远端确认并复用同一链接。
    valid: Boolean(item.valid) && !expired(item) && Boolean(item.checkedAt) && now - item.checkedAt < CHECK_TTL_MS,
    checkedAt: item.checkedAt || null,
    purpose: item.purpose,
  }));
}
