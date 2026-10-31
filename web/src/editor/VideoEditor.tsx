// 视频剪辑器：在浏览器内把一段视频裁剪成多段（MVP）。
// 处理走 web/src/editor/ffmpeg.ts（ffmpeg.wasm），产物通过现有 /api/uploads 落盘，并刷新材料库。
// 数据模型已预留「拼接 / 转场 / 音画分离」，后续加 UI 即可，不用换引擎。

import { useEffect, useRef, useState } from 'react';
import { openModal, toast } from '../ui/layers.tsx';
import { fmtClock } from '../format.ts';
import { uploadLocalFile } from '../media.ts';
import { trimSegments, errText, type Segment } from './ffmpeg.ts';
import type { Made } from '../canvas/edit.tsx';

// 剪出来的片段交给谁：
//   onMade — 画布在用，拿这些片段在当前节点右边生成新的视频节点，产物能继续参与生成流程；
//   reload — 素材库、创作记录在用的。落盘之后刷新列表就行。
export interface EditorOptions {
  onMade?: (made: Made[]) => void;
  reload?: () => void;
}

interface EditorProps extends EditorOptions {
  url: string;
  name: string;
  onClose: () => void;
}

type DragTarget = 'start' | 'end' | 'play' | null;

function openVideoEditor(url: string, name: string, opts: EditorOptions = {}) {
  const modal = openModal({
    title: '视频剪辑',
    subtitle: name,
    size: 'lg',
    content: <VideoEditor url={url} name={name} {...opts} onClose={() => modal.close()} />,
  });
  return modal;
}

export { openVideoEditor };

function VideoEditor({ url, name, onMade, reload, onClose }: EditorProps) {
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

  // 让预览画面跳到某个时间点，选边界时画面跟手，看得到每一刀落在哪。
  const seekTo = (sec: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = sec;
    setPlayhead(sec);
  };

  // 现有分段之外还空着的时间段。分段不允许互相覆盖，选区只能落在这些空位里。
  const freeGaps = (list: Segment[]): [number, number][] => {
    const out: [number, number][] = [];
    let cur = 0;
    for (const s of [...list].sort((a, b) => a.start - b.start)) {
      if (s.start > cur) out.push([cur, s.start]);
      cur = Math.max(cur, s.end);
    }
    if (duration > cur) out.push([cur, duration]);
    return out;
  };

  // 把目标时间点收进离它最近的空位，并夹在 [lo, hi]（另一端不能被越过）。
  const clampToFree = (t: number, lo: number, hi: number, list: Segment[]) => {
    const range = freeGaps(list)
      .map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)] as [number, number])
      .filter(([a, b]) => b - a > 0.05);
    if (!range.length) return Math.min(Math.max(t, lo), hi);
    const hit = range.find(([a, b]) => t >= a && t <= b);
    if (hit) return t;
    let best = range[0];
    let bestD = Infinity;
    for (const [a, b] of range) {
      const d = t < a ? a - t : t > b ? t - b : 0;
      if (d < bestD) {
        bestD = d;
        best = [a, b];
      }
    }
    return t < best[0] ? best[0] : Math.min(t, best[1]);
  };

  // 和已有分段重叠 = 覆盖了别人，不允许。
  const overlapsExisting = (a: number, b: number) => segments.some((s) => a < s.end - 1e-6 && b > s.start + 1e-6);

  const onPointerDown = (target: DragTarget) => (e: React.PointerEvent) => {
    e.preventDefault();
    drag.current = target;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    // 拖动手柄/播放头时停住播放，边界画面跟手。
    videoRef.current?.pause();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current || !duration) return;
    const raw = secFromEvent(e.clientX);
    if (drag.current === 'play') {
      seekTo(raw);
    } else if (drag.current === 'start') {
      const sec = clampToFree(raw, 0, end - 0.1, segments);
      setStart(sec);
      seekTo(sec);
    } else if (drag.current === 'end') {
      const sec = clampToFree(raw, start + 0.1, duration, segments);
      setEnd(sec);
      seekTo(sec);
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
    seekTo(secFromEvent(e.clientX));
  };

  const addSegment = () => {
    if (end - start < 0.1) {
      toast('选区太短，无法添加分段', 'error');
      return;
    }
    if (overlapsExisting(start, end)) {
      toast('分段不能互相覆盖：请选一段没被占用的范围', 'error');
      return;
    }
    const newSeg: Segment = { id: `s${Date.now()}`, start, end, name: `${baseName}_${segments.length + 1}.mp4` };
    const nextList = [...segments, newSeg];
    setSegments(nextList);
    // 选区挪到下一段空位：优先贴着刚加的分段往后排，不行就找任意一个够长的空位。
    const gaps = freeGaps(nextList);
    const gap = gaps.find(([a, b]) => Math.abs(a - end) < 1e-6 && b - a >= 0.1) || gaps.find((g) => g[1] - g[0] >= 0.1);
    if (gap) {
      setStart(gap[0]);
      setEnd(gap[1]);
      seekTo(gap[0]);
    }
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
      const made: Made[] = [];
      for (const { segment, blob } of results) {
        const f = new File([blob], segment.name, { type: 'video/mp4' });
        try {
          const saved = await uploadLocalFile(f, 'video', () => {});
          made.push({ url: saved.url, name: saved.name || segment.name });
        } catch (err) {
          toast(`「${segment.name}」上传失败：${(err as Error).message}`, 'error', 6000);
        }
      }
      if (!made.length) {
        toast('剪辑失败：没有片段保存成功', 'error', 7000);
        return;
      }
      if (onMade) {
        // 画布里剪的：片段变成新的视频节点摆在右边，做完就把窗口关掉，让看到的是画布上的结果。
        onMade(made);
        toast(`剪辑完成，${made.length} 段已放到画布上`, 'success', 5000);
        onClose();
      } else {
        toast(`剪辑完成，已保存 ${made.length}/${results.length} 段到素材库`, 'success', 6000);
        reload?.();
      }
    } catch (err) {
      toast(`剪辑失败：${errText(err)}`, 'error', 7000);
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
      <p className="muted small">拖动两端手柄选段（预览画面会跟着跳到边界帧）；分段之间不允许重叠，选区会自动避开已有分段。点分段行可预览该段开头。</p>

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
        <span>播放头 {fmtClock(playhead)}</span>
        <span>入点 {fmtClock(start)}</span>
        <span>出点 {fmtClock(end)}</span>
        <span>当前选区 {fmtClock(Math.max(0, end - start))}</span>
      </div>

      <div className="ve-actions">
        <button
          className="btn btn-sm"
          type="button"
          disabled={busy}
          onClick={() => {
            const sec = clampToFree(playhead, 0, end - 0.1, segments);
            setStart(sec);
            seekTo(sec);
          }}
        >
          设为入点
        </button>
        <button
          className="btn btn-sm"
          type="button"
          disabled={busy}
          onClick={() => {
            const sec = clampToFree(playhead, start + 0.1, duration, segments);
            setEnd(sec);
            seekTo(sec);
          }}
        >
          设为出点
        </button>
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
            <div className="ve-seg-row" key={s.id} title="点击预览该段开头" style={{ cursor: 'pointer' }} onClick={() => seekTo(s.start)}>
              <span className="ve-seg-idx">{i + 1}</span>
              <input
                className="input input-sm ve-seg-name"
                value={s.name}
                disabled={busy}
                onChange={(e) => setSegments((list) => list.map((x) => (x.id === s.id ? { ...x, name: e.target.value } : x)))}
              />
              <span className="muted small">{fmtClock(s.start)} → {fmtClock(s.end)}（{fmtClock(s.end - s.start)}）</span>
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
          {busy ? '处理中…' : onMade ? `导出 ${segments.length} 段到画布` : `导出 ${segments.length} 段`}
        </button>
      </div>
    </div>
  );
}
