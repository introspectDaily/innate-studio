// 视频静帧：定位到某一秒、等画面真的画出来，再复制成一张 PNG。
// 剪辑器的「截取当前帧」和画布的「截取首帧/尾帧」共用这一套，省得两处各写一遍。
// 这里只管把画面抠出来，落盘交给 media.ts 的 uploadLocalFile。

import { drawThumb } from '../media.ts';

export interface FrameShot {
  blob: Blob;
  width: number;
  height: number;
  // 小尺寸 jpeg dataURL，给列表里的预览图用，不用再单独请求一遍。
  thumb: string;
}

// 起一个不显示的视频元素，加载完元数据（时长、宽高）就返回。
export function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.onloadedmetadata = () => {
      video.onloadedmetadata = null;
      video.onerror = null;
      resolve(video);
    };
    video.onerror = () => reject(new Error('视频加载失败'));
    video.src = url;
  });
}

// 'last' 往前让一点点，停在真正有画面的地方，不会拿到全黑或空帧。
export function frameTime(video: HTMLVideoElement, at: number | 'last') {
  const last = Math.max(0, (video.duration || 0) - 0.05);
  return at === 'last' ? last : Math.min(Math.max(0, at), last);
}

// 定位到某一秒，等 seeked 之后再多等一帧——seeked 时解码器不一定已经把画面画上去了，
// 直接 drawImage 偶尔会抓到上一帧。requestVideoFrameCallback 能用就用，不能就用一次 rAF 兜底，
// 两条路都加超时，免得某些浏览器一直不回调把导出卡死。
export function seekVideo(video: HTMLVideoElement, at: number | 'last'): Promise<void> {
  const target = frameTime(video, at);
  const atTarget = Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2;
  const painted = () =>
    new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = setTimeout(done, 400);
      const rvfc = (video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback;
      if (typeof rvfc === 'function') rvfc.call(video, () => {
        clearTimeout(timer);
        done();
      });
      else requestAnimationFrame(() => {
        clearTimeout(timer);
        done();
      });
    });

  if (atTarget) return painted();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('seeked', ok);
      video.removeEventListener('error', bad);
    };
    const ok = () => {
      cleanup();
      painted().then(resolve);
    };
    const bad = () => {
      cleanup();
      reject(new Error('视频定位失败'));
    };
    video.addEventListener('seeked', ok, { once: true });
    video.addEventListener('error', bad, { once: true });
    video.currentTime = target;
  });
}

// 截一帧。video 可以已经停在目标位置，也可以让这里来定位（会顺带把预览画面挪过去）。
export async function shootFrame(video: HTMLVideoElement, at: number | 'last', opts: { seek?: boolean } = {}): Promise<FrameShot> {
  if (opts.seek !== false) await seekVideo(video, at);
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) throw new Error('这一帧还没有画面，稍等一下再截');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(video, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('画面导出失败');
  return { blob, width, height, thumb: drawThumb(canvas, width, height) };
}
