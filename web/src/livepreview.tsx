// 生成中的实时预览：RunningHub 那条 WebSocket 通道推出来的中间帧。
//
// 工作流里的 ModelPreviewOverrideKJ 会在每个采样步解码一帧，通过 ComfyUI 的 WS
// 通道以 `kj_preview_override` 事件推给「提交这个 prompt 的 client_id」。
// 这条通道官方标注「不推荐、不稳定」，所以这里只当它是锦上添花：
// 拿不到就什么都不显示，出片照常走轮询结果。

import { useEffect, useState } from 'react';
import { api } from './store.ts';

interface PreviewState {
  state: string;
  frame: { data: string; mime: string; w: number; h: number } | null;
  step: number;
  total: number;
  stepMs: number;
  progress: { value: number; max: number } | null;
  node: string;
  frames: number;
  updatedAt: number;
  error: string;
}

// 拉取间隔：不用更快——中间帧本来就是低频看的，2.5 秒一次刚好。
const POLL_MS = 2500;
// 平台没给预览通道时（RunningHub 的 OpenAPI 现在就不给 netWssUrl），
// 每 2.5 秒问一次纯属浪费，降成 10 秒；等真有帧了再提回 2.5 秒。
const POLL_IDLE_MS = 10000;

export function LivePreview({ taskId }: { taskId: string }) {
  const [snap, setSnap] = useState<PreviewState | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      let idle = true;
      try {
        const next = await api<PreviewState>('GET', `/api/runninghub/preview/${encodeURIComponent(taskId)}`);
        // state 为 none 表示服务端没有这条预览会话（平台没给 WS 地址，或者任务已经结束了）。
        if (alive && next && next.state !== 'none') {
          setSnap(next);
          idle = !(next.frame?.data);
        }
      } catch {
        /* 预览是附加功能，拿不到就算了 */
      }
      if (alive) timer = window.setTimeout(tick, idle ? POLL_IDLE_MS : POLL_MS);
    };
    tick();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [taskId]);

  const frame = snap?.frame;
  if (!frame?.data) return null;
  const src = `data:${frame.mime};base64,${frame.data}`;
  // KJNodes 对视频模型推的可能是 mp4，对图片是 webp/jpeg。
  const isVideo = /mp4|webm/i.test(frame.mime);
  const percent = snap?.progress?.max ? Math.round((snap.progress.value / snap.progress.max) * 100) : 0;

  return (
    <div className="live-preview">
      {isVideo
        ? <video className="live-preview-media" src={src} muted loop autoPlay playsInline />
        : <img className="live-preview-media" src={src} alt="采样中的中间结果" />}
      <div className="live-preview-meta">
        {snap?.total ? `采样中 ${snap.step}/${snap.total} 步` : '采样中'}
        {percent ? ` · ${percent}%` : ''}
      </div>
    </div>
  );
}
