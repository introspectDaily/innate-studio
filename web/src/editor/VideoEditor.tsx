// 视频剪辑器：在浏览器里把一段视频裁剪成多段，也能随手截下若干静帧。
// 片段走 web/src/editor/ffmpeg.ts（ffmpeg.wasm），静帧走 web/src/editor/frames.ts（canvas，不用 wasm，很快）。
// 产物都通过现有 /api/uploads 落盘：画布拿去做成新节点，素材库则刷新列表。
// 数据模型已预留「拼接 / 转场 / 音画分离」，后续加 UI 即可，不用换引擎。

import { useEffect, useRef, useState } from 'react';
import { openModal, toast } from '../ui/layers.tsx';
import { Icon } from '../ui/Icon.tsx';
import { fmtClock } from '../format.ts';
import { uploadLocalFile } from '../media.ts';
import { trimSegments, errText, type Segment } from './ffmpeg.ts';
import { shootFrame } from './frames.ts';
import type { Made } from '../canvas/edit.tsx';

// 剪出来的片段、截下来的静帧交给谁：
//   onMade — 画布在用，产物在源节点右边变成新节点（片段是视频节点，静帧是图片节点），能继续参与生成流程；
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

// 一张待导出的静帧。只存时间点和预览图，真正导出时再去视频上抠画面——
// PNG 一张可能好几 MB，先存在内存里不值当。
interface Frame {
  id: string;
  time: number; // 秒
  name: string;
  thumb: string; // 小尺寸 jpeg dataURL
}

type DragTarget = 'start' | 'end' | 'play' | null;

// 帧要精确到 0.1 秒才看得出区别，fmtClock 只到秒，这里补一位。
const fmtStamp = (sec: number) => `${fmtClock(sec)}.${Math.min(9, Math.floor((sec % 1) * 10))}`;

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
  const [frames, setFrames] = useState<Frame[]>([]);
  const [reencode, setReencode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [engineLoading, setEngineLoading] = useState(false);
  const [progress, setProgress] = useState<{ label: string; ratio: number }>({ label: '', ratio: 0 });

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

  // 截下播放头现在停的那一帧。截帧不碰 ffmpeg，是画布直接拷画面，所以很快，可以连着截好几张。
  const captureCurrent = async () => {
    const video = videoRef.current;
    if (!video || !duration) return;
    const at = Math.min(Math.max(0, playhead), Math.max(0, duration - 0.05));
    if (frames.some((f) => Math.abs(f.time - at) < 0.05)) {
      toast('这个位置已经截过了，把播放头挪一下再截', 'info');
      return;
    }
    video.pause();
    setCapturing(true);
    try {
      const shot = await shootFrame(video, at);
      setFrames((list) => [...list, { id: `f${Date.now()}`, time: at, thumb: shot.thumb, name: `${baseName}_帧${list.length + 1}.png` }]);
      setPlayhead(at);
    } catch (err) {
      toast(`截帧失败：${errText(err)}`, 'error', 6000);
    } finally {
      setCapturing(false);
    }
  };

  const removeFrame = (id: string) => setFrames((list) => list.filter((f) => f.id !== id));

  // 片段和静帧一起导出：先切片段（要等引擎），再逐帧抠画面。哪一份失败都不影响其他份。
  const exportAll = async () => {
    if (!segments.length && !frames.length) {
      toast('请先添加分段或截取至少一帧', 'error');
      return;
    }
    setBusy(true);
    let videos = 0;
    let images = 0;
    const made: Made[] = [];
    try {
      if (segments.length) {
        setEngineLoading(true);
        const file = await (await fetch(url)).blob();
        setEngineLoading(false);
        const results = await trimSegments(file, segments, {
          reencode,
          onProgress: (index, ratio) => setProgress({ label: `第 ${index + 1}/${segments.length} 段`, ratio }),
        });
        for (const { segment, blob } of results) {
          try {
            const saved = await uploadLocalFile(new File([blob], segment.name, { type: 'video/mp4' }), 'video', () => {});
            made.push({ url: saved.url, name: saved.name || segment.name, kind: 'video' });
            videos++;
          } catch (err) {
            toast(`「${segment.name}」上传失败：${(err as Error).message}`, 'error', 6000);
          }
        }
      }

      // 静帧用预览窗口那个 video 来抠：画面会跟着跳到每一帧的位置，用户看得见截的是哪一帧。
      const video = videoRef.current;
      if (video) video.pause();
      for (const [index, frame] of frames.entries()) {
        if (!video) break;
        setProgress({ label: `第 ${index + 1}/${frames.length} 帧`, ratio: 0 });
        try {
          const shot = await shootFrame(video, frame.time);
          setPlayhead(frame.time);
          const fileName = /\.(png|jpe?g)$/i.test(frame.name) ? frame.name : `${frame.name}.png`;
          const saved = await uploadLocalFile(new File([shot.blob], fileName, { type: 'image/png' }), 'image', () => {});
          made.push({ url: saved.url, name: saved.name || fileName, kind: 'image' });
          images++;
        } catch (err) {
          toast(`「${frame.name}」截帧失败：${errText(err)}`, 'error', 6000);
        }
      }

      if (!made.length) {
        toast('导出失败：没有产物保存成功', 'error', 7000);
        return;
      }
      const summary = [videos ? `${videos} 段视频` : '', images ? `${images} 帧` : ''].filter(Boolean).join('、');
      if (onMade) {
        // 画布里剪的：产物变成新节点摆在右边，做完就把窗口关掉，让看到的是画布上的结果。
        onMade(made);
        toast(`导出完成，${summary}已放到画布上`, 'success', 5000);
        onClose();
      } else {
        toast(`导出完成，${summary}已保存到素材库`, 'success', 6000);
        reload?.();
      }
    } catch (err) {
      toast(`导出失败：${errText(err)}`, 'error', 7000);
    } finally {
      setBusy(false);
      setEngineLoading(false);
      setProgress({ label: '', ratio: 0 });
    }
  };

  const startPct = duration ? (start / duration) * 100 : 0;
  const endPct = duration ? (end / duration) * 100 : 0;
  const headPct = duration ? (playhead / duration) * 100 : 0;
  const counts = [segments.length ? `${segments.length} 段` : '', frames.length ? `${frames.length} 帧` : ''].filter(Boolean);
  const exportLabel = busy ? '处理中…' : counts.length ? `导出 ${counts.join(' + ')}${onMade ? '到画布' : ''}` : '导出';
  const total = segments.length + frames.length;

  return (
    <div className="ve">
      <video ref={videoRef} src={url} className="ve-preview" controls playsInline preload="metadata" />
      <p className="muted small">拖动两端手柄选段（预览画面会跟着跳到边界帧）；分段之间不允许重叠，选区会自动避开已有分段。把播放头停到想要的那一刻点「截取当前帧」，可以连着截好几帧，最后一并导出成图片。</p>

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
        {frames.map((f) => (
          <div key={f.id} className="ve-frame-mark" style={{ left: `${(f.time / (duration || 1)) * 100}%` }} title={`静帧 ${fmtStamp(f.time)}`} />
        ))}
        <div className="ve-selection" style={{ left: `${startPct}%`, width: `${endPct - startPct}%` }} />
        <div className="ve-handle ve-handle-start" style={{ left: `${startPct}%` }} onPointerDown={onPointerDown('start')} />
        <div className="ve-handle ve-handle-end" style={{ left: `${endPct}%` }} onPointerDown={onPointerDown('end')} />
        <div className="ve-playhead" style={{ left: `${headPct}%` }} onPointerDown={onPointerDown('play')} />
      </div>

      <div className="ve-readout">
        <span>播放头 {fmtStamp(playhead)}</span>
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
        <button className="btn btn-sm" type="button" disabled={busy || capturing || !duration} onClick={captureCurrent}>
          {capturing ? '截取中…' : '截取当前帧'}
        </button>
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

      {frames.length > 0 && (
        <div className="ve-frames">
          <div className="ve-frames-head">
            <span className="muted small">静帧 {frames.length} 张 · 点缩略图定位，导出一并保存成 PNG</span>
            <button className="btn btn-sm" type="button" disabled={busy} onClick={() => setFrames([])}>清空</button>
          </div>
          <div className="ve-frame-grid">
            {frames.map((f, i) => (
              <div className="ve-frame" key={f.id}>
                <button className="ve-frame-thumb" type="button" title={`定位到 ${fmtStamp(f.time)}`} onClick={() => seekTo(f.time)}>
                  <img src={f.thumb} alt="" />
                  <span className="ve-frame-badge">{i + 1}</span>
                  <span className="ve-frame-time">{fmtStamp(f.time)}</span>
                </button>
                <button className="ve-frame-del" type="button" title="删掉这张" disabled={busy} onClick={() => removeFrame(f.id)}>
                  <Icon name="x" size={12} />
                </button>
                <input
                  className="input input-sm"
                  value={f.name}
                  disabled={busy}
                  onChange={(e) => setFrames((list) => list.map((x) => (x.id === f.id ? { ...x, name: e.target.value } : x)))}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="modal-actions">
        {busy && (
          <span className="muted small">
            {engineLoading
              ? '正在加载剪辑引擎（首次约 30MB）…'
              : `导出中：${progress.label}${progress.ratio ? ` ${Math.round(progress.ratio * 100)}%` : ''}（共 ${total} 份）`}
          </span>
        )}
        <button className="btn btn-primary" type="button" disabled={busy || !total} onClick={exportAll}>
          {exportLabel}
        </button>
      </div>
    </div>
  );
}
