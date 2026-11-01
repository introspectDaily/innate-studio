// 素材文件的处理：缩略图、上传、把素材或生成记录变成一份参考素材。不碰界面。

import { ApiError, KINDS } from './store.ts';
import { fmtBytes } from './format.ts';
import type { HistoryItem, Kind, Ref, TosObject } from './types.ts';

// ---------- 缩略图 ----------

// 把一块画面缩成 320px 以内的 jpeg dataURL。素材缩略图和剪辑器的帧预览共用。
export function drawThumb(source: CanvasImageSource, width: number, height: number) {
  const scale = Math.min(1, 320 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.72);
}

async function imageThumb(file: File) {
  const bitmap = await createImageBitmap(file);
  const url = drawThumb(bitmap, bitmap.width, bitmap.height);
  bitmap.close();
  return url;
}

// 读一段视频的缩略图和时长。source 可以是刚选的文件，也可以是本机已有视频的地址。
export function readVideo(source: File | string) {
  return new Promise<{ thumb: string; duration: number }>((resolve, reject) => {
    const url = typeof source === 'string' ? source : URL.createObjectURL(source);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      if (typeof source !== 'string') URL.revokeObjectURL(url);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('timeout'))), 6000);
    video.onloadeddata = () => {
      video.currentTime = Math.min(0.2, (video.duration || 1) / 2);
    };
    video.onseeked = () => finish(() => resolve({ thumb: drawThumb(video, video.videoWidth, video.videoHeight), duration: Number.isFinite(video.duration) ? video.duration : 0 }));
    video.onerror = () => finish(() => reject(new Error('decode')));
    video.src = url;
  });
}

export async function makeThumb(file: File, kind: Kind) {
  try {
    if (kind === 'image') return await imageThumb(file);
    if (kind === 'video') return (await readVideo(file)).thumb;
  } catch {
    /* 生成不了缩略图就用图标代替 */
  }
  return null;
}

export const kindOfFile = (file: File): Kind | null => (['image', 'video', 'audio'] as Kind[]).find((k) => file.type.startsWith(`${k}/`)) || null;

// ---------- 上传 ----------

export type Progress = (ratio: number) => void;

export function xhrUpload<T = any>(url: string, body: FormData | File, headers: Record<string, string>, onProgress?: Progress) {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* 按空响应处理 */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data?.error?.code || '', data?.error?.message || `上传失败（${xhr.status}）`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', '无法连接服务，请确认服务已启动。'));
    xhr.send(body);
  });
}

// 接口对每类素材有大小上限。超了的文件不发出去，直接说明原因。
export function checkFileSize(file: File, kind: Kind) {
  const { label, maxBytes } = KINDS[kind];
  if (file.size > maxBytes) throw new Error(`文件过大：${label}上限 ${Math.round(maxBytes / 1024 / 1024)} MB，当前 ${fmtBytes(file.size)}`);
}

// ---------- 存在本机的素材 ----------
// 从电脑里选的文件存在本地服务的 uploads 里，生成记录里的结果直接引用。这类素材的 source 是 local，地址是 /media/ 开头的本机地址。

export async function uploadLocalFile(file: File, kind: Kind, onProgress?: Progress): Promise<Ref> {
  checkFileSize(file, kind);
  const video = kind === 'video' ? await readVideo(file).catch(() => null) : null;
  const thumb = video ? video.thumb : await makeThumb(file, kind);
  const saved = await xhrUpload<{ url: string }>(`/api/uploads?filename=${encodeURIComponent(file.name)}`, file, { 'Content-Type': file.type }, onProgress);
  return { uid: crypto.randomUUID(), kind, source: 'local', url: saved.url, name: file.name, thumb, duration: video?.duration };
}

export const recordName = (item: HistoryItem) => (item.prompt || '').trim().slice(0, 40) || item.id;

// 把一条已经存到本机的生成记录当素材用。
export async function refFromRecord(item: HistoryItem): Promise<Ref> {
  const ref: Ref = { uid: crypto.randomUUID(), kind: item.kind, source: 'local', url: item.mediaUrl!, name: recordName(item), thumb: item.kind === 'image' ? item.mediaUrl! : null };
  if (item.kind !== 'video') return ref;
  const video = await readVideo(item.mediaUrl!).catch(() => null);
  return { ...ref, thumb: video?.thumb || null, duration: video?.duration || 0 };
}

// 素材库上传：文件存到服务端配置的 TOS Bucket，返回的对象本身带公网 URL，可以直接作为参考视频。
export async function uploadTosFile(file: File, onProgress?: Progress): Promise<Ref> {
  const kind = kindOfFile(file);
  if (!kind) throw new Error('只支持图片、视频或音频文件');
  checkFileSize(file, kind);
  const video = kind === 'video' ? await readVideo(file).catch(() => null) : null;
  const thumb = video ? video.thumb : await makeThumb(file, kind);
  const saved = await xhrUpload<TosObject>(`/api/tos/objects?filename=${encodeURIComponent(file.name)}`, file, { 'Content-Type': file.type }, onProgress);
  return { uid: crypto.randomUUID(), kind: saved.kind || kind, source: 'url', url: saved.url, name: saved.name || file.name, thumb, duration: video?.duration };
}
