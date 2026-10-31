// 浏览器内的视频处理引擎：ffmpeg.wasm（单线程版，不依赖 SharedArrayBuffer / COOP-COEP）。
// 设计目标：MVP 先做「裁剪 / 分割」，但命令层已经覆盖你列的其余能力，后续加 UI 即可，无需换引擎。
//
// 已覆盖（命令层，本次实现裁剪/分割）：
//   - 裁剪 / 分割：  -ss <起> -to <止>  （stream copy 快切，或 libx264 重编码逐帧精确）
// 预留（仅命令模板，待加 UI）：
//   - 拼接：        -filter_complex "[0][1]concat=n=2:v=1:a=1[v][a]" -map "[v]" -map "[a]"
//   - 转场：        -filter_complex "xfade=transition=fade:duration=1:offset=4" （gl-transitions 同理）
//   - 音画分离：    提取音轨 -vn -acodec copy out.aac ；剔除音轨 -an ；替换音轨 -i v.mp4 -i a.m4a -c copy -map 0:v:0 -map 1:a:0

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

// 自托管的 core 放在 web/public/ffmpeg/，由 Vite 在 /ffmpeg/ 下提供，可离线使用。
const LOCAL_CORE = '/ffmpeg/ffmpeg-core.js';
const LOCAL_WASM = '/ffmpeg/ffmpeg-core.wasm';
// 兜底 CDN（本地文件缺失或加载失败时再用，需要联网）。
const CDN_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd';

// 核心文件的版本号，构建时由 vite 从 @ffmpeg/core/package.json 注入。
declare const __FFMPEG_CORE_VERSION__: string;
const CACHE_NAME = `ffmpeg-core-${__FFMPEG_CORE_VERSION__}`;

// 32MB 的核心文件每次都从服务端取太浪费，第一次拿到之后就存在浏览器自己的缓存里（Cache Storage），
// 之后直接从本地读。缓存名带着 core 的版本号，升级版本就自动换一套，不会接着用对不上的旧核心。
// 浏览器不支持（或配额不够）就退回原来的直接取，功能不受影响。
async function coreBlobURL(url: string, type: string): Promise<string> {
  const direct = () => toBlobURL(url, type);
  if (typeof caches === 'undefined') return direct();
  try {
    const store = await caches.open(CACHE_NAME);
    const cached = await store.match(url);
    if (cached) return URL.createObjectURL(await cached.blob());
    const res = await fetch(url);
    if (!res.ok) return direct();
    try {
      await store.put(url, res.clone());
    } catch {
      // 放不下就不缓存了，这一趟照常用。
    }
    return URL.createObjectURL(await res.blob());
  } catch {
    return direct();
  }
}

// 换了 core 版本之后，把上一版留下的缓存删掉，别让 32MB 一份份堆在用户硬盘上。
async function dropStaleCores() {
  if (typeof caches === 'undefined') return;
  try {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith('ffmpeg-core-') && name !== CACHE_NAME).map((name) => caches.delete(name)));
  } catch {
    // 清不掉也不影响使用。
  }
}

let ffmpeg: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;

export interface Segment {
  id: string;
  start: number; // 秒
  end: number; // 秒
  name: string;
}

export interface TrimOptions {
  // false：stream copy 快切（落在关键帧附近，最快）；true：libx264 重编码逐帧精确（慢）。
  reencode?: boolean;
  // 第 i 段处理进度回调，ratio 0~1。
  onProgress?: (index: number, ratio: number) => void;
}

// 单例加载，整个页面只拉一次 wasm。
export function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpeg?.loaded) return Promise.resolve(ffmpeg);
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const instance = new FFmpeg();
    const tryLoad = async (coreURL: string, wasmURL: string) =>
      instance.load({ coreURL, wasmURL });
    try {
      // 本地这份优先：从 /ffmpeg/ 取，第二次开始读的就是浏览器自己缓存的那份。
      await tryLoad(await coreBlobURL(LOCAL_CORE, 'text/javascript'), await coreBlobURL(LOCAL_WASM, 'application/wasm'));
    } catch {
      // 本地没有（例如忘了构建）或者坏了：回退到 CDN。
      await tryLoad(await toBlobURL(`${CDN_BASE}/ffmpeg-core.js`, 'text/javascript'), await toBlobURL(`${CDN_BASE}/ffmpeg-core.wasm`, 'application/wasm'));
    }
    ffmpeg = instance;
    await dropStaleCores();
    return instance;
  })();
  return loadPromise;
}

async function fetchSource(source: File | Blob | string): Promise<Uint8Array> {
  if (typeof source === 'string') return (await fetchFile(source)) as Uint8Array;
  return (await fetchFile(source)) as Uint8Array;
}

// 把一个视频按多段入/出点切出多个独立视频。
// 返回每段对应的 Blob，方便直接上传落盘。
export async function trimSegments(
  source: File | Blob | string,
  segments: Segment[],
  opts: TrimOptions = {},
): Promise<{ segment: Segment; blob: Blob }[]> {
  const ff = await getFFmpeg();
  const inputName = 'input.mp4';
  const bytes = await fetchSource(source);
  await ff.writeFile(inputName, bytes);

  const results: { segment: Segment; blob: Blob }[] = [];
  try {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const out = `seg_${i}.mp4`;
      const handler = ({ progress }: { progress: number }) => opts.onProgress?.(i, progress);
      ff.on('progress', handler);
      const args = opts.reencode
        ? ['-i', inputName, '-ss', String(seg.start), '-to', String(seg.end), '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', out]
        : ['-ss', String(seg.start), '-to', String(seg.end), '-i', inputName, '-c', 'copy', out];
      try {
        await ff.exec(args);
        const data = (await ff.readFile(out)) as Uint8Array;
        results.push({ segment: seg, blob: new Blob([data as BlobPart], { type: 'video/mp4' }) });
      } finally {
        ff.off('progress', handler);
        try {
          await ff.deleteFile(out);
        } catch {
          /* 文件可能没生成 */
        }
      }
    }
  } finally {
    try {
      await ff.deleteFile(inputName);
    } catch {
      /* 忽略 */
    }
  }
  return results;
}

// ---- 预留接口（命令模板，后续加 UI 时启用） ----

// export async function concatClips(files: File[], outName = 'merged.mp4'): Promise<Blob> { ... }
// export async function applyTransition(a: File, b: File, duration = 1, offset?: number): Promise<Blob> { ... }
// export async function extractAudio(source: File, kind: 'copy' | 'aac' = 'aac'): Promise<Blob> { ... }
// export async function removeAudio(source: File): Promise<Blob> { ... }
