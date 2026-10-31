// 视频剪辑器：在浏览器内把一段视频裁剪成多段（MVP）。
// 处理走 web/src/editor/ffmpeg.ts（ffmpeg.wasm），产物通过现有 /api/uploads 落盘，并刷新材料库。
// 数据模型已预留「拼接 / 转场 / 音画分离」，后续加 UI 即可，不用换引擎。

import { useEffect, useRef, useState } from 'react';
import { openModal, toast } from '../ui/layers.tsx';
import { fmtTime } from '../format.ts';
import { uploadLocalFile } from '../media.ts';
import { trimSegments, type Segment } from './ffmpeg.ts';

interface EditorProps {
  url: string;
  name: string;
  reload: () => void;
}

type DragTarget = 'start' | 'end' | 'play' | null;

function openVideoEditor(url: string, name: string, reload: () => void) {
  openModal({
    title: '视频剪辑',
    subtitle: name,
    size: 'lg',
    content: <VideoEditor url={url} name={name} reload={reload} />,
  });
}

export { openVideoEditor };

function VideoEditor({ url, name, reload }: EditorProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragTarget>(null);

  const [duration, setDuration] = useState(0);
  const [playhead, setPlayhead] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [reencode, setReencode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [engineLoading, setEngineLoading] = useState(false);
  const [progress, setProgress] = useState<{ index: number; ratio: number }>({ index: 0, ratio: 0 });

  const baseName = name.replace(/\.[^.]+$/, '') || 'clip';

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onMeta = () => {
      setDuration(video.duration || 0);
      setEnd(video.duration || 0);
    };
    const onTime = () => setPlayhead(video.currentTime);
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('timeupdate', onTime);
    return () => {
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('timeupdate', onTime);
    };
  }, [url]);

  const ratioFromEvent = (clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };
  const secFromEvent = (clientX: number) => ratioFromEvent(clientX) * duration;

  const onPointerDown = (target: DragTarget) => (e: React.PointerEvent) => {
    e.preventDefault();
    drag.current = target;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current || !duration) return;
    const sec = secFromEvent(e.clientX);
    if (drag.current === 'play') {
      setPlayhead(sec);
      if (videoRef.current) videoRef.current.currentTime = sec;
    } else if (drag.current === 'start') {
      setStart(Math.min(sec, end - 0.1));
    } else if (drag.current === 'end') {
      setEnd(Math.max(sec, start + 0.1));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    drag.current = null;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
  };

  // 点轨道空白处 = 移动播放头。
  const onTrackClick = (e: React.PointerEvent) => {
    if (drag.current) return;
    const sec = secFromEvent(e.clientX);
    setPlayhead(sec);
    if (videoRef.current) videoRef.current.currentTime = sec;
  };

  const addSegment = () => {
    if (end - start < 0.1) {
      toast('选区太短，无法添加分段', 'error');
      return;
    }
    const index = segments.length + 1;
    setSegments((list) => [...list, { id: `s${Date.now()}`, start, end, name: `${baseName}_${index}.mp4` }]);
    setStart(end);
    setEnd(duration);
  };

  const removeSegment = (id: string) => setSegments((list) => list.filter((s) => s.id !== id));

  const exportAll = async () => {
    if (!segments.length) {
      toast('请先添加至少一个分段', 'error');
      return;
    }
    setBusy(true);
    try {
      setEngineLoading(true);
      const file = await (await fetch(url)).blob();
      setEngineLoading(false);
      const results = await trimSegments(file, segments, {
        reencode,
        onProgress: (index, ratio) => setProgress({ index, ratio }),
      });
      let ok = 0;
      for (const { segment, blob } of results) {
        const f = new File([blob], segment.name, { type: 'video/mp4' });
        try {
          await uploadLocalFile(f, 'video', () => {});
          ok += 1;
        } catch (err) {
          toast(`「${segment.name}」上传失败：${(err as Error).message}`, 'error', 6000);
        }
      }
      toast(`剪辑完成，已保存 ${ok}/${results.length} 段到素材库`, ok ? 'success' : 'error', 6000);
      if (ok) reload();
    } catch (err) {
      toast(`剪辑失败：${(err as Error).message}`, 'error', 7000);
    } finally {
      setBusy(false);
      setEngineLoading(false);
      setProgress({ index: 0, ratio: 0 });
    }
  };

  const startPct = duration ? (start / duration) * 100 : 0;
  const endPct = duration ? (end / duration) * 100 : 0;
  const headPct = duration ? (playhead / duration) * 100 : 0;

  return (
    <div className="ve">
      <video ref={videoRef} src={url} className="ve-preview" controls playsInline preload="metadata" />
      <p className="muted small">拖动两端手柄选段，点轨道移动播放头；「添加分段」把当前选区加入列表，可切成多段。</p>

      <div
        ref={trackRef}
        className="ve-timeline"
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerDown={onTrackClick}
      >
        <div className="ve-track" />
        {segments.map((s) => (
          <div
            key={s.id}
            className="ve-seg-mark"
            style={{ left: `${(s.start / (duration || 1)) * 100}%`, width: `${((s.end - s.start) / (duration || 1)) * 100}%` }}
          />
        ))}
        <div className="ve-selection" style={{ left: `${startPct}%`, width: `${endPct - startPct}%` }} />
        <div className="ve-handle ve-handle-start" style={{ left: `${startPct}%` }} onPointerDown={onPointerDown('start')} />
        <div className="ve-handle ve-handle-end" style={{ left: `${endPct}%` }} onPointerDown={onPointerDown('end')} />
        <div className="ve-playhead" style={{ left: `${headPct}%` }} onPointerDown={onPointerDown('play')} />
      </div>

      <div className="ve-readout">
        <span>播放头 {fmtTime(playhead)}</span>
        <span>入点 {fmtTime(start)}</span>
        <span>出点 {fmtTime(end)}</span>
        <span>当前选区 {fmtTime(Math.max(0, end - start))}</span>
      </div>

      <div className="ve-actions">
        <button className="btn btn-sm" type="button" disabled={busy} onClick={() => setStart(playhead)}>设为入点</button>
        <button className="btn btn-sm" type="button" disabled={busy} onClick={() => setEnd(playhead)}>设为出点</button>
        <button className="btn btn-sm btn-primary" type="button" disabled={busy} onClick={addSegment}>添加分段</button>
        <label className="ve-check">
          <input type="checkbox" checked={reencode} disabled={busy} onChange={(e) => setReencode(e.target.checked)} />
          逐帧精确（重编码，较慢）
        </label>
      </div>

      <div className="ve-seg-list">
        {segments.length === 0 ? (
          <p className="muted small">还没有分段。选好一段后点「添加分段」。</p>
        ) : (
          segments.map((s, i) => (
            <div className="ve-seg-row" key={s.id}>
              <span className="ve-seg-idx">{i + 1}</span>
              <input
                className="input input-sm ve-seg-name"
                value={s.name}
                disabled={busy}
                onChange={(e) => setSegments((list) => list.map((x) => (x.id === s.id ? { ...x, name: e.target.value } : x)))}
              />
              <span className="muted small">{fmtTime(s.start)} → {fmtTime(s.end)}（{fmtTime(s.end - s.start)}）</span>
              <button className="btn btn-sm btn-danger" type="button" disabled={busy} onClick={() => removeSegment(s.id)}>删除</button>
            </div>
          ))
        )}
      </div>

      <div className="modal-actions">
        {busy && (
          <span className="muted small">
            {engineLoading ? '正在加载剪辑引擎（首次约 30MB）…' : `导出中：第 ${progress.index + 1}/${segments.length} 段 ${Math.round(progress.ratio * 100)}%`}
          </span>
        )}
        <button className="btn btn-primary" type="button" disabled={busy || !segments.length} onClick={exportAll}>
          {busy ? '处理中…' : `导出 ${segments.length} 段`}
        </button>
      </div>
    </div>
  );
}
