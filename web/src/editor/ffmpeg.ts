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
      await tryLoad(await toBlobURL(LOCAL_CORE, 'text/javascript'), await toBlobURL(LOCAL_WASM, 'application/wasm'));
    } catch {
      // 本地 core 缺失（例如忘了复制文件）：回退到 CDN。
      await tryLoad(await toBlobURL(`${CDN_BASE}/ffmpeg-core.js`, 'text/javascript'), await toBlobURL(`${CDN_BASE}/ffmpeg-core.wasm`, 'application/wasm'));
    }
    ffmpeg = instance;
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
