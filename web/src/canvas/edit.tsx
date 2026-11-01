// 不用模型、在浏览器里就能做完的几种处理：裁剪图片、把宫格图切开、从视频里截一帧。
// 结果都是一张新图片，传到本机之后变成新的图片节点，原来的节点不动。

import { useEffect, useRef, useState } from 'react';
import { uploadLocalFile } from '../media.ts';
import { loadVideo, shootFrame } from '../editor/frames.ts';
import { Segmented } from '../ui/controls.tsx';

export interface Made {
  url: string;
  name: string;
  // 产物是图还是视频。剪辑器一次可能既有片段又有静帧，画布按这个分别建节点；不写就按调用方给的默认类。
  kind?: 'image' | 'video';
}

const loadImage = (url: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = url;
  });

// 把一块画面存成 PNG 传到本机。source 是图片或者视频当前这一帧。
async function save(source: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, name: string): Promise<Made> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw));
  canvas.height = Math.max(1, Math.round(sh));
  canvas.getContext('2d')!.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('画面导出失败');
  const ref = await uploadLocalFile(new File([blob], `${name}.png`, { type: 'image/png' }), 'image');
  return { url: ref.url, name };
}

// 裁出图片的一块。area 是这一块在原图里的位置，按原图的像素算。
export async function cropImage(url: string, area: { x: number; y: number; width: number; height: number }, name: string) {
  return save(await loadImage(url), area.x, area.y, area.width, area.height, name);
}

// 把一张宫格图切成 size × size 张，从左到右、从上到下。
export async function splitGrid(url: string, size: number, name: string) {
  const img = await loadImage(url);
  const w = img.naturalWidth / size;
  const h = img.naturalHeight / size;
  const made: Made[] = [];
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) made.push(await save(img, col * w, row * h, w, h, `${name}-${row * size + col + 1}`));
  return made;
}

// 从视频里截一帧。at 是第几秒；'last' 是最后一帧。
// 取画面的活交给 editor/frames.ts（剪辑器也用同一套），这里只负责落盘。
export async function grabFrame(url: string, at: number | 'last', name: string): Promise<Made> {
  const video = await loadVideo(url);
  try {
    const shot = await shootFrame(video, at);
    const ref = await uploadLocalFile(new File([shot.blob], `${name}.png`, { type: 'image/png' }), 'image');
    return { url: ref.url, name, kind: 'image' };
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

// 扩图的底图：把画布放大到 ratio 这个宽高比，原图原大放在正中间，多出来的地方填成灰色，交给模型去补。
// 已经是这个比例（差不到 2%）就不用扩，返回 null。
export async function padImage(url: string, ratio: number, name: string): Promise<Made | null> {
  const img = await loadImage(url);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (Math.abs(w / h / ratio - 1) < 0.02) return null;
  const width = w / h < ratio ? Math.round(h * ratio) : w;
  const height = w / h < ratio ? h : Math.round(w / ratio);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, Math.round((width - w) / 2), Math.round((height - h) / 2));
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('底图生成失败');
  const ref = await uploadLocalFile(new File([blob], `${name}.png`, { type: 'image/png' }), 'image');
  return { url: ref.url, name };
}

// ---------- 裁剪 ----------

const RATIOS = [
  { value: 'free', label: '自由' },
  { value: '1:1', label: '1:1' },
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
  { value: '4:3', label: '4:3' },
  { value: '3:4', label: '3:4' },
];
type Box = { x: number; y: number; width: number; height: number };
const MIN = 0.05;

// 裁剪框按图片的比例记（0 到 1），这样图片显示成多大都一样。
// 拖框里面是挪动，拖四个角是改大小；选了比例之后大小只能按这个比例变。
export function Cropper({ url, onDone, onCancel }: { url: string; onDone: (area: Box) => void; onCancel: () => void }) {
  const [ratio, setRatio] = useState('free');
  const [box, setBox] = useState<Box>({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  // 选的比例换算成框的宽高比（框的宽高是按图片的宽高各自归一的，所以要除以图片自己的比例）。
  const locked = ratio === 'free' || !size ? 0 : (Number(ratio.split(':')[0]) / Number(ratio.split(':')[1]) / (size.w / size.h));

  // 换了比例：框改成这个比例里能放下的最大的一块，居中。
  useEffect(() => {
    if (!locked) return;
    const width = Math.min(1, locked);
    const height = width / locked;
    setBox({ x: (1 - width) / 2, y: (1 - height) / 2, width, height });
  }, [locked]);

  function drag(e: React.PointerEvent, corner?: 'nw' | 'ne' | 'sw' | 'se') {
    e.preventDefault();
    e.stopPropagation();
    const area = frame.current!.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, box };
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / area.width;
      const dy = (ev.clientY - start.y) / area.height;
      const b = start.box;
      if (!corner) return setBox({ ...b, x: Math.min(1 - b.width, Math.max(0, b.x + dx)), y: Math.min(1 - b.height, Math.max(0, b.y + dy)) });
      // 拖的那个角对面的角不动。
      const fixX = corner.includes('w') ? b.x + b.width : b.x;
      const fixY = corner.includes('n') ? b.y + b.height : b.y;
      let width = Math.max(MIN, corner.includes('w') ? Math.min(fixX, b.width - dx) : Math.min(1 - fixX, b.width + dx));
      let height = Math.max(MIN, corner.includes('n') ? Math.min(fixY, b.height - dy) : Math.min(1 - fixY, b.height + dy));
      if (locked) {
        // 按比例收：宽和高里取放得下的那个。
        const roomW = corner.includes('w') ? fixX : 1 - fixX;
        const roomH = corner.includes('n') ? fixY : 1 - fixY;
        width = Math.min(width, roomW, roomH * locked);
        height = width / locked;
      }
      setBox({ x: corner.includes('w') ? fixX - width : fixX, y: corner.includes('n') ? fixY - height : fixY, width, height });
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  }

  const pct = (n: number) => `${n * 100}%`;
  return (
    <div className="ccrop">
      <div className="ccrop-stage">
        <div ref={frame} className="ccrop-frame">
          <img src={url} alt="" draggable={false} onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
          <div className="ccrop-box" style={{ left: pct(box.x), top: pct(box.y), width: pct(box.width), height: pct(box.height) }} onPointerDown={(e) => drag(e)}>
            {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
              <span key={corner} className={`ccrop-handle is-${corner}`} onPointerDown={(e) => drag(e, corner)} />
            ))}
          </div>
        </div>
      </div>
      <div className="ccrop-bar">
        <Segmented options={RATIOS} value={ratio} onChange={setRatio} />
        <span className="ccrop-size">{size ? `${Math.round(box.width * size.w)} × ${Math.round(box.height * size.h)}` : ''}</span>
        <button className="btn" type="button" onClick={onCancel}>
          取消
        </button>
        <button className="btn btn-primary" type="button" disabled={!size} onClick={() => size && onDone({ x: box.x * size.w, y: box.y * size.h, width: box.width * size.w, height: box.height * size.h })}>
          裁剪
        </button>
      </div>
    </div>
  );
}
