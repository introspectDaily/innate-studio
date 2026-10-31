// 一张画布：可以无限平移缩放的桌面，上面摆节点、拉连线。打开时整个窗口都是它，改动之后自动保存。

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Background, BackgroundVariant, MiniMap, Panel, Position, ReactFlow, ReactFlowProvider, SelectionMode, ViewportPortal, getBezierPath, useEdgesState, useNodesState, useReactFlow, useStoreApi, useViewport, type Connection, type Edge, type Node, type NodeChange, type OnConnectEnd, type Viewport } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api, canvasPath, useStore, KINDS as MEDIA } from '../store.ts';
import { composer, imageRefLimit } from '../composer/state.ts';
import { kindOfFile, uploadLocalFile } from '../media.ts';
import { Icon, type IconName } from '../ui/Icon.tsx';
import { tip } from '../ui/controls.tsx';
import { openMenu, openPopover, promptName, toast } from '../ui/layers.tsx';
import { reducedMotion } from '../ui/motion.ts';
import type { HistoryItem } from '../types.ts';
import { BOX_HEIGHT, NODE_LABELS, TITLE_ROOM, canLink, MAX_STACK, PINS, PIN_LABELS, alignNodes, clipOf, distributeNodes, groupFrame, isGroup, isStack, nodeWidth, numbered, pasteClip, runOrder, snapTo, sourcesOf, stripNodeData, targetsOf, tidy, type AlignDirection, type Clip, type FrameRole, type GroupData, type Guide, type LinkData, type NodeKind, type Pin, type Rect } from './model.ts';
import { confirmRun, coverOf, generate, newNodeData, outputOf, recordOf } from './run.ts';
import { AudioNode, CanvasActions, DragLine, GroupNode, ImageNode, LinkEdge, NODE_ICONS, StackNode, TextNode, VideoNode } from './nodes.tsx';
import { Finder, HistoryPicker, WorkflowPicker } from './panels.tsx';
import { grabFrame } from './edit.tsx';

interface Doc {
  id: string;
  name: string;
  nodes: Node[];
  edges: Edge[];
  viewport: Viewport | null;
}
interface Snap {
  nodes: Node[];
  edges: Edge[];
}

const nodeTypes = { text: TextNode, image: ImageNode, video: VideoNode, audio: AudioNode, group: GroupNode, stack: StackNode };
const edgeTypes = { link: LinkEdge };
const KINDS: NodeKind[] = ['text', 'image', 'video', 'audio'];
// 画布上能上传的文件。音频只收 MP3 和 WAV。
const UPLOAD_ACCEPT = 'image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm,audio/mpeg,audio/wav,.mp3,.wav';
const SAVE_DELAY_MS = 600;
const MAX_UNDO = 50;
// 复制的节点放进系统剪贴板时用的类型。换一张画布、换一个标签页也能粘贴。
const CLIP_TYPE = 'application/x-innate-canvas';
// 最近一次复制的内容，右键菜单里的「粘贴」用它（网页不能随便读系统剪贴板）。
let copied: Clip | null = null;
// 选中节点时下方输入面板大约占多高（屏幕上的像素）。把新节点挪进视野时给它留出位置。
const PANEL_ROOM = 240;
// 节点输入面板的宽度，和 styles.css 里的 .cnode-panel 一致。
const PANEL_WIDTH = 680;
// 拖动节点时，离别的节点的边线、中线多近就吸过去（屏幕上的像素）。
const SNAP_REACH = 6;
// 画布能缩放到多大、多小：10% 到 200%。
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2;
// 触控板捏合一格只有几个像素，鼠标滚轮一格是一百，差十倍，缩放要按各自的量级换算（和 React Flow 里一样）。
const MAC = /Macintosh|Mac OS X|iPhone|iPad/.test(navigator.userAgent);

// 一个节点的框在画布上占的位置，不算上面那行名字：对齐看的是框。
const membersOf = (node: Node) => (node.data as unknown as GroupData).members || [];

// 分组的框不存位置和大小，每次按成员现在占的范围算出来，垫在所有节点下面。成员都不在了就不画。
function framed(nodes: Node[]): Node[] {
  if (!nodes.some(isGroup)) return nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes.map((node) => {
    if (!isGroup(node)) return node;
    const frame = frameOf(node, byId);
    return frame ? { ...node, position: { x: frame.x, y: frame.y }, style: { width: frame.width, height: frame.height }, zIndex: -1, hidden: false } : { ...node, hidden: true };
  });
}
function frameOf(group: Node, byId: Map<string, Node>) {
  const rects = membersOf(group)
    .map((id) => byId.get(id))
    .filter((member): member is Node => Boolean(member) && !member!.hidden)
    .map((member) => ({ x: member.position.x, y: member.position.y, width: member.measured?.width || nodeWidth(member.type as NodeKind, member.data), height: TITLE_ROOM + BOX_HEIGHT }));
  return groupFrame(rects);
}

const boxOf = (node: Node, position = node.position): Rect => ({ x: position.x, y: position.y + TITLE_ROOM, width: node.measured?.width || nodeWidth(node.type as NodeKind, node.data), height: BOX_HEIGHT });

// 存进画布的只有节点的位置和内容、连线的两头和用途；选中状态、量出来的尺寸这些不存。
// 收在一叠里的节点是藏着的，这一点要存。
const savedNodes = (nodes: Node[]) => nodes.map(({ id, type, position, data, hidden }) => ({ id, type, position, data: stripNodeData(data), ...(hidden ? { hidden: true } : {}) }));
const savedEdges = (edges: Edge[]) => edges.map(({ id, source, target, data }) => ({ id, source, target, type: 'link', data }));

function makeEdge(source: Node, target: Node, role?: FrameRole): Edge {
  const data: LinkData = { kind: source.type as NodeKind };
  // 图片连到视频默认当参考图。指定了用途（首帧、尾帧等）就按指定的来。连到图片的都是参考图，不分用途。
  if (data.kind === 'image' && target.type === 'video') data.role = role || 'reference';
  return { id: crypto.randomUUID(), source: source.id, target: target.id, type: 'link', data: data as unknown as Record<string, unknown> };
}

function Board({ id, onExit }: { id: string; onExit: () => void }) {
  const flow = useReactFlow();
  const store = useStoreApi();
  const { zoom } = useViewport();
  // 名字、加号这些在屏幕上大小不变，靠这个倒数把画布的缩放抵消掉；最多放大到 2 倍。
  const inv = Math.min(1 / zoom, 2);
  const [ready, setReady] = useState(false);
  const [name, setName] = useState('');
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [moved, setMoved] = useState(0);
  const [showMap, setShowMap] = useState(false);
  // 抓手：开着的时候左键拖动是平移画布，节点点不中也拖不动。
  const [hand, setHand] = useState(false);
  const [finding, setFinding] = useState(false);
  const [guides, setGuides] = useState<Guide[]>([]);
  // 拉线松在空白处之后留在原地的那条线（画布坐标）：菜单开着的时候它一直在，选了节点或者关掉菜单才收。
  const [loose, setLoose] = useState<{ fromX: number; fromY: number; toX: number; toY: number; downstream: boolean } | null>(null);
  // 保存到哪一步了：saved 已保存，saving 有改动还没存上，failed 没存上（点一下重试）。
  const [saving, setSaving] = useState<'saved' | 'saving' | 'failed'>('saved');
  // 正被拖着、在吸附的那个节点。
  const snapping = useRef('');
  const [, setUndoDepth] = useState(0);
  // 生成完成之后封面可能要换，所以生成记录变了也要重新算一遍要存的内容。
  const records = useStore('history', 'app');
  const wrap = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const file = useRef<HTMLInputElement>(null);
  // 从右键菜单点的上传：文件选好之后节点落在点右键的位置。
  const dropAt = useRef<{ x: number; y: number } | undefined>(undefined);
  const past = useRef<Snap[]>([]);
  const future = useRef<Snap[]>([]);
  // 刚按住节点时画布的样子：真的拖动了才放进撤销里。
  const grabbed = useRef<Snap | null>(null);
  const lastSaved = useRef('');
  const pending = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const started = useRef(false);
  // 鼠标最近在画布上的位置，粘贴时内容落在这里。
  const pointer = useRef<{ x: number; y: number } | null>(null);

  // ---------- 读取和保存 ----------

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    const body = pending.current;
    pending.current = '';
    if (!body) return;
    try {
      await api('PUT', `/api/canvases/${id}`, JSON.parse(body));
      lastSaved.current = body;
      // 存的这会儿又有了新改动，就还算没存完。
      if (!pending.current) setSaving('saved');
    } catch (err) {
      // 没存上的这一份留着，点「没存上」或者再有改动时重发。
      if (!pending.current) pending.current = body;
      setSaving('failed');
      toast(`保存失败：${(err as Error).message}`, 'error', 6000);
    }
  }, [id]);

  useEffect(() => {
    // 开发模式下这个 effect 会跑两遍，只读一次。
    if (started.current) return;
    started.current = true;
    api<Doc>('GET', `/api/canvases/${id}`)
      .then((doc) => {
        // 以前存的节点没有编号，打开时补上。
        setNodes(numbered(doc.nodes || []));
        setEdges((doc.edges || []).map((edge) => ({ ...edge, type: 'link' })));
        setName(doc.name);
        setReady(true);
        // 等节点画出来再定位：存过视口就回到那里，没存过就把内容放进视野。
        // 空画布不用定位：这时调 fitView 会一直等到有了第一个节点才生效，把刚加的节点连同视野一起挪走。
        requestAnimationFrame(() => {
          if (doc.viewport) flow.setViewport(doc.viewport);
          else if (doc.nodes?.length) flow.fitView({ maxZoom: 1, padding: 0.2 });
        });
      })
      .catch((err) => {
        toast(`画布加载失败：${(err as Error).message}`, 'error', 6000);
        onExit();
      });
  }, [flow, id, onExit, setEdges, setNodes]);

  // 内容、名字、视口或封面变了，过一会儿自动存。和上次存的一样就不发请求（选中、悬停这些变化不算）。
  useEffect(() => {
    if (!ready) return;
    const body = JSON.stringify({ name, nodes: savedNodes(nodes), edges: savedEdges(edges), viewport: flow.getViewport(), cover: coverOf(nodes) });
    if (!lastSaved.current) {
      lastSaved.current = body;
      return;
    }
    if (body === lastSaved.current) return;
    pending.current = body;
    setSaving('saving');
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DELAY_MS);
  }, [ready, name, nodes, edges, moved, records, flow, flush]);

  // 关掉或刷新页面之前把没存的发出去。
  useEffect(() => {
    const save = () => {
      if (pending.current) fetch(`/api/canvases/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: pending.current, keepalive: true });
    };
    window.addEventListener('pagehide', save);
    return () => window.removeEventListener('pagehide', save);
  }, [id]);

  const exit = useCallback(async () => {
    await flush();
    onExit();
  }, [flush, onExit]);

  // ---------- 撤销、重做 ----------
  // 只管结构：有哪些节点、摆在哪、怎么连。节点里写的字和生成的结果不跟着退回去。

  const snap = useCallback(() => {
    past.current.push({ nodes: flow.getNodes(), edges: flow.getEdges() });
    if (past.current.length > MAX_UNDO) past.current.shift();
    future.current = [];
    setUndoDepth((n) => n + 1);
  }, [flow]);

  const travel = useCallback(
    (from: Snap[], to: Snap[]) => {
      const target = from.pop();
      if (!target) return;
      const now = flow.getNodes();
      to.push({ nodes: now, edges: flow.getEdges() });
      const live = new Map(now.map((node) => [node.id, node.data]));
      setNodes(target.nodes.map((node) => ({ ...node, selected: false, data: live.get(node.id) || stripNodeData(node.data) })));
      setEdges(target.edges.map((edge) => ({ ...edge, selected: false })));
      setUndoDepth((n) => n + 1);
    },
    [flow, setEdges, setNodes],
  );
  const undo = useCallback(() => travel(past.current, future.current), [travel]);
  const redo = useCallback(() => travel(future.current, past.current), [travel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'z' || !(e.metaKey || e.ctrlKey) || !wrap.current?.offsetParent) return;
      const el = e.target as HTMLElement;
      // 正在打字时把撤销留给文本框；有弹窗盖着时也不动画布。
      if (el.closest('input, textarea, [contenteditable]') || (el !== document.body && !wrap.current.contains(el))) return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // ---------- 缩放 ----------

  // 视频、音频的画面和输入面板带着 nowheel（在上面滚动不要挪画布），React Flow 见到这个类名就把整条滚轮手势丢掉：
  // 它只替我们把页面的缩放挡掉了，画布自己也不动。结果鼠标停在视频节点上捏合、或者按着 ⌘ 滚轮，都没反应。
  // 这里把漏掉的这一段补上，围着鼠标缩放，力度和空白处一样。
  useEffect(() => {
    const pane = wrap.current;
    if (!pane) return;
    const onWheel = (e: WheelEvent) => {
      // 缩放的两种按法：触控板捏合，浏览器给的是 ctrl + wheel；按着 ⌘（Windows 上是 Ctrl）再滚。
      // ⌘ 在事件里是 metaKey，不是 ctrlKey，两种都要认，否则按着 ⌘ 滚轮还是没反应。
      if (!(e.ctrlKey || e.metaKey) || !(e.target as Element).closest('.nowheel')) return;
      // 这一下就留在这里：页面的缩放、React Flow 的滚轮都不用再处理一遍。
      e.preventDefault();
      e.stopPropagation();
      const box = pane.getBoundingClientRect();
      const { x, y, zoom } = flow.getViewport();
      // 鼠标底下那一点在画布上的坐标。缩完之后它仍停在鼠标下面，看起来就是围着鼠标放大。
      const wx = (e.clientX - box.left - x) / zoom;
      const wy = (e.clientY - box.top - y) / zoom;
      // 一格乘一个固定的倍数：连着捏是累乘的，不会一格就跳到底。
      // 触控板捏合的一格只有几个像素，按十倍的力道换算；⌘ + 滚轮一格是一百，不乘（React Flow 里也是这么分的）。
      const step = -e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002) * (e.ctrlKey && MAC ? 10 : 1);
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * 2 ** step));
      if (next === zoom) return;
      flow.setViewport({ x: e.clientX - box.left - wx * next, y: e.clientY - box.top - wy * next, zoom: next });
    };
    // 在捕获阶段接住：React Flow 的滚轮挂在里面那层 pane 上，冒泡了就轮不到这里。
    pane.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => pane.removeEventListener('wheel', onWheel, { capture: true });
  }, [flow]);

  // ---------- 加节点、连线 ----------

  // 新加的节点要是落在窗口外面，或者它下方的输入面板露不全，就把视野平移过去；本来就看得全的不动。
  const reveal = useCallback(
    (position: { x: number; y: number }, width: number) => {
      const box = wrap.current!.getBoundingClientRect();
      const { x, y, zoom } = flow.getViewport();
      const left = position.x * zoom + x;
      const top = position.y * zoom + y;
      const height = (BOX_HEIGHT + TITLE_ROOM) * zoom;
      // 只挪刚好够的距离，原来在看的内容尽量留在视野里。左边要让开工具栏，上边要让开项目名和节点的操作条。
      // 输入面板不跟着缩放，固定 680 宽、在节点下面居中，比窄的节点宽：左右要按两者里更宽的那个算，不然发送键会露在窗口外面。
      const center = left + (width * zoom) / 2;
      const half = Math.max((width * zoom) / 2, Math.min(PANEL_WIDTH, box.width - 48) / 2);
      const nodeLeft = center - half;
      const right = center + half;
      const bottom = top + height + PANEL_ROOM;
      const dx = nodeLeft < 96 ? 96 - nodeLeft : right > box.width - 24 ? Math.max(box.width - 24 - right, 96 - nodeLeft) : 0;
      const dy = top < 96 ? 96 - top : bottom > box.height - 24 ? Math.max(box.height - 24 - bottom, 96 - top) : 0;
      if (dx || dy) flow.setViewport({ x: x + dx, y: y + dy, zoom }, { duration: reducedMotion() ? 0 : 280 });
    },
    [flow],
  );

  // 选着的节点变宽了（图片、视频出了结果，按画面的比例重新定宽），输入面板跟着往右挪，可能又露到窗口外面：再看一次。
  // 只管同一个节点自己变宽；换了选中的节点、拖动、缩放视野都不算，免得视野自己乱动。
  const shaped = useRef<{ id: string; width: number } | null>(null);
  useEffect(() => {
    const picked = nodes.filter((n) => n.selected);
    const node = picked.length === 1 ? picked[0] : null;
    const width = node?.measured?.width;
    const last = shaped.current;
    shaped.current = node && width ? { id: node.id, width } : null;
    if (node && width && last?.id === node.id && width > last.width + 1 && !isGroup(node)) reveal(node.position, width);
  }, [nodes, reveal]);

  // link 是新节点要和哪个节点连上：from 是它的上游，to 是它的下游。extra 是节点一出来就带着的内容：上传的文件、一条生成记录。
  const addNode = useCallback(
    (kind: NodeKind, at?: { x: number; y: number }, link?: { from?: Node; also?: Node[]; to?: Node }, extra?: Record<string, unknown>, role?: FrameRole) => {
      snap();
      const box = wrap.current!.getBoundingClientRect();
      const data = { ...newNodeData(kind, { form: composer.form, image: composer.studio.image, speech: composer.studio.speech }), ...(extra ? {} : { autofocus: true }), ...extra };
      const width = nodeWidth(kind, data as { aspect?: number });
      // 没指定位置就放在视野中间；那里已经有节点了就往右挪，直到不压着别的节点。
      const position = at || flow.screenToFlowPosition({ x: box.left + box.width / 2 - width / 2, y: box.top + box.height / 2 - 120 });
      // 节点宽窄不一，按量出来的宽度让开；还没量过的按它的内容算。
      for (let moved = true; !at && moved; ) {
        moved = false;
        for (const n of flow.getNodes()) {
          if (isGroup(n) || n.hidden) continue;
          const taken = n.measured?.width || nodeWidth(n.type as NodeKind, n.data);
          if (Math.abs(n.position.y - position.y) < 200 && position.x < n.position.x + taken + 60 && position.x + width + 60 > n.position.x) {
            position.x = n.position.x + taken + 80;
            moved = true;
          }
        }
      }
      const [node] = numbered([{ id: crypto.randomUUID(), type: kind, position, data, selected: true } as Node], flow.getNodes());
      setNodes((items) => [...items.map((n) => (n.selected ? { ...n, selected: false } : n)), node]);
      reveal(position, width);
      if (link?.from) {
        // also：同时选中的其他节点，接得上的也一起连进来。图片连图片要看新节点的模型收几张参考图。
        let room = kind === 'image' ? imageRefLimit((data as { model?: string }).model) : Infinity;
        const sources = [link.from, ...(link.also || [])].filter((source) => {
          if (!canLink(source.type as NodeKind, kind)) return false;
          if (source.type === 'image' && kind === 'image') return room-- > 0;
          return true;
        });
        setEdges((items) => [...items, ...sources.map((source) => makeEdge(source, node, role))]);
      }
      if (link?.to) setEdges((items) => [...items, makeEdge(node, link.to!, role)]);
    },
    [flow, reveal, setEdges, setNodes, snap],
  );

  // 在一个节点的左边加一个节点并连进它：输入面板里「添加参考素材」用。已经有节点的位置往下错开。
  const addInput = useCallback(
    (targetId: string, kind: NodeKind, extra?: Record<string, unknown>, role?: FrameRole) => {
      const target = flow.getNode(targetId);
      if (!target) return;
      const at = { x: target.position.x - 420, y: target.position.y };
      while (flow.getNodes().some((n) => Math.abs(n.position.x - at.x) < 300 && Math.abs(n.position.y - at.y) < 200)) at.y += 260;
      addNode(kind, at, { to: target }, extra, role);
    },
    [addNode, flow],
  );

  // 连线或添加节点的意图选项。
  interface IntentionOption {
    value: string;
    kind: NodeKind;
    label: string;
    note?: string;
    icon?: IconName;
    disabled?: boolean;
    title?: string;
    role?: FrameRole;
    extra?: Record<string, unknown>;
    onExecute?: (at: { x: number; y: number }) => Promise<void> | void;
  }

  // 在鼠标的位置弹出智能意图/节点菜单。菜单要贴着一个元素显示，这里用一个看不见的点。
  const menuAt = useCallback(
    (
      x: number,
      y: number,
      options: IntentionOption[],
      link?: { from?: Node; also?: Node[]; to?: Node },
      place?: { x: number; y: number },
      heading?: string,
      onClose?: () => void,
    ) => {
      const el = anchor.current!;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      // place 是新节点放哪；没给就放在菜单弹出的位置。
      const at = place || flow.screenToFlowPosition({ x, y });
      // 从线头接出来的节点，框的中线要对着线头：线是连到框的中间的。
      if (!place && link) at.y -= TITLE_ROOM + BOX_HEIGHT / 2;
      // 接在左边的节点，右边缘要落在松手的位置。
      const defaultKind = options[0]?.kind || 'image';
      if (link?.to && !place) at.x -= nodeWidth(defaultKind);
      openMenu(el, {
        label: heading || '添加节点',
        heading,
        items: options.map((opt) => ({
          value: opt.value,
          label: opt.label,
          note: opt.note,
          icon: opt.icon || NODE_ICONS[opt.kind],
          disabled: Boolean(opt.disabled),
          title: opt.title || null,
        })),
        onSelect: (value) => {
          const chosen = options.find((opt) => opt.value === value);
          if (!chosen) return;
          const targetAt = link?.to && !place ? { x: at.x + nodeWidth(defaultKind) - nodeWidth(chosen.kind), y: at.y } : at;
          if (chosen.onExecute) {
            chosen.onExecute(targetAt);
          } else {
            addNode(chosen.kind, targetAt, link, chosen.extra, chosen.role);
          }
        },
        onClose,
      });
    },
    [addNode, flow],
  );

  // 上传：图片、视频各变成一个带着这个文件的节点。at 是拖进来时松手的位置。
  const upload = useCallback(
    async (picked: File, at?: { x: number; y: number }) => {
      const kind = kindOfFile(picked);
      if (!kind) return toast('仅支持上传图片、视频和音频', 'info');
      toast(`正在上传${MEDIA[kind].label}…`, 'info', 1800);
      try {
        const ref = await uploadLocalFile(picked, kind);
        addNode(kind, at, undefined, { upload: { url: ref.url, name: ref.name } });
        return;
      } catch (err) {
        toast((err as Error).message, 'error', 6000);
      }
    },
    [addNode],
  );

  // ---------- 搜索、生成历史 ----------

  // 跳到一个节点：只选中它，把它挪到视野中间，闪一下。缩得太小看不清就放大到 60%。
  const jumpTo = useCallback(
    (nodeId: string) => {
      const node = flow.getNode(nodeId);
      if (!node) return;
      setFinding(false);
      setNodes((items) => items.map((n) => ({ ...n, selected: n.id === nodeId, className: n.id === nodeId ? 'is-found' : undefined })));
      const box = boxOf(node);
      flow.setCenter(box.x + box.width / 2, box.y + box.height / 2 + PANEL_ROOM / 4, { zoom: Math.max(flow.getZoom(), 0.6), duration: reducedMotion() ? 0 : 320 });
      setTimeout(() => setNodes((items) => items.map((n) => (n.className ? { ...n, className: undefined } : n))), 1400);
    },
    [flow, setNodes],
  );

  const hoverNode = useCallback(
    (nodeId: string | null) => {
      setNodes((items) => {
        let changed = false;
        const next = items.map((n) => {
          const isTarget = Boolean(nodeId && n.id === nodeId);
          const wasTarget = n.className === 'is-mention-hover';
          if (isTarget && !wasTarget) {
            changed = true;
            return { ...n, className: 'is-mention-hover' };
          }
          if (!isTarget && wasTarget) {
            changed = true;
            return { ...n, className: undefined };
          }
          return n;
        });
        return changed ? next : items;
      });
    },
    [setNodes],
  );

  // 把一条生成记录放回画布：一个带着这份结果的新节点，放在视野中间并选中。原来的提示词也带上。
  const restore = useCallback(
    (item: HistoryItem) => {
      const extra: Record<string, unknown> = { recordId: item.id, prompt: item.prompt || '' };
      if (item.kind === 'audio') extra.tool = item.tool === 'speech' ? 'speech' : 'sfx';
      addNode(item.kind, undefined, undefined, extra);
    },
    [addNode],
  );

  // 生成历史、工作流这两块浮层出在工具栏的右边、和工具栏顶对齐，不盖住工具栏。浮层要贴着一个元素显示，用那个看不见的点。
  function openBeside(button: HTMLElement, content: ReactNode, label: string) {
    const bar = button.closest('.canvas-tools')!.getBoundingClientRect();
    const el = anchor.current!;
    el.style.left = `${bar.right + 12}px`;
    el.style.top = `${bar.top - 6}px`;
    return openPopover(el, content, { label });
  }

  // ---------- 对齐 ----------

  // 拖着一个节点靠近别的节点时，把它吸到对方的边线或中线上，并画出参考线。一次拖着好几个时不吸。
  const changeNodes = useCallback(
    (changes: NodeChange<Node>[]) => {
      // 拖的是分组的框：框自己没有位置，把这一下挪动换成挪它的成员。成员自己也在被拖的（一起选中了）就不再挪一遍。
      const moving = new Set(changes.filter((change) => change.type === 'position').map((change) => change.id));
      const frames = changes.filter((change) => change.type === 'position' && change.position && isGroup(flow.getNode(change.id) || {}));
      if (frames.length) {
        setNodes((items) => {
          const byId = new Map(items.map((node) => [node.id, node]));
          const shift = new Map<string, { x: number; y: number }>();
          for (const change of frames) {
            if (change.type !== 'position' || !change.position) continue;
            const group = byId.get(change.id);
            const frame = group && frameOf(group, byId);
            if (!group || !frame) continue;
            for (const member of membersOf(group)) if (!moving.has(member)) shift.set(member, { x: change.position.x - frame.x, y: change.position.y - frame.y });
          }
          return items.map((node) => (shift.has(node.id) ? { ...node, position: { x: node.position.x + shift.get(node.id)!.x, y: node.position.y + shift.get(node.id)!.y } } : node));
        });
        changes = changes.filter((change) => !(change.type === 'position' && frames.includes(change)));
      }
      // 松手时还会来最后一次位置（不带 dragging），它也要吸，不然一松手节点又弹回没对齐的地方。
      const moves = changes.filter((change) => change.type === 'position' && change.position && (change.dragging || change.id === snapping.current));
      const move = moves.length === 1 && !frames.length ? moves[0] : null;
      const me = move?.type === 'position' ? flow.getNode(move.id) : undefined;
      if (move?.type === 'position' && move.position && me) {
        snapping.current = move.dragging ? move.id : '';
        const others = flow.getNodes().filter((node) => node.id !== me.id && !isGroup(node) && !node.hidden).map((node) => boxOf(node));
        const snapped = snapTo(boxOf(me, move.position), others, SNAP_REACH / flow.getZoom());
        move.position = { x: move.position.x + snapped.dx, y: move.position.y + snapped.dy };
        setGuides(snapped.guides);
      } else if (changes.some((change) => change.type === 'position')) setGuides((now) => (now.length ? [] : now));
      onNodesChange(changes);
    },
    [flow, onNodesChange, setNodes],
  );

  // ---------- 分组 ----------

  // 把选中的节点打成一组（至少两个）。它们原来在别的组里就先从那边拿出来。
  const group = useCallback(() => {
    const picked = flow.getNodes().filter((node) => node.selected && !isGroup(node));
    if (picked.length < 2) return toast('请至少选中两个节点', 'info');
    snap();
    const ids = new Set(picked.map((node) => node.id));
    setNodes((items) => {
      const kept = items
        .map((node) => (isGroup(node) ? { ...node, selected: false, data: { ...node.data, members: membersOf(node).filter((id) => !ids.has(id)) } } : node.selected ? { ...node, selected: false } : node))
        .filter((node) => !isGroup(node) || membersOf(node).length);
      const [made] = numbered([{ id: crypto.randomUUID(), type: 'group', position: { x: 0, y: 0 }, data: { members: [...ids] }, selected: true } as Node], kept);
      return [made, ...kept];
    });
    // 框选之后会留着一个选区框，选中的东西换了，把它收掉。
    store.setState({ nodesSelectionActive: false });
  }, [flow, setNodes, snap, store]);

  // 解散分组：只去掉框，里面的节点留着。给了 id 就解散那一个，没给就解散选中的。
  const ungroup = useCallback(
    (groupId?: string) => {
      if (!flow.getNodes().some((node) => isGroup(node) && (groupId ? node.id === groupId : node.selected))) return;
      snap();
      setNodes((items) => items.filter((node) => !(isGroup(node) && (groupId ? node.id === groupId : node.selected))));
    },
    [flow, setNodes, snap],
  );

  // 来源节点右边的一块空位：columns × rows 个节点那么大，那里有节点就再往右让。
  const spotBeside = useCallback(
    (source: Node, columns = 1, rows = 1) => {
      const stepX = BOX_HEIGHT + 40;
      const stepY = TITLE_ROOM + BOX_HEIGHT + 40;
      const taken = flow.getNodes().filter((node) => !isGroup(node) && !node.hidden);
      let x = source.position.x + boxOf(source).width + 80;
      const y = source.position.y;
      const blocked = () => taken.some((node) => node.position.x < x + columns * stepX && node.position.x + boxOf(node).width + 40 > x && node.position.y < y + rows * stepY && node.position.y + TITLE_ROOM + BOX_HEIGHT + 40 > y);
      while (blocked()) x += stepX;
      return { x, y, stepX, stepY };
    },
    [flow],
  );
  const seed = () => ({ form: composer.form, image: composer.studio.image, speech: composer.studio.speech });

  // 把做好的几份产物各变成一个节点，摆在来源节点的右边，columns 个一行。
  // 默认是图片节点：裁剪、切宫格、截帧的产物都是图。
  // 视频剪辑的产物要变的是视频节点（kind 传 'video'），这时生成参数照抄来源节点——切出来的片段
  // 往往还要接着往下用（当参考视频、继续延长），用同一套参数才对得上。
  const addBeside = useCallback(
    (sourceId: string, made: { url: string; name: string }[], columns = 1, kind: NodeKind = 'image') => {
      const source = flow.getNode(sourceId);
      if (!source || !made.length) return;
      const { x, y, stepX, stepY } = spotBeside(source, columns, Math.ceil(made.length / columns));
      snap();
      const copied = Object.fromEntries(['model', 'ratio', 'resolution', 'duration'].filter((key) => source.data[key] !== undefined).map((key) => [key, source.data[key]]));
      const fresh = numbered(
        made.map((item, index) => ({ id: crypto.randomUUID(), type: kind, position: { x: x + (index % columns) * stepX, y: y + Math.floor(index / columns) * stepY }, data: { ...newNodeData(kind, seed()), ...(kind === 'video' ? copied : {}), upload: item }, selected: index === 0 }) as Node),
        flow.getNodes(),
      );
      setNodes((items) => [...items.map((node) => (node.selected ? { ...node, selected: false } : node)), ...fresh]);
      // 视频框是 16:9，比图片宽，按实际的宽度去揭示位置。
      reveal(fresh[0].position, nodeWidth(kind, fresh[0].data));
    },
    [flow, reveal, setNodes, snap, spotBeside],
  );

  // 在来源节点右边加一个同类的空节点（参数照抄来源节点，再盖上 data），选中它，返回它的 id。扩图用：结果放进这个新节点。
  const addNodeBeside = useCallback(
    (sourceId: string, data: Record<string, unknown>) => {
      const source = flow.getNode(sourceId);
      if (!source) return '';
      const { x, y } = spotBeside(source);
      snap();
      const kind = source.type as NodeKind;
      const base = { ...newNodeData(kind, seed()), ...Object.fromEntries(['model', 'ratio', 'resolution', 'duration'].filter((key) => source.data[key] !== undefined).map((key) => [key, source.data[key]])) };
      const [made] = numbered([{ id: crypto.randomUUID(), type: kind, position: { x, y }, data: { ...base, ...data }, selected: true } as Node], flow.getNodes());
      setNodes((items) => [...items.map((node) => (node.selected ? { ...node, selected: false } : node)), made]);
      reveal(made.position, nodeWidth(kind, made.data));
      return made.id;
    },
    [flow, reveal, setNodes, snap, spotBeside],
  );

  // 接着一段视频往后拍：它的最后一帧变成一个图片节点，再接一个视频节点，这张图当首帧。新视频节点的参数照抄原来的，选中它等着写接下来发生什么。
  const continueVideo = useCallback(
    (sourceId: string, frame: { url: string; name: string }, targetAt?: { x: number; y: number }) => {
      const source = flow.getNode(sourceId);
      if (!source) return;
      const { x, y } = targetAt || spotBeside(source, 3, 1);
      snap();
      const copied = Object.fromEntries(['model', 'ratio', 'resolution', 'duration'].map((key) => [key, source.data[key]]));
      const [image, video] = numbered(
        [
          { id: crypto.randomUUID(), type: 'image', position: { x, y }, data: { ...newNodeData('image', seed()), upload: frame, aspect: source.data.aspect, derivedFrom: source.id } } as Node,
          { id: crypto.randomUUID(), type: 'video', position: { x: x + nodeWidth('image', { aspect: source.data.aspect as number | undefined }) + 120, y }, data: { ...newNodeData('video', seed()), ...copied, prompt: '' }, selected: true } as Node,
        ],
        flow.getNodes(),
      );
      setNodes((items) => [...items.map((node) => (node.selected ? { ...node, selected: false } : node)), image, video]);
      setEdges((items) => [...items, { id: crypto.randomUUID(), source: image.id, target: video.id, type: 'link', data: { kind: 'image', role: 'first' } }]);
      reveal(video.position, nodeWidth('video', video.data));
    },
    [flow, reveal, setEdges, setNodes, snap, spotBeside],
  );

  // ---------- 堆叠 ----------

  // 把选中的节点收成一叠（至少两个）。选中的里面已经有一叠，就并进同一叠。分组的框不收。
  const stack = useCallback(() => {
    const picked = flow.getNodes().filter((node) => node.selected && !isGroup(node));
    const loose = picked.filter((node) => !isStack(node));
    const members = [...picked.filter(isStack).flatMap(membersOf), ...loose.map((node) => node.id)];
    if (members.length < 2 || !loose.length) return toast('请至少选中两个节点', 'info');
    if (members.length > MAX_STACK) return toast(`堆叠最多包含 ${MAX_STACK} 个节点`, 'info');
    snap();
    const inside = new Set(loose.map((node) => node.id));
    const merged = new Set(picked.filter(isStack).map((node) => node.id));
    setNodes((items) => {
      const kept = items.filter((node) => !merged.has(node.id)).map((node) => (inside.has(node.id) ? { ...node, hidden: true, selected: false } : node.selected ? { ...node, selected: false } : node));
      const [made] = numbered([{ id: crypto.randomUUID(), type: 'stack', position: { ...picked[0].position }, data: { members }, selected: true } as Node], kept);
      return [...kept, made];
    });
    store.setState({ nodesSelectionActive: false });
  }, [flow, setNodes, snap, store]);

  // 摊开一叠：里面的节点从这一叠的位置起排成几行。只给了一个成员，就只把它取回来放在这一叠右边；取到只剩一个时这一叠自动散掉。
  const unstack = useCallback(
    (stackId: string, memberId?: string) => {
      const pile = flow.getNode(stackId);
      if (!pile) return;
      snap();
      const members = membersOf(pile);
      const out = memberId && members.length > 2 ? [memberId] : members;
      const rest = members.filter((id) => !out.includes(id));
      const spot = new Map<string, { x: number; y: number }>();
      if (rest.length) spot.set(out[0], { x: pile.position.x + BOX_HEIGHT + 80, y: pile.position.y });
      else {
        // 要取的那个排第一，放在这一叠原来的位置。
        const order = memberId ? [memberId, ...members.filter((id) => id !== memberId)] : members;
        let x = pile.position.x;
        let y = pile.position.y;
        order.forEach((id, index) => {
          if (index && index % 5 === 0) {
            x = pile.position.x;
            y += TITLE_ROOM + BOX_HEIGHT + 56;
          }
          spot.set(id, { x, y });
          const member = flow.getNode(id);
          x += (member ? nodeWidth(member.type as NodeKind, member.data) : BOX_HEIGHT) + 60;
        });
      }
      setNodes((items) =>
        items
          .filter((node) => rest.length || node.id !== stackId)
          .map((node) => {
            if (spot.has(node.id)) return { ...node, hidden: false, position: spot.get(node.id)!, selected: node.id === (memberId || out[0]) };
            if (node.id === stackId) return { ...node, data: { ...node.data, members: rest } };
            return node.selected ? { ...node, selected: false } : node;
          }),
      );
    },
    [flow, setNodes, snap],
  );

  // 成员被删掉之后，分组里不再记着它；一个成员都不剩的分组一起去掉。
  // 堆叠也一样；一叠里只剩一个节点时，这一叠散掉，把那个节点放回它的位置。
  useEffect(() => {
    const ids = new Set(nodes.map((node) => node.id));
    const stale = (node: Node) => (isGroup(node) && (!membersOf(node).length || membersOf(node).some((id) => !ids.has(id)))) || (isStack(node) && membersOf(node).filter((id) => ids.has(id)).length !== membersOf(node).length) || (isStack(node) && membersOf(node).length < 2);
    if (!nodes.some(stale)) return;
    setNodes((items) => {
      const live = new Set(items.map((node) => node.id));
      const pruned = items.map((node) => (isGroup(node) || isStack(node) ? { ...node, data: { ...node.data, members: membersOf(node).filter((id) => live.has(id)) } } : node));
      // 只剩一个成员的那几叠：成员放出来，这一叠去掉。
      const freed = new Map(pruned.filter((node) => isStack(node) && membersOf(node).length === 1).map((node) => [membersOf(node)[0], node.position]));
      return pruned.filter((node) => !((isGroup(node) && !membersOf(node).length) || (isStack(node) && membersOf(node).length < 2))).map((node) => (freed.has(node.id) ? { ...node, hidden: false, position: freed.get(node.id)! } : node));
    });
  }, [nodes, setNodes]);

  // 把一个分组存成工作流：组里的节点和它们之间的连线。
  const saveWorkflow = useCallback(
    async (groupId: string) => {
      const made = flow.getNode(groupId);
      if (!made) return;
      const ids = new Set(membersOf(made));
      const clip = clipOf(savedNodes(flow.getNodes().filter((node) => ids.has(node.id))), savedEdges(flow.getEdges()));
      const data = made.data as unknown as GroupData;
      // 先起个名字：默认是分组的名字，不问的话一排工作流都叫「分组 1」。
      const name = await promptName({ title: '存为工作流', label: '工作流名称', value: data.name?.trim() || `分组 ${data.no || ''}`.trim() });
      if (!name) return;
      try {
        await api('POST', '/api/workflows', { name, ...clip });
        toast(`已存为工作流「${name}」`, 'success');
      } catch (err) {
        toast((err as Error).message, 'error', 6000);
      }
    },
    [flow],
  );

  // 把一份工作流放上画布：节点和连线都是新的，放在视野中间，外面套一个同名的分组。
  const applyWorkflow = useCallback(
    async (workflowId: string) => {
      try {
        const saved = await api<Clip & { name: string }>('GET', `/api/workflows/${workflowId}`);
        // 画布上已经有东西：放在所有节点的下面，左边对齐，不压着谁。空画布就放在视野中间。
        const box = wrap.current!.getBoundingClientRect();
        const solid = flow.getNodes().filter((node) => !isGroup(node) && !node.hidden);
        const at = solid.length
          ? { x: Math.min(...solid.map((node) => node.position.x)), y: Math.max(...solid.map((node) => node.position.y)) + TITLE_ROOM + BOX_HEIGHT + 120 }
          : flow.screenToFlowPosition({ x: box.left + box.width / 2 - 300, y: box.top + box.height / 2 - 200 });
        const pasted = pasteClip({ nodes: saved.nodes.filter((node) => !isGroup(node)), edges: saved.edges }, { at }, () => crypto.randomUUID());
        snap();
        const fresh = numbered(pasted.nodes.map((node) => ({ ...node, data: { ...node.data, no: undefined } }) as Node), flow.getNodes());
        const [made] = numbered([{ id: crypto.randomUUID(), type: 'group', position: { x: 0, y: 0 }, data: { name: saved.name, members: fresh.map((node) => node.id) }, selected: true } as Node], flow.getNodes());
        setNodes((items) => [made, ...items.map((node) => (node.selected ? { ...node, selected: false } : node)), ...fresh]);
        setEdges((items) => [...items, ...pasted.edges.map((edge) => ({ ...edge, type: 'link' }) as Edge)]);
        requestAnimationFrame(() => flow.fitView({ nodes: fresh.map(({ id }) => ({ id })), maxZoom: 1, padding: 0.3, duration: reducedMotion() ? 0 : 280 }));
      } catch (err) {
        toast((err as Error).message, 'error', 6000);
      }
    },
    [flow, setEdges, setNodes, snap],
  );

  // 一键整理：框选了两个以上就只整理它们，否则整理整张画布。
  const arrange = useCallback(() => {
    const all = flow.getNodes().filter((node) => !isGroup(node) && !node.hidden);
    const picked = all.filter((node) => node.selected);
    const scope = picked.length > 1 ? picked : all;
    if (scope.length < 2) return;
    const placed = tidy(scope.map((node) => ({ id: node.id, position: node.position, width: boxOf(node).width })), flow.getEdges());
    if (scope.every((node) => placed.get(node.id)!.x === node.position.x && placed.get(node.id)!.y === node.position.y)) return;
    snap();
    setNodes((items) => items.map((node) => (placed.has(node.id) ? { ...node, position: placed.get(node.id)! } : node)));
    // 整理的是整张画布时，排完把它们都放进视野。
    if (scope === all) requestAnimationFrame(() => flow.fitView({ maxZoom: 1, padding: 0.2, duration: reducedMotion() ? 0 : 280 }));
  }, [flow, setNodes, snap]);

  // ---------- 复制、粘贴、创建副本 ----------

  const selection = useCallback((): Clip | null => {
    // 选中了分组的框，就连它的成员一起带上；分组只有成员都在这次复制里才带。
    const all = flow.getNodes();
    const chosen = new Set(all.filter((node) => node.selected).map((node) => node.id));
    for (const node of all) if (isGroup(node) && node.selected) membersOf(node).forEach((id) => chosen.add(id));
    // 一叠被选中（或者跟着分组被带上），里面藏着的节点也一起。
    for (const node of all) if (isStack(node) && chosen.has(node.id)) membersOf(node).forEach((id) => chosen.add(id));
    const picked = all.filter((node) => chosen.has(node.id) && (!isGroup(node) || membersOf(node).every((id) => chosen.has(id))));
    return picked.some((node) => !isGroup(node)) ? clipOf(savedNodes(picked), savedEdges(flow.getEdges())) : null;
  }, [flow]);

  // 把一份复制下来的节点放上画布并选中它们。inheritUpstream：是否继承上游连线（分支复制/就地粘贴时使用）。
  const place = useCallback(
    (clip: Clip, where: { at?: { x: number; y: number }; by?: { x: number; y: number } }, inheritUpstream = true) => {
      if (!clip.nodes.length) return;
      snap();
      // 粘贴出来的是新节点，编号重新排。
      const pasted = pasteClip(clip, where, () => crypto.randomUUID());
      const fresh = { edges: pasted.edges, nodes: numbered(pasted.nodes.map((node) => ({ ...node, data: { ...node.data, no: undefined } })), flow.getNodes()) };
      setNodes((items) => [...items.map((n) => (n.selected ? { ...n, selected: false } : n)), ...fresh.nodes.map((node) => ({ ...node, selected: true }) as Node)]);

      // 继承上游连线：如果源节点在当前画布上依然存在，且符合连线规则，就自动连上。
      const extraEdges: Edge[] = [];
      if (inheritUpstream && pasted.upstream?.length) {
        const currentNodes = flow.getNodes();
        const nodeMap = new Map(currentNodes.map((n) => [n.id, n]));
        for (const up of pasted.upstream) {
          const sourceNode = nodeMap.get(up.source);
          if (!sourceNode) continue;
          const targetNode = fresh.nodes.find((n) => n.id === up.target);
          if (!targetNode) continue;
          if (!canLink(sourceNode.type as NodeKind, targetNode.type as NodeKind)) continue;
          extraEdges.push({
            id: up.id,
            source: up.source,
            target: up.target,
            type: 'link',
            data: up.data as unknown as Record<string, unknown>,
          });
        }
      }

      setEdges((items) => [
        ...items.map((e) => (e.selected ? { ...e, selected: false } : e)),
        ...fresh.edges.map((edge) => ({ ...edge, type: 'link' }) as Edge),
        ...extraEdges,
      ]);
    },
    [flow, setEdges, setNodes, snap],
  );

  // 粘贴落在鼠标的位置；鼠标不在画布上就落在视野中间。
  const pasteSpot = useCallback(() => {
    const box = wrap.current!.getBoundingClientRect();
    return flow.screenToFlowPosition(pointer.current || { x: box.left + box.width / 2 - 120, y: box.top + box.height / 2 - 120 });
  }, [flow]);

  const duplicate = useCallback(() => {
    const clip = selection();
    if (clip) place(clip, { by: { x: 40, y: 40 } });
  }, [place, selection]);

  useEffect(() => {
    // 正在打字、选中了一段文字、或者有弹窗盖着的时候，这些按键和剪贴板都留给它们自己。
    const mine = (e: Event) => {
      const el = e.target as HTMLElement;
      if (!wrap.current?.offsetParent || el.closest?.('input, textarea, [contenteditable]')) return false;
      return el === document.body || wrap.current.contains(el);
    };
    const onCopy = (e: ClipboardEvent) => {
      if (!mine(e) || String(window.getSelection())) return;
      const clip = selection();
      if (!clip || !e.clipboardData) return;
      e.preventDefault();
      copied = clip;
      e.clipboardData.setData(CLIP_TYPE, JSON.stringify(clip));
      if (e.type === 'cut') flow.deleteElements({ nodes: clip.nodes.map(({ id }) => ({ id })) });
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!mine(e) || !e.clipboardData) return;
      const at = pasteSpot();
      const raw = e.clipboardData.getData(CLIP_TYPE);
      if (raw) {
        e.preventDefault();
        try {
          place(JSON.parse(raw) as Clip, { at });
        } catch {
          /* 剪贴板里不是画布的内容 */
        }
        return;
      }
      // 从别处复制来的图片、视频文件变成节点；一段文字变成一个文本节点。
      const files = [...e.clipboardData.files];
      if (files.length) {
        e.preventDefault();
        files.forEach((pasted, index) => upload(pasted, { x: at.x + index * 400, y: at.y }));
        return;
      }
      const text = e.clipboardData.getData('text/plain').trim();
      if (text) {
        e.preventDefault();
        addNode('text', at, undefined, { text });
      }
    };
    const onKey = (e: KeyboardEvent) => {
      // ⌘ + 在有的键盘上要同时按 Shift，所以这两个缩放键不拦 Shift。
      const key = e.key.toLowerCase();
      // H 是抓手，V 回到选择（和 Figma 一样）。
      if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && (key === 'h' || key === 'v') && mine(e)) return setHand(key === 'h');
      // ⌘ F 搜索节点，正在打字时也管用（否则会弹出浏览器自己的查找）。
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && key === 'f' && wrap.current?.offsetParent && (e.target === document.body || wrap.current.contains(e.target as HTMLElement))) {
        e.preventDefault();
        return setFinding(true);
      }
      if (!(e.metaKey || e.ctrlKey) || e.altKey || !mine(e) || (e.shiftKey && key !== '+' && key !== '=' && key !== 'g')) return;
      // ⌘ G 打组，⇧ ⌘ G 解散。
      if (key === 'g') {
        e.preventDefault();
        return e.shiftKey ? ungroup() : group();
      }
      if (key === 'd') {
        e.preventDefault();
        duplicate();
      } else if (key === '=' || key === '+') {
        // ⌘ + 和 ⌘ - 缩放画布，不让浏览器去缩放整个页面。
        e.preventDefault();
        flow.zoomIn({ duration: reducedMotion() ? 0 : 160 });
      } else if (key === '-') {
        e.preventDefault();
        flow.zoomOut({ duration: reducedMotion() ? 0 : 160 });
      } else if (key === 'a') {
        e.preventDefault();
        setNodes((items) => items.map((n) => (n.selected || n.hidden ? n : { ...n, selected: true })));
      }
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCopy);
    document.addEventListener('paste', onPaste);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCopy);
      document.removeEventListener('paste', onPaste);
      window.removeEventListener('keydown', onKey);
    };
  }, [addNode, duplicate, flow, group, pasteSpot, place, selection, setNodes, ungroup, upload]);

  // ---------- 右键菜单 ----------

  // 在空白处点右键：加节点、上传、粘贴。
  function paneMenu(x: number, y: number) {
    const el = anchor.current!;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    const at = flow.screenToFlowPosition({ x, y });
    openMenu(el, {
      label: '画布',
      items: [...KINDS.map((kind) => ({ value: kind, label: `${NODE_LABELS[kind]}节点` })), { value: 'upload', label: '上传文件' }, ...(copied ? [{ value: 'paste', label: '粘贴', note: '⌘ V' }] : []), ...(flow.getNodes().length ? [{ value: 'all', label: '全选', note: '⌘ A' }] : [])],
      onSelect: (value) => {
        if (value === 'upload') {
          dropAt.current = at;
          file.current!.click();
        } else if (value === 'paste') place(copied!, { at });
        else if (value === 'all') setNodes((items) => items.map((n) => (n.selected || n.hidden ? n : { ...n, selected: true })));
        else addNode(value as NodeKind, at);
      },
    });
  }

  // 在节点上点右键：对选中的节点创建副本、删除。点的节点不在选中的里面，就先改成只选它。
  function nodeMenu(x: number, y: number, node?: Node) {
    if (node && !node.selected) setNodes((items) => items.map((n) => (n.selected === (n.id === node.id) ? n : { ...n, selected: n.id === node.id })));
    const el = anchor.current!;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    // 这时候选中的是什么：点的是分组的框，菜单里是解散；选中了两个以上的节点，多一项打组。
    const picked = node ? (node.selected ? flow.getNodes().filter((n) => n.selected) : [node]) : flow.getNodes().filter((n) => n.selected);
    const onGroup = picked.length === 1 && isGroup(picked[0]);
    openMenu(el, {
      label: '节点',
      items: [
        { value: 'duplicate', label: '创建副本', note: '⌘ D' },
        ...(picked.filter((n) => !isGroup(n)).length > 1 ? [{ value: 'group', label: '打组', note: '⌘ G' }, { value: 'stack', label: '堆叠' }] : []),
        ...(picked.length === 1 && isStack(picked[0]) ? [{ value: 'unstack', label: '取消堆叠' }] : []),
        onGroup ? { value: 'ungroup', label: '解散分组', note: '⇧ ⌘ G' } : { value: 'delete', label: '删除', note: '⌫', danger: true },
      ],
      onSelect: (value) => {
        if (value === 'duplicate') duplicate();
        else if (value === 'group') group();
        else if (value === 'stack') stack();
        else if (value === 'unstack') unstack(picked[0].id);
        else if (value === 'ungroup') ungroup(picked[0].id);
        else flow.deleteElements({ nodes: flow.getNodes().filter((n) => n.selected) });
      },
    });
  }

  const isValidConnection = useCallback(
    (link: Connection | Edge) => {
      const source = flow.getNode(link.source);
      const target = flow.getNode(link.target);
      if (!source || !target || source.id === target.id || isGroup(source) || isGroup(target) || isStack(source) || isStack(target)) return false;
      if (!canLink(source.type as NodeKind, target.type as NodeKind)) return false;
      const all = flow.getEdges();
      if (all.some((edge) => edge.source === source.id && edge.target === target.id)) return false;
      // 图片连图片是图生图：目标模型得收参考图，而且还没连满。
      if (source.type === 'image' && target.type === 'image') {
        const used = all.filter((edge) => edge.target === target.id && (edge.data as unknown as LinkData)?.kind === 'image').length;
        if (used >= imageRefLimit((target.data as { model?: string }).model)) return false;
      }
      // 视频可以连视频，所以要防着连成一圈：从目标往下游走，走得回起点就不让连。
      const seen = new Set<string>();
      const stack = [target.id];
      while (stack.length) {
        const next = stack.pop()!;
        if (next === source.id) return false;
        if (seen.has(next)) continue;
        seen.add(next);
        for (const edge of all) if (edge.source === next) stack.push(edge.target);
      }
      return true;
    },
    [flow],
  );

  const onConnect = useCallback(
    (link: Connection) => {
      const source = flow.getNode(link.source);
      const target = flow.getNode(link.target);
      if (!source || !target) return;
      snap();
      setEdges((items) => [...items, makeEdge(source, target)]);
    },
    [flow, setEdges, snap],
  );

  // 问要在一个节点的哪一侧接一个什么节点，建好并连上。右边的加号接的是下游，左边的加号接的是上游。
  const extend = useCallback(
    (nodeId: string, downstream: boolean, x: number, y: number, beside = false, onClose?: () => void) => {
      const node = flow.getNode(nodeId);
      if (!node) return;
      // beside：新节点和这个节点顶边对齐，隔开一段摆在左边或右边；那里有节点了就往下错开。
      let place: { x: number; y: number } | undefined;
      if (beside) {
        place = { x: downstream ? node.position.x + (node.measured?.width || 320) + 140 : node.position.x - 430 - 140, y: node.position.y };
        while (flow.getNodes().some((n) => Math.abs(n.position.x - place!.x) < 300 && Math.abs(n.position.y - place!.y) < 200)) place.y += 280;
      }
      const type = node.type as NodeKind;
      const defaultImageModel = newNodeData('image', { form: composer.form, image: composer.studio.image, speech: composer.studio.speech }).model as string;
      const downstreamImageOk = imageRefLimit(defaultImageModel) > 0;
      const upstreamImageUsed = flow.getEdges().filter((edge) => edge.target === node.id && (edge.data as unknown as LinkData)?.kind === 'image').length;
      const upstreamImageLimit = imageRefLimit((node.data as { model?: string }).model);
      const upstreamImageOk = upstreamImageUsed < upstreamImageLimit;

      const options: IntentionOption[] = [];
      const also = downstream && node.selected ? flow.getNodes().filter((n) => n.selected && n.id !== node.id) : [];
      const link = downstream ? { from: node, also } : { to: node };

      if (downstream) {
        // 下游意图推荐（以当前节点为起点/参考，接续生成）
        if (type === 'image') {
          options.push({
            value: 'img-to-video-first',
            kind: 'video',
            label: '以此图为首帧生成视频',
            note: '首帧图生视频',
            icon: 'video',
            role: 'first',
          });
          options.push({
            value: 'img-to-img',
            kind: 'image',
            label: '以此图为参考生图',
            note: '图生图',
            icon: 'image',
            disabled: !downstreamImageOk,
            title: downstreamImageOk ? undefined : '模型不支持参考图',
          });
          options.push({
            value: 'img-to-video-ref',
            kind: 'video',
            label: '以此图为参考素材生成视频',
            note: '角色/风格参考',
            icon: 'video',
            role: 'reference',
          });
        } else if (type === 'video') {
          const out = outputOf(node);
          options.push({
            value: 'video-continue',
            kind: 'video',
            label: '接着拍（截取尾帧接续生成）',
            note: '分镜续拍',
            icon: 'workflow',
            disabled: !out?.url,
            title: out?.url ? undefined : '视频未生成',
            onExecute: async (at) => {
              if (!out?.url) return toast('视频尚未准备好', 'info');
              toast('正在截取最后一帧…', 'info', 1800);
              try {
                const frame = await grabFrame(out.url, 'last', `${out.name || '镜头'}-尾帧`);
                continueVideo(node.id, frame, at);
              } catch (err) {
                toast((err as Error).message, 'error', 6000);
              }
            },
          });
          options.push({
            value: 'video-to-video-ref',
            kind: 'video',
            label: '以此视频为参考生成视频',
            note: '动态参考',
            icon: 'video',
          });
        } else if (type === 'text') {
          options.push({
            value: 'text-to-img',
            kind: 'image',
            label: '以此文本为提示词生图',
            note: '文生图',
            icon: 'image',
          });
          options.push({
            value: 'text-to-video',
            kind: 'video',
            label: '以此文本为提示词生成视频',
            note: '文生视频',
            icon: 'video',
          });
          options.push({
            value: 'text-to-speech',
            kind: 'audio',
            label: '朗读此文本（生成语音）',
            note: '语音合成',
            icon: 'music',
            extra: { tool: 'speech' },
          });
          options.push({
            value: 'text-to-text',
            kind: 'text',
            label: '扩写或润色文本',
            note: '文本生成',
            icon: 'type',
          });
        } else if (type === 'audio') {
          options.push({
            value: 'audio-to-video',
            kind: 'video',
            label: '以此音频为配乐生成视频',
            note: '音视频合成',
            icon: 'video',
          });
        }
      } else {
        // 上游意图推荐（为当前节点添加输入素材/提示词）
        if (type === 'image') {
          options.push({
            value: 'up-text',
            kind: 'text',
            label: '添加提示词文本',
            note: '提示词',
            icon: 'type',
          });
          options.push({
            value: 'up-image',
            kind: 'image',
            label: '添加参考图节点',
            note: '垫图参考',
            icon: 'image',
            disabled: !upstreamImageOk,
            title: upstreamImageOk ? undefined : '不支持参考图或已达上限',
          });
        } else if (type === 'video') {
          options.push({
            value: 'up-first-frame',
            kind: 'image',
            label: '添加首帧图片',
            note: '起始画面',
            icon: 'image',
            role: 'first',
          });
          options.push({
            value: 'up-text',
            kind: 'text',
            label: '添加分镜提示词',
            note: '提示词',
            icon: 'type',
          });
          options.push({
            value: 'up-image-ref',
            kind: 'image',
            label: '添加参考图片',
            note: '角色/风格参考',
            icon: 'image',
            role: 'reference',
          });
          options.push({
            value: 'up-last-frame',
            kind: 'image',
            label: '添加尾帧图片',
            note: '结束画面',
            icon: 'image',
            role: 'last',
          });
          options.push({
            value: 'up-video-ref',
            kind: 'video',
            label: '添加参考视频',
            note: '动态素材',
            icon: 'video',
          });
          options.push({
            value: 'up-audio',
            kind: 'audio',
            label: '添加配乐或音效',
            note: '背景声音',
            icon: 'music',
          });
        } else if (type === 'audio') {
          options.push({
            value: 'up-text',
            kind: 'text',
            label: '添加朗读文本',
            note: '台词文本',
            icon: 'type',
          });
        } else if (type === 'text') {
          options.push({
            value: 'up-text',
            kind: 'text',
            label: '添加参考文本',
            note: '上游文本',
            icon: 'type',
          });
        }
      }

      if (!options.length) {
        const able = downstream ? targetsOf(type) : sourcesOf(type);
        options.push(...able.map((k) => ({
          value: k,
          kind: k,
          label: `${NODE_LABELS[k]}节点`,
          icon: NODE_ICONS[k],
        })));
      }

      const heading = downstream ? `引用${NODE_LABELS[type]}节点生成` : `连接到${NODE_LABELS[type]}节点`;
      menuAt(x, y, options, link, place, heading, onClose);
    },
    [composer.form, composer.studio.image, composer.studio.speech, continueVideo, flow, menuAt],
  );

  // 从节点的加号拉出一条线、松在空白处。
  const onConnectEnd = useCallback<OnConnectEnd>(
    (event, link) => {
      if (link.isValid || link.toNode || !link.fromNode) return;
      const point = 'changedTouches' in event ? event.changedTouches[0] : event;
      const downstream = link.fromHandle?.type === 'source';
      // 线留在原地，菜单贴着线头出来；选了节点或者关掉菜单，这条线才收。
      const from = link.fromNode;
      const end = flow.screenToFlowPosition({ x: point.clientX, y: point.clientY });
      setLoose({ fromX: from.internals.positionAbsolute.x + (downstream ? from.measured.width || 0 : 0), fromY: from.internals.positionAbsolute.y + TITLE_ROOM + BOX_HEIGHT / 2, toX: end.x, toY: end.y, downstream });
      extend(from.id, downstream, point.clientX, point.clientY, false, () => setLoose(null));
    },
    [extend, flow],
  );

  // 点项目名旁边的箭头：列出别的画布，点一个就先存好当前的再换过去；最下面是新建。
  async function switchCanvas(button: HTMLElement) {
    let list: { id: string; name: string }[] = [];
    try {
      list = (await api<{ items: { id: string; name: string }[] }>('GET', '/api/canvases')).items;
    } catch (err) {
      return toast(`画布加载失败：${(err as Error).message}`, 'error', 6000);
    }
    openMenu(button, {
      label: '切换画布',
      items: [...list.map((item) => ({ value: item.id, label: item.id === id ? name || item.name : item.name, selected: item.id === id })), { value: 'new', label: '新建画布', selected: false }],
      onSelect: async (value) => {
        await flush();
        try {
          const next = value === 'new' ? (await api<{ id: string }>('POST', '/api/canvases', {})).id : value;
          location.hash = canvasPath(next);
        } catch (err) {
          toast((err as Error).message, 'error', 6000);
        }
      },
    });
  }

  function openZoom(button: HTMLElement) {
    const actions: Record<string, () => void> = { in: () => flow.zoomIn(), out: () => flow.zoomOut(), fit: () => flow.fitView({ maxZoom: 1, padding: 0.2 }), full: () => flow.zoomTo(1) };
    openMenu(button, {
      label: '缩放',
      items: [
        { value: 'in', label: '放大', note: '⌘ +' },
        { value: 'out', label: '缩小', note: '⌘ −' },
        { value: 'fit', label: '适应内容' },
        { value: 'full', label: '100%' },
      ],
      onSelect: (value) => actions[value](),
    });
  }

  const actions = useMemo(() => ({ snap, addInput, ungroup, saveWorkflow, unstack, addBeside, addNodeBeside, continueVideo, jumpTo, hoverNode }), [snap, addInput, ungroup, saveWorkflow, unstack, addBeside, addNodeBeside, continueVideo, jumpTo, hoverNode]);
  const selectedNodes = useMemo(() => nodes.filter((node) => node.selected && !node.hidden), [nodes]);
  const selectedSolid = useMemo(() => selectedNodes.filter((node) => !isGroup(node)), [selectedNodes]);

  // 批量生成：按拓扑顺序执行选中的可生成节点
  const batchRun = useCallback(async () => {
    const ids = selectedSolid.filter((n) => ['text', 'image', 'video', 'audio'].includes(n.type || '')).map((n) => n.id);
    if (!ids.length) return toast('没有可执行的节点', 'info');
    const todo = runOrder(ids, flow.getEdges());
    if (!(await confirmRun(flow, todo))) return;
    const setIds = new Set(todo);
    const hasInternalDeps = flow.getEdges().some((e) => setIds.has(e.source) && setIds.has(e.target));
    if (!hasInternalDeps) {
      for (const id of todo) generate(flow, id, snap);
    } else {
      for (const [index, id] of todo.entries()) {
        await generate(flow, id, snap);
        const deadline = Date.now() + 20 * 60 * 1000;
        for (;;) {
          const node = flow.getNode(id);
          if (!node) return;
          const data = node.data as Record<string, unknown>;
          const record = recordOf(data);
          const failed = Boolean(data.error) || record?.status === 'failed' || (node.type !== 'text' && !data.recordId);
          if (failed || Date.now() > deadline) return toast(`第 ${index + 1} 个节点执行失败：${data.error || record?.error?.message || '未返回结果'}`, 'error', 6000);
          if (node.type === 'text' ? String(data.text || '').trim() && !data.busy : outputOf(node)) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      toast('批量生成完成', 'success');
    }
  }, [flow, selectedSolid, snap]);

  // 对齐节点
  const align = useCallback(
    (direction: AlignDirection) => {
      if (selectedSolid.length < 2) return;
      snap();
      const sized = selectedSolid.map((n) => ({
        id: n.id,
        position: { ...n.position },
        width: n.measured?.width || nodeWidth(n.type as NodeKind, n.data),
        height: (n.measured?.height || BOX_HEIGHT) + TITLE_ROOM,
      }));
      const aligned = alignNodes(sized, direction);
      setNodes((items) =>
        items.map((node) => {
          const pos = aligned.get(node.id);
          return pos ? { ...node, position: pos } : node;
        }),
      );
    },
    [selectedSolid, snap, setNodes],
  );

  // 等间距分布节点
  const distribute = useCallback(
    (axis: 'h' | 'v') => {
      if (selectedSolid.length < 3) return toast('至少需要 3 个节点才能等间距分布', 'info');
      snap();
      const sized = selectedSolid.map((n) => ({
        id: n.id,
        position: { ...n.position },
        width: n.measured?.width || nodeWidth(n.type as NodeKind, n.data),
        height: (n.measured?.height || BOX_HEIGHT) + TITLE_ROOM,
      }));
      const distributed = distributeNodes(sized, axis);
      setNodes((items) =>
        items.map((node) => {
          const pos = distributed.get(node.id);
          return pos ? { ...node, position: pos } : node;
        }),
      );
    },
    [selectedSolid, snap, setNodes],
  );

  // 批量删除
  const batchDelete = useCallback(() => {
    snap();
    flow.deleteElements({ nodes: flow.getNodes().filter((n) => n.selected) });
  }, [flow, snap]);

  // 打开对齐分布菜单
  const openAlignMenu = useCallback(
    (target: HTMLElement) => {
      openMenu(target, {
        label: '对齐与分布',
        items: [
          { value: 'left', label: '左对齐' },
          { value: 'center-h', label: '水平居中' },
          { value: 'right', label: '右对齐' },
          { value: 'top', label: '顶对齐' },
          { value: 'center-v', label: '垂直居中' },
          { value: 'bottom', label: '底对齐' },
          { value: 'distribute-h', label: '水平等间距分布', disabled: selectedSolid.length < 3 },
          { value: 'distribute-v', label: '垂直等间距分布', disabled: selectedSolid.length < 3 },
        ],
        onSelect: (value) => {
          if (value === 'distribute-h') distribute('h');
          else if (value === 'distribute-v') distribute('v');
          else align(value as AlignDirection);
        },
      });
    },
    [align, distribute, selectedSolid.length],
  );
  const shown = useMemo(() => framed(nodes), [nodes]);
  // 参考线画满整个视野：横线从窗口最左到最右，竖线从最上到最下。同一条线只画一次。
  const view = useViewport();
  const spanned = useMemo(() => {
    const box = wrap.current?.getBoundingClientRect();
    if (!box || !guides.length) return [];
    const left = -view.x / view.zoom;
    const top = -view.y / view.zoom;
    const seen = new Set<string>();
    return guides
      .map((line) => (line.y1 === line.y2 ? { x1: left, y1: line.y1, x2: left + box.width / view.zoom, y2: line.y1 } : { x1: line.x1, y1: top, x2: line.x1, y2: top + box.height / view.zoom }))
      .filter((line) => !seen.has(`${line.x1},${line.y1},${line.x2},${line.y2}`) && seen.add(`${line.x1},${line.y1},${line.x2},${line.y2}`));
  }, [guides, view.x, view.y, view.zoom]);
  // 每种颜色标了哪些节点。收在一叠里的不算。
  const pinned = useMemo(() => {
    const by = Object.fromEntries(PINS.map((pin) => [pin, [] as Node[]])) as Record<Pin, Node[]>;
    for (const node of nodes) if (!node.hidden) for (const pin of (node.data.pin as Pin[] | undefined) || []) by[pin]?.push(node);
    return by;
  }, [nodes]);

  return (
    <CanvasActions.Provider value={actions}>
      <div
        ref={wrap}
        className={`canvas ${hand ? 'is-hand' : ''}`}
        // 节点的名字和加号要在屏幕上保持大小不变，样式里用这个倒数把画布的缩放抵消掉。
        // 50% 以下不再抵消：名字和加号跟着画布一起缩小，不然会比节点本身还大。
        // --ring、--ring-gap 是选中那圈线的粗细和间隔（画布坐标）：屏幕上 100% 时是 1.5 和 3，缩小时收到 1 和 1 为止。
        onDoubleClick={(e) =>
          (e.target as Element).classList.contains('react-flow__pane') &&
          menuAt(
            e.clientX,
            e.clientY,
            KINDS.map((kind) => ({ value: kind, kind, label: `${NODE_LABELS[kind]}节点`, icon: NODE_ICONS[kind] })),
            undefined,
            undefined,
            '添加节点',
          )
        }
        onClick={(e) => {
          // 直接点一下加号（没有拖动）：菜单出在加号外侧。
          const port = (e.target as Element).closest<HTMLElement>('.cnode-port');
          if (!port?.dataset.nodeid) return;
          const box = port.getBoundingClientRect();
          const downstream = port.classList.contains('source');
          extend(port.dataset.nodeid, downstream, downstream ? box.right + 8 : box.left - 8, box.top, true);
        }}
        onPointerMove={(e) => (pointer.current = { x: e.clientX, y: e.clientY })}
        onPointerLeave={() => (pointer.current = null)}
        onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          const at = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
          [...e.dataTransfer.files].forEach((dropped, index) => upload(dropped, { x: at.x + index * 400, y: at.y }));
        }}
      >
        <ReactFlow
          nodes={shown}
          // 选中的节点不自动提到最上面：分组的框要一直垫在成员下面。
          elevateNodesOnSelect={false}
          // 署名放到右上角：默认的右下角会压在靠右的节点输入面板的发送键上。
          attributionPosition="top-right"
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={changeNodes}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          isValidConnection={isValidConnection}
          // 按下就算开始拖，节点从第一下就跟着鼠标走，不丢开头那一小段。
          // 这样点一下也会被当成「开始拖」，所以撤销用的那一下先记着，真的挪动了才算数。
          nodeDragThreshold={0}
          onNodeDragStart={() => (grabbed.current = { nodes: flow.getNodes(), edges: flow.getEdges() })}
          onNodeDrag={() => {
            if (!grabbed.current) return;
            past.current.push(grabbed.current);
            if (past.current.length > MAX_UNDO) past.current.shift();
            future.current = [];
            grabbed.current = null;
            setUndoDepth((n) => n + 1);
          }}
          onNodeDragStop={() => {
            grabbed.current = null;
            setGuides([]);
          }}
          connectionLineComponent={DragLine}
          onBeforeDelete={async ({ nodes: gone, edges: cut }) => {
            snap();
            // 删掉一叠，里面的节点和它们的连线一起删。
            const inside = new Set(gone.filter(isStack).flatMap(membersOf));
            if (!inside.size) return true;
            const have = new Set(cut.map((edge) => edge.id));
            return { nodes: [...gone, ...flow.getNodes().filter((node) => inside.has(node.id))], edges: [...cut, ...flow.getEdges().filter((edge) => !have.has(edge.id) && (inside.has(edge.source) || inside.has(edge.target)))] };
          }}
          onMoveEnd={() => setMoved((n) => n + 1)}
          onPaneContextMenu={(e) => {
            e.preventDefault();
            paneMenu(e.clientX, e.clientY);
          }}
          onNodeContextMenu={(e, node) => {
            // 输入面板、文本框里的右键留给浏览器（粘贴、拼写这些）。
            if ((e.target as Element).closest('input, textarea, .cnode-panel')) return;
            e.preventDefault();
            nodeMenu(e.clientX, e.clientY, node);
          }}
          onSelectionContextMenu={(e) => {
            e.preventDefault();
            nodeMenu(e.clientX, e.clientY);
          }}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          deleteKeyCode={['Backspace', 'Delete']}
          zoomOnDoubleClick={false}
          connectOnClick={false}
          panOnScroll
          selectionOnDrag={!hand}
          nodesDraggable={!hand}
          elementsSelectable={!hand}
          panOnDrag={hand ? true : [1, 2]}
          selectionMode={SelectionMode.Partial}
          // 按住 Shift 或 ⌘ 点击是多选。在空白处拖动本来就是框选，不需要再按 Shift。
          multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
          selectionKeyCode={null}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} />
          {guides.length > 0 && (
            <ViewportPortal>
              <svg className="canvas-guides" aria-hidden="true">
                {spanned.map((line) => (
                  <line key={`${line.x1},${line.y1},${line.x2},${line.y2}`} {...line} />
                ))}
              </svg>
            </ViewportPortal>
          )}
          {loose && (
            <ViewportPortal>
              <svg className="canvas-guides" aria-hidden="true">
                <path className="canvas-loose" d={getBezierPath({ sourceX: loose.fromX, sourceY: loose.fromY, sourcePosition: loose.downstream ? Position.Right : Position.Left, targetX: loose.toX, targetY: loose.toY, targetPosition: loose.downstream ? Position.Left : Position.Right })[0]} />
              </svg>
            </ViewportPortal>
          )}
          {showMap && <MiniMap pannable zoomable position="bottom-right" style={{ width: 168, height: 112 }} />}
          {finding && (
            <Panel position="top-center" className="canvas-find">
              <Finder nodes={nodes.filter((node) => !isGroup(node) && !isStack(node) && !node.hidden)} onJump={jumpTo} onClose={() => setFinding(false)} />
            </Panel>
          )}
          <Panel position="top-left" className="canvas-title">
            <button className="icon-btn" type="button" {...tip('返回画布列表')} aria-label="返回画布列表" onClick={exit}>
              <Icon name="arrowLeft" />
            </button>
            <input className="canvas-name" value={name} aria-label="画布名称" maxLength={60} spellCheck={false} onChange={(e) => setName(e.target.value)} onBlur={() => !name.trim() && setName('未命名画布')} />
            <button className="icon-btn icon-btn-sm canvas-switch" type="button" {...tip('切换画布')} aria-label="切换画布" aria-haspopup="listbox" aria-expanded="false" onClick={(e) => switchCanvas(e.currentTarget)}>
              <Icon name="chevron" size={14} />
            </button>
            {PINS.filter((pin) => pinned[pin].length).map((pin) => (
              <button
                key={pin}
                className="canvas-pin"
                type="button"
                {...tip(`${PIN_LABELS[pin]}标记的节点`)}
                aria-label={`${PIN_LABELS[pin]}标记：${pinned[pin].length} 个节点`}
                aria-haspopup="menu"
                aria-expanded="false"
                onClick={(e) => openMenu(e.currentTarget, { label: `${PIN_LABELS[pin]}标记`, items: pinned[pin].map((node) => ({ value: node.id, label: `${NODE_LABELS[node.type as NodeKind]}${node.data.no ? ` ${node.data.no}` : ''}`, note: String(node.data.prompt || node.data.text || '').slice(0, 14) })), onSelect: jumpTo })}
              >
                <span className={`cpin is-${pin}`} />
                {pinned[pin].length}
              </button>
            ))}
            {saving === 'failed' ? (
              <button className="canvas-saved is-failed" type="button" onClick={flush}>
                保存失败，点击重试
              </button>
            ) : (
              <span className="canvas-saved" role="status">
                {saving === 'saving' ? '保存中…' : '已保存'}
              </span>
            )}
          </Panel>
          <Panel position="center-left" className="canvas-tools">
            {KINDS.map((kind) => (
              <button key={kind} className="icon-btn" type="button" aria-label={`添加${NODE_LABELS[kind]}节点`} onClick={() => addNode(kind)}>
                <Icon name={NODE_ICONS[kind]} size={18} />
                <span className="canvas-tool-name">{NODE_LABELS[kind]}</span>
              </button>
            ))}
            <span className="canvas-tools-split" />
            <button className="icon-btn" type="button" aria-label="上传图片、视频或音频" onClick={() => file.current!.click()}>
              <Icon name="upload" size={18} />
              <span className="canvas-tool-name">上传</span>
            </button>
            <button className="icon-btn" type="button" aria-label="生成历史" aria-haspopup="dialog" aria-expanded="false" onClick={(e) => openBeside(e.currentTarget, <HistoryPicker onPick={restore} />, '生成历史')}>
              <Icon name="history" size={18} />
              <span className="canvas-tool-name">生成历史</span>
            </button>
            <button className="icon-btn" type="button" aria-label="工作流" aria-haspopup="dialog" aria-expanded="false" onClick={(e) => {
                // 放上一份就收起：一般一次只放一份，面板开着时焦点在它里面，⌘ Z 也不归画布管。生成历史常要连着放几条，不收。
                const layer = openBeside(
                  e.currentTarget,
                  <WorkflowPicker
                    onPick={(id) => {
                      layer?.close();
                      applyWorkflow(id);
                    }}
                  />,
                  '工作流',
                );
              }}
            >
              <Icon name="workflow" size={18} />
              <span className="canvas-tool-name">工作流</span>
            </button>
            <button className={`icon-btn ${finding ? 'active' : ''}`} type="button" aria-label="搜索节点" aria-pressed={finding} onClick={() => setFinding((on) => !on)}>
              <Icon name="search" size={18} />
              <span className="canvas-tool-name">搜索节点</span>
            </button>
          </Panel>
          <Panel position="bottom-left" className="canvas-foot">
            <button className="icon-btn" type="button" {...tip('撤销（⌘ Z）')} aria-label="撤销" disabled={!past.current.length} onClick={undo}>
              <Icon name="undo" />
            </button>
            <button className="icon-btn" type="button" {...tip('重做（⇧ ⌘ Z）')} aria-label="重做" disabled={!future.current.length} onClick={redo}>
              <Icon name="redo" />
            </button>
            <button className={`icon-btn ${hand ? 'active' : ''}`} type="button" {...tip(hand ? '选择（V）' : '抓手（H）')} aria-label="抓手" aria-pressed={hand} onClick={() => setHand((on) => !on)}>
              <Icon name="hand" />
            </button>
            <button className="icon-btn" type="button" {...tip('整理节点')} aria-label="整理节点" disabled={nodes.length < 2} onClick={arrange}>
              <Icon name="grid" />
            </button>
            <button className={`icon-btn ${showMap ? 'active' : ''}`} type="button" {...tip('小地图')} aria-label="小地图" aria-pressed={showMap} onClick={() => setShowMap((on) => !on)}>
              <Icon name="map" />
            </button>
            <button className="canvas-zoom" type="button" aria-label={`缩放：${Math.round(zoom * 100)}%`} aria-haspopup="menu" aria-expanded="false" onClick={(e) => openZoom(e.currentTarget)}>
              {Math.round(zoom * 100)}%
            </button>
          </Panel>
          {selectedNodes.length > 1 && (
            <Panel position="bottom-center" className="canvas-batch-bar nodrag">
              <span className="batch-badge">已选 {selectedNodes.length} 个节点</span>
              <button className="batch-btn is-primary" type="button" onClick={batchRun} {...tip('按顺序批量生成所选节点')}>
                <span>批量生成</span>
              </button>
              <span className="batch-split" />
              <button className="batch-btn" type="button" onClick={(e) => openAlignMenu(e.currentTarget)} {...tip('对齐与等间距分布')}>
                <span>对齐分布</span>
                <Icon name="chevron" size={12} />
              </button>
              <button className="batch-btn" type="button" onClick={group} {...tip('将所选节点打成一组（⌘ G）')}>
                <span>打组</span>
              </button>
              <button className="batch-btn" type="button" onClick={stack} {...tip('收为一叠，节省画布空间')}>
                <span>堆叠</span>
              </button>
              <button className="batch-btn" type="button" onClick={duplicate} {...tip('创建副本并继承上游连线（⌘ D）')}>
                <span>复制</span>
              </button>
              <span className="batch-split" />
              <button className="batch-btn is-danger" type="button" onClick={batchDelete} {...tip('删除所选节点（⌫）')}>
                <span>删除</span>
              </button>
            </Panel>
          )}
        </ReactFlow>
        {ready && !nodes.length && (
          <div className="canvas-empty">
            <span>双击画布</span>
            <span className="brand-mark" aria-hidden="true" />
            <span>创建节点</span>
          </div>
        )}
        <input
          ref={file}
          type="file"
          accept={UPLOAD_ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            const at = dropAt.current;
            dropAt.current = undefined;
            [...(e.target.files || [])].forEach((picked, index) => upload(picked, at && { x: at.x + index * 400, y: at.y }));
            e.target.value = '';
          }}
        />
        <span ref={anchor} className="canvas-anchor" />
      </div>
    </CanvasActions.Provider>
  );
}

export default function Canvas(props: { id: string; onExit: () => void }) {
  return (
    <ReactFlowProvider>
      <Board {...props} />
    </ReactFlowProvider>
  );
}
