// 画布的数据：节点、连线，以及「连线怎么变成一次生成请求」的规则。纯函数，不碰页面和网络，可以单独测试。

import type { Kind, Ref, VideoForm } from '../types.ts';

export type NodeKind = 'text' | 'image' | 'video' | 'audio';
// 画布上还有一种不放内容的节点：分组的框。
export const isGroup = (node: { type?: string }) => node.type === 'group';
// 堆叠：把一批节点收成一叠，只占一个节点的位置（type 是 stack）。data.members 记着里面有哪些节点；
// 成员还在画布上、连线也还在，只是收起来不画（hidden）。
export const isStack = (node: { type?: string }) => node.type === 'stack';
export interface StackData {
  no?: number;
  members: string[];
}
export const MAX_STACK = 50;
// 颜色标记：一个节点可以标一种或几种颜色，左上角按颜色汇总、点了定位。
export const PINS = ['red', 'yellow', 'green', 'blue'] as const;
export type Pin = (typeof PINS)[number];
export const PIN_LABELS: Record<Pin, string> = { red: '红色', yellow: '黄色', green: '绿色', blue: '蓝色' };
// 图片连到视频节点时当什么用。
export type FrameRole = 'reference' | 'first' | 'last';

// 文本节点：text 是节点里的内容，可以自己写，也可以让文本模型写；prompt 是给模型的要求，model 是用哪个文本模型。
export interface TextData {
  // 名字后面的编号。
  no?: number;
  text: string;
  prompt?: string;
  model?: string;
  busy?: string;
  error?: string;
}
// 节点里曾经有过、后来被换掉的那一份内容。就地替换时旧的退到这里，「更多 → 历史版本」里随时换得回来。
export interface Kept {
  recordId?: string;
  upload?: { url: string; name: string };
  // 换下来的时间。生成记录本身还有生成时间，列表里有记录就用记录的时间。
  at: number;
}
// 每个节点留最近这么几份，再多就扔掉最早的：生成记录本身还在创作记录里，不会真丢。
export const KEPT_LIMIT = 12;

// 节点里的内容有两种来历，只会有一种：recordId 是在这个节点上生成的那条生成记录；upload 是从本机上传的文件。
// busy、error 只在页面打开期间有，不存进画布。
export interface Generated {
  // 名字后面的编号。
  no?: number;
  recordId?: string;
  upload?: { url: string; name: string };
  // 这个节点再次生成的结果放在哪：true 就地替换，false 另开一个新节点。不写就跟随设置里的默认（另开新节点）。
  inPlace?: boolean;
  // 换下来的内容，最近的在前。
  kept?: Kept[];
  busy?: string;
  error?: string;
}

// 节点现在放着的那一份内容。空节点是 null。
export function contentOf(data: { recordId?: string; upload?: { url: string; name: string } }): Kept | null {
  if (data.recordId) return { recordId: data.recordId, at: 0 };
  if (data.upload) return { upload: data.upload, at: 0 };
  return null;
}

const sameKept = (a: Kept, b: Kept | null) => Boolean(b && ((a.recordId != null && a.recordId === b.recordId) || (a.upload != null && b.upload != null && a.upload.url === b.upload.url)));

// 换掉内容之前先留底：旧的挪进 kept 最前面，同一份不重复记，新的那份（换回来时就是它自己）从历史里去掉。
// 换的是同一份内容（比如重试同一条记录）就原样返回，不记历史。
export function keepBefore<T extends { recordId?: string; upload?: { url: string; name: string } }>(data: Generated, patch: T): T & { kept?: Kept[] } {
  const old = contentOf(data);
  const next = contentOf(patch);
  if (!old || sameKept(old, next)) return patch;
  const rest = (data.kept || []).filter((item) => !sameKept(item, old) && !sameKept(item, next));
  return { ...patch, kept: [{ ...old, at: Date.now() }, ...rest].slice(0, KEPT_LIMIT) };
}

// 这个节点的历史版本。老存档里还有一个只记上传原图的 origin，并进来看。
export function keptOf(data: Generated): Kept[] {
  const list = data.kept || [];
  const legacy = (data as { origin?: { url: string; name: string } }).origin;
  return legacy && !list.some((item) => item.upload?.url === legacy.url) ? [...list, { upload: legacy, at: 0 }] : list;
}
export interface ImageData extends Generated {
  prompt: string;
  model: string;
  ratio: string;
  // 分辨率档位（1K、2K 这样）。不写就用模型默认的那一档。
  resolution?: string;
  // 画质。只有分画质的模型才有，不写就用模型默认的那一档。
  quality?: string;
  // 一次生成几张。不写就是一张。
  count?: number;
  // 节点里那张图实际的宽高比，图片读出来之后记下，节点的框按它定宽度。
  aspect?: number;
  ignoreSelfRef?: boolean;
  // 模型是 AutoDL 的工作流时，节点上选的参数（模式、风格…），键是工作流规则里的参数名。
  flowValues?: Record<string, unknown>;
}
export interface VideoData extends Generated {
  prompt: string;
  model: string;
  resolution: string;
  ratio: string;
  duration: number;
  // 时长交给模型决定（发 -1）。方舟的模型都支持；不写就是按 duration 的秒数生成。
  durationAuto?: boolean;
  // 生成方式：全能参考（不写就是它）、首尾帧、编辑视频、延长视频。模型不支持的会在 fitVideo 里退回全能参考。
  mode?: VideoForm['mode'];
  // 要不要生成声音。不写就是有声（和创作页的默认一致）。模型不支持时（MiniMax）发不出去，界面上也不显示。
  generateAudio?: boolean;
  // 随机种子。空着就是每次随机。模型不支持时界面上不显示。
  seed?: string;
  // 一次生成几段。不写就是一段。
  count?: number;
  // 节点里那段视频实际的宽高比，读到之后记下，节点的框按它定宽度。
  aspect?: number;
  selfFrame?: { url: string; name: string };
  selfRole?: 'reference';
  // 模型是 AutoDL 的工作流时，节点上额外选的参数（模式、风格、开关…），键就是工作流规则里的参数名。
  flowValues?: Record<string, unknown>;
}
export interface AudioData extends Generated {
  tool: 'speech' | 'sfx';
  // 选的是 AutoDL 的音频工作流时，模型是 flow:<uuid>，参数放在 flowValues。不是工作流时不写。
  model?: string;
  flowValues?: Record<string, unknown>;
  prompt: string;
  voiceId: string;
  voiceName: string;
}

export interface LinkData {
  // 连线起点是哪种节点。
  kind: NodeKind;
  role?: FrameRole;
}

export const NODE_LABELS: Record<NodeKind, string> = { text: '文本', image: '图片', video: '视频', audio: '音频' };
export const ROLE_LABELS: Record<FrameRole, string> = { reference: '参考图', first: '首帧', last: '尾帧' };

// 哪种节点能连到哪种节点。文本是提示词，可以给任何会生成的节点，连到另一个文本节点是给模型当参考内容；图片可以给视频和图片当参考图（图片连图片是图生图，要目标模型收参考图才行）；视频、音频只能给视频当参考素材。
const TARGETS: Record<NodeKind, NodeKind[]> = {
  text: ['text', 'image', 'video', 'audio'],
  image: ['image', 'video'],
  video: ['video'],
  audio: ['video'],
};
export const canLink = (source: NodeKind, target: NodeKind) => TARGETS[source].includes(target);
export const targetsOf = (source: NodeKind) => TARGETS[source];
// 哪些节点能连进它。
export const sourcesOf = (target: NodeKind) => (Object.keys(TARGETS) as NodeKind[]).filter((source) => TARGETS[source].includes(target));

// 连线上显示的字。文本连线不标。role 只有连到视频的图片才有；连到图片的都是参考图。
export function linkLabel(link: LinkData) {
  if (link.kind === 'image') return ROLE_LABELS[link.role || 'reference'];
  if (link.kind === 'video') return '参考视频';
  if (link.kind === 'audio') return '参考音频';
  return '';
}

// 上游文本节点的内容在前，节点自己写的在后，各占一段。
export const joinPrompt = (upstream: string[], own: string) => [...upstream, own].map((t) => t.trim()).filter(Boolean).join('\n');

// ---------- 提示词里的 @ 引用 ----------

// 提示词里可以用「@图片 1」这样的写法指名一个连进来的节点。发请求之前把它换成模型看得懂的说法：
// 图片、视频、音频换成它在这次请求里排第几个（图1、视频2），因为模型只知道参考素材的先后顺序；
// 文本节点直接换成它里面的字，这个文本节点就不再整段拼到提示词前面了（inlined 里记着是哪几个）。
// 指的节点没连进来，就原样留着。
// labels：有些模型不认「图1」，要写成 <Picture 1>（海螺 H3 那套工作流就是这样）。给了模板就按模板生成，
// 模板里的 {n} 换成上面的序号。工作流登记表里写着用哪种（RhWorkflow.mentions）。
export interface Mentionable {
  // 节点的名字，例如「图片 1」。
  name: string;
  kind: NodeKind;
  text?: string;
}
export type MentionLabels = Partial<Record<NodeKind, string>>;
const MENTION = /@(文本|图片|视频|音频) ?(\d+)/g;
const ORDER_NAMES: Record<NodeKind, string> = { text: '文本', image: '图', video: '视频', audio: '音频' };
export function resolveMentions(prompt: string, inputs: Mentionable[], labels?: MentionLabels): { prompt: string; inlined: Set<string> } {
  const inlined = new Set<string>();
  const seen: Partial<Record<NodeKind, number>> = {};
  const order = new Map<string, number>();
  for (const input of inputs) order.set(input.name, (seen[input.kind] = (seen[input.kind] || 0) + 1));
  const resolved = prompt.replace(MENTION, (whole, label: string, no: string) => {
    const name = `${label} ${no}`;
    const input = inputs.find((item) => item.name === name);
    if (!input) return whole;
    if (input.kind !== 'text') {
      const n = order.get(name);
      const template = labels?.[input.kind];
      return template ? template.replace('{n}', String(n)) : `${ORDER_NAMES[input.kind]}${n}`;
    }
    inlined.add(name);
    return (input.text || '').trim();
  });
  return { prompt: resolved, inlined };
}

// ---------- 斜杠预设 ----------

// 图片节点的提示词里打一个 /，列出这些现成的任务：选一个就用它的提示词直接生成，不用自己写。
// needsRef：要有一张连进来的参考图才做得了（基于已有的画面去变）。
export interface Preset {
  id: string;
  label: string;
  note: string;
  needsRef: boolean;
  prompt: string;
}
const KEEP = '参考图里的主体、场景、道具、光线和画风都保持一致；有人物的话，长相、服装、发型不变，不要添加参考图里没有的人和物。';
export const IMAGE_PRESETS: Preset[] = [
  { id: 'grid9', label: '多机位九宫格', note: '同一场景的九个机位', needsRef: true, prompt: `根据参考图生成一张 3×3 的九宫格图。九格是同一个场景、同一时刻的九个不同机位和景别，例如远景、全景、中景、近景、特写、俯拍、仰拍、侧面。${KEEP}九格大小一致、排列整齐，格与格之间用细白线隔开，不要任何文字和编号。` },
  { id: 'grid4', label: '剧情推演四宫格', note: '接下来的四个连续画面', needsRef: true, prompt: `根据参考图生成一张 2×2 的四宫格图，是从参考图这一刻往后发展的四个连续画面，按从左到右、从上到下的顺序推进剧情，每格换一个合适的景别。${KEEP}四格大小一致，格与格之间用细白线隔开，不要任何文字和编号。` },
  { id: 'views3', label: '角色三视图', note: '正面、侧面、背面', needsRef: true, prompt: '根据参考图里的角色生成一张三视图：同一个角色的正面、侧面、背面全身站姿，从左到右并排，比例一致，站在同一条地平线上。角色的长相、发型、服装、配饰和参考图完全一致。纯白背景，均匀的平光，不要任何文字。' },
  { id: 'sheet', label: '角色设定图', note: '全身立绘加表情和细节', needsRef: false, prompt: '生成一张角色设定图：左侧是角色的全身立绘，右侧是三个头部表情特写（平静、微笑、生气）和服装、配饰的细节特写。画风统一，纯白背景，排版整齐，不要任何文字。' },
  { id: 'after3', label: '画面推演：3 秒后', note: '顺着当前画面往后', needsRef: true, prompt: `生成参考图这个画面 3 秒之后的样子：按画面里正在发生的动作自然地往后发展，机位和构图基本不变。${KEEP}` },
  { id: 'before5', label: '画面推演：5 秒前', note: '倒回当前画面之前', needsRef: true, prompt: `生成参考图这个画面 5 秒之前的样子：按画面里正在发生的动作合理地倒推回去，机位和构图基本不变。${KEEP}` },
  { id: 'relight', label: '电影级光影', note: '只改光，不改内容', needsRef: true, prompt: '保持参考图的构图、人物、场景和所有内容完全不变，只重新打光：电影感的主光和轮廓光，明暗层次分明，阴影柔和干净，色调统一有氛围。' },
  { id: 'board', label: '故事板', note: '把一段剧情画成连续分镜', needsRef: false, prompt: '把下面这段剧情画成一张故事板：2×3 六格连续分镜，按从左到右、从上到下的顺序，每格一个镜头，景别和机位有变化，人物和场景前后一致。格与格之间用细白线隔开，不要任何文字。剧情：' },
];

// 扩图用的提示词。发给模型的参考图是已经放大了画布的一张：原图在中间，四周是灰色的空白。
export const OUTPAINT_PROMPT = '参考图中间是一张原图，四周的纯灰色区域是空白。把灰色区域补全成原图画面向外的自然延伸：内容、透视、光线、色调和画风与原图连贯一致，看不出拼接的痕迹。原图部分的内容保持不变，最后的画面里不能留下任何灰色空白和边框。';

export interface MediaInput {
  kind: Kind;
  role: FrameRole;
  ref: Ref;
}

// 把连进视频节点的素材排成视频表单里的首尾帧和参考素材。
// 生成方式按节点上选的来（没选过就是全能参考）；老节点没选过方式、但连线标了首帧/尾帧用途的，按首尾帧生成。
export function videoFormFrom(base: VideoForm, data: VideoData, prompt: string, inputs: MediaInput[]): { form: VideoForm; problems: string[] } {
  const problems: string[] = [];
  const images = inputs.filter((i) => i.kind === 'image');
  // 生成方式按节点上选的来；没选过的老节点按连线推：标了首帧/尾帧用途是首尾帧，连了素材是全能参考，什么都没有是文生视频。
  const mode: VideoForm['mode'] = data.mode ?? (images.some((i) => i.role !== 'reference') ? 'frames' : inputs.length ? 'reference' : 'text');
  const form: VideoForm = {
    ...base,
    prompt,
    model: data.model,
    resolution: data.resolution,
    ratio: data.ratio,
    duration: data.duration,
    durationAuto: data.durationAuto === true,
    // 声音和种子是节点上选的；没选过就按创作页的默认（有声、随机）。
    generateAudio: data.generateAudio !== false,
    seed: data.seed || '',
    mode,
    frames: { first: null, last: null },
    refs: { image: [], video: [], audio: [] },
  };
  if (mode === 'frames') {
    // 首尾帧：连线标了首帧/尾帧用途的按用途来；都没标就按连线顺序，第一张是首帧、第二张是尾帧（模型不支持尾帧时请求拼装会丢掉）。
    const firsts = images.filter((i) => i.role === 'first');
    const lasts = images.filter((i) => i.role === 'last');
    if (firsts.length || lasts.length) {
      form.frames = { first: firsts[0]?.ref || null, last: lasts[0]?.ref || null };
      if (firsts.length > 1) problems.push('首帧只能有一张');
      if (lasts.length > 1) problems.push('尾帧只能有一张');
      if (!firsts.length) problems.push('只有尾帧不够，还需要一张首帧');
      if (inputs.length > firsts.length + lasts.length) problems.push('首尾帧与参考素材不能同时使用');
    } else {
      form.frames = { first: images[0]?.ref || null, last: images[1]?.ref || null };
      if (!images.length) problems.push('首尾帧方式需要连图片节点，或换回全能参考');
      if (inputs.length > images.length) problems.push('首尾帧只能用图片，视频和音频请换回全能参考');
    }
  } else if (mode === 'edit' || mode === 'extend') {
    // 编辑/延长：连进来的素材都当参考，但必须有一段视频当原片；编辑的成片时长跟原片走。
    for (const input of inputs) form.refs[input.kind].push(input.ref);
    if (!form.refs.video.length) problems.push(mode === 'edit' ? '编辑视频要连一段视频节点当原片' : '延长视频要连一段视频节点当原片');
    if (mode === 'edit') form.durationAuto = true;
  } else {
    for (const input of inputs) form.refs[input.kind].push(input.ref);
  }
  return { form, problems };
}

// 存进画布之前去掉只在页面上有意义的东西。
export function stripNodeData<T extends object>(data: T): T {
  const { busy: _busy, error: _error, autofocus: _autofocus, ...rest } = data as T & Generated & { autofocus?: boolean };
  return rest as T;
}

// ---------- 节点的大小 ----------

// 所有节点的框一样高。空着的时候形状是固定的：文本和图片是方的，视频是 16:9，音频宽 320，不跟着参数里选的比例变。
// 图片、视频有了内容（上传的、生成出来的），框才按它实际的宽高比定宽，太窄太宽的收在一个范围里。
export const BOX_HEIGHT = 240;
// 节点的名字那一行加上它和框之间的空隙，一共占多高。
export const TITLE_ROOM = 24;
export function nodeWidth(kind: NodeKind, data: { aspect?: number } = {}) {
  if (kind === 'text') return BOX_HEIGHT;
  if (kind === 'audio') return 320;
  const shape = data.aspect || (kind === 'video' ? 16 / 9 : 1);
  return Math.round(Math.min(560, Math.max(150, BOX_HEIGHT * shape)));
}

// 框变宽之后给右边腾位置。
// 框的宽度是按内容的实际比例算的：图片 1:1 是 240，换成一张 16:9 的（上传的、生成出来的）就变成 427。
// 位置是记死的，框一宽就伸到右边那个节点底下，把连到它的线整个压在框底下——看上去就是「线没了」。
// 所以变宽多少，右边同一排的节点就整体右移多少，原来的间距一点不变；窄了不往回拉，留给用户自己整理。
export function makeRoom(
  nodes: { id: string; position: { x: number; y: number }; width: number }[],
  changed: { id: string; position: { x: number; y: number } },
  oldWidth: number,
  newWidth: number,
): Map<string, { x: number; y: number }> {
  const moved = new Map<string, { x: number; y: number }>();
  const delta = newWidth - oldWidth;
  if (delta <= 0) return moved;
  const right = changed.position.x + oldWidth;
  const top = changed.position.y;
  for (const node of nodes) {
    if (node.id === changed.id) continue;
    // 只动同一排的：上下有一段重叠就算一排。
    if (node.position.y >= top + TITLE_ROOM + BOX_HEIGHT || node.position.y + TITLE_ROOM + BOX_HEIGHT <= top) continue;
    // 本来就在左边（或者早就压着了）的不动。
    if (node.position.x < right) continue;
    moved.set(node.id, { x: node.position.x + delta, y: node.position.y });
  }
  return moved;
}

// ---------- 拖动时对齐 ----------

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
// 一条参考线：画布坐标里的一段横线或竖线。
export interface Guide {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// 拖着的那个框靠近别的框时吸过去：左、中、右和上、中、下各三条线，离得最近的一条在 reach 以内就对上。
// 返回要挪多少，以及对上的那几条参考线。参考线画在两个框之间的空当里；两个框在那个方向上有重叠时，画满它们合起来的范围。
export function snapTo(moving: Rect, others: Rect[], reach: number): { dx: number; dy: number; guides: Guide[] } {
  const marks = (start: number, size: number) => [start, start + size / 2, start + size];
  const nearest = (axis: 'x' | 'y') => {
    const size = axis === 'x' ? 'width' : 'height';
    let best = 0;
    let gap = reach;
    let found = false;
    for (const other of others)
      for (const mine of marks(moving[axis], moving[size]))
        for (const theirs of marks(other[axis], other[size])) {
          const d = Math.abs(theirs - mine);
          if (d < gap || (d === gap && !found && d <= reach)) {
            gap = d;
            best = theirs - mine;
            found = true;
          }
        }
    return found ? best : null;
  };
  const dx = nearest('x');
  const dy = nearest('y');
  const moved = { ...moving, x: moving.x + (dx || 0), y: moving.y + (dy || 0) };
  const guides: Guide[] = [];
  const same = (a: number, b: number) => Math.abs(a - b) < 0.01;
  const span = (aStart: number, aSize: number, bStart: number, bSize: number) => {
    const inner = [Math.min(aStart + aSize, bStart + bSize), Math.max(aStart, bStart)];
    return inner[0] < inner[1] ? inner : [Math.min(aStart, bStart), Math.max(aStart + aSize, bStart + bSize)];
  };
  for (const other of others) {
    if (dx !== null)
      for (const x of marks(other.x, other.width))
        if (marks(moved.x, moved.width).some((mine) => same(mine, x))) {
          const [y1, y2] = span(moved.y, moved.height, other.y, other.height);
          guides.push({ x1: x, y1, x2: x, y2 });
        }
    if (dy !== null)
      for (const y of marks(other.y, other.height))
        if (marks(moved.y, moved.height).some((mine) => same(mine, y))) {
          const [x1, x2] = span(moved.x, moved.width, other.x, other.width);
          guides.push({ x1, y1: y, x2, y2: y });
        }
  }
  return { dx: dx || 0, dy: dy || 0, guides };
}

// ---------- 一键整理 ----------

const COLUMN_GAP = 120;
const ROW_GAP = 56;
const LOOSE_GAP = 80;
// 零散的节点一行最多排几个。
const LOOSE_PER_ROW = 6;

// 把节点按连线排整齐：上游在左、下游在右，一列一列对齐；同一列里按上游的次序排，线尽量不交叉。
// 连在一起的一串节点是一组，各组从上往下排；没有连线的零散节点在最下面排成一行。整理之后的左上角还在原来的左上角。
export function tidy(nodes: { id: string; position: { x: number; y: number }; width: number }[], edges: { source: string; target: string }[]): Map<string, { x: number; y: number }> {
  const placed = new Map<string, { x: number; y: number }>();
  if (!nodes.length) return placed;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const links = edges.filter((edge) => byId.has(edge.source) && byId.has(edge.target));
  const ins = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  const outs = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  for (const { source, target } of links) {
    ins.get(target)!.push(source);
    outs.get(source)!.push(target);
  }
  // 连在一起的分成一组。
  const groupOf = new Map<string, number>();
  let groups = 0;
  for (const node of nodes) {
    if (groupOf.has(node.id)) continue;
    const stack = [node.id];
    while (stack.length) {
      const id = stack.pop()!;
      if (groupOf.has(id)) continue;
      groupOf.set(id, groups);
      stack.push(...ins.get(id)!, ...outs.get(id)!);
    }
    groups++;
  }
  // 第几列：离最远的源头隔着几条线。连线不会成圈，所以算得完。
  const column = new Map<string, number>();
  const columnOf = (id: string): number => {
    if (!column.has(id)) {
      column.set(id, 0);
      column.set(id, Math.max(0, ...ins.get(id)!.map((from) => columnOf(from) + 1)));
    }
    return column.get(id)!;
  };
  nodes.forEach((node) => columnOf(node.id));

  const rowStep = TITLE_ROOM + BOX_HEIGHT + ROW_GAP;
  const left = Math.min(...nodes.map((node) => node.position.x));
  let top = Math.min(...nodes.map((node) => node.position.y));
  const byPlace = (a: string, b: string) => byId.get(a)!.position.y - byId.get(b)!.position.y || byId.get(a)!.position.x - byId.get(b)!.position.x;
  const members = Array.from({ length: groups }, () => [] as string[]);
  for (const node of nodes) members[groupOf.get(node.id)!].push(node.id);
  const linked = members.filter((ids) => ids.length > 1).sort((a, b) => Math.min(...a.map((id) => byId.get(id)!.position.y)) - Math.min(...b.map((id) => byId.get(id)!.position.y)));
  const loose = members.filter((ids) => ids.length === 1).map((ids) => ids[0]).sort((a, b) => byId.get(a)!.position.x - byId.get(b)!.position.x || byPlace(a, b));

  for (const ids of linked) {
    const columns: string[][] = [];
    for (const id of ids) (columns[column.get(id)!] ||= []).push(id);
    const row = new Map<string, number>();
    let x = left;
    columns.forEach((list, index) => {
      // 第一列按现在的上下次序；后面的每一列按上游节点排在第几行。
      const weight = (id: string) => {
        const from = ins.get(id)!.filter((source) => row.has(source));
        return from.length ? from.reduce((sum, source) => sum + row.get(source)!, 0) / from.length : Infinity;
      };
      list.sort((a, b) => (index ? weight(a) - weight(b) : 0) || byPlace(a, b));
      list.forEach((id, n) => {
        row.set(id, n);
        placed.set(id, { x, y: top + n * rowStep });
      });
      x += Math.max(...list.map((id) => byId.get(id)!.width)) + COLUMN_GAP;
    });
    top += Math.max(...columns.map((list) => list.length)) * rowStep;
  }
  let x = left;
  loose.forEach((id, index) => {
    if (index && index % LOOSE_PER_ROW === 0) {
      x = left;
      top += rowStep;
    }
    placed.set(id, { x, y: top });
    x += byId.get(id)!.width + LOOSE_GAP;
  });
  return placed;
}

// ---------- 节点的编号 ----------

// 节点的名字带编号（图片 1、图片 2），每种节点各排各的。编号定下来就不变，删掉前面的也不往前补。
// 这里给还没有编号的节点排上号，接在这一种已有的最大编号后面。
export function numbered<T extends { type?: string; data: Record<string, unknown> }>(nodes: T[], existing: { type?: string; data: Record<string, unknown> }[] = []): T[] {
  const last = new Map<string, number>();
  for (const node of [...existing, ...nodes]) last.set(node.type || '', Math.max(last.get(node.type || '') || 0, Number(node.data.no) || 0));
  return nodes.map((node) => {
    if (Number(node.data.no) > 0) return node;
    const no = (last.get(node.type || '') || 0) + 1;
    last.set(node.type || '', no);
    return { ...node, data: { ...node.data, no } };
  });
}

// ---------- 分组 ----------

// 分组是一个只画框的节点（type 是 group）：data.members 记着组里有哪些节点，data.name 是组名。
// 组里的节点位置照旧各记各的，框的位置和大小不存，每次按成员现在占的范围算出来。
export interface GroupData {
  no?: number;
  name?: string;
  members: string[];
}
// 框比成员占的范围四周各大出这么多。
export const GROUP_PAD = 24;
// 一组成员（每个给出整个节点占的位置，含名字那一行）合起来的框。没有成员就是 null。
export function groupFrame(members: Rect[]): Rect | null {
  if (!members.length) return null;
  const left = Math.min(...members.map((m) => m.x));
  const top = Math.min(...members.map((m) => m.y));
  const right = Math.max(...members.map((m) => m.x + m.width));
  const bottom = Math.max(...members.map((m) => m.y + m.height));
  return { x: left - GROUP_PAD, y: top - GROUP_PAD, width: right - left + GROUP_PAD * 2, height: bottom - top + GROUP_PAD * 2 };
}

// 一批节点按连线的先后排个序：上游在前、下游在后，执行整组时照这个顺序来。线两头有一头不在这批里的不算。
export function runOrder(ids: string[], edges: { source: string; target: string }[]): string[] {
  const inside = new Set(ids);
  const waits = new Map(ids.map((id) => [id, 0]));
  const next = new Map(ids.map((id) => [id, [] as string[]]));
  for (const { source, target } of edges) {
    if (!inside.has(source) || !inside.has(target)) continue;
    waits.set(target, waits.get(target)! + 1);
    next.get(source)!.push(target);
  }
  const ready = ids.filter((id) => !waits.get(id));
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const target of next.get(id)!) {
      waits.set(target, waits.get(target)! - 1);
      if (!waits.get(target)) ready.push(target);
    }
  }
  return order;
}

// ---------- 再次生成 ----------

// 一个节点生成出 results 份结果，各放在哪。
// 节点还空着：第一份放进它自己，多出来的每份一个新节点。节点里已经有内容：原来的留着不动，每份结果都是新节点。
// 新节点和原节点左边对齐，从它下面一行一行往下排，跳过已经有节点的位置。返回的 here 是放进原节点的那一份是第几个（没有就是 -1），spots 是新节点的位置。
const ROW_STEP = TITLE_ROOM + BOX_HEIGHT + 56;
export function placeResults(source: { id: string; position: { x: number; y: number }; width: number }, filled: boolean, results: number, others: { id: string; position: { x: number; y: number }; width: number }[], rowStep = ROW_STEP): { here: number; spots: { x: number; y: number }[] } {
  const spots: { x: number; y: number }[] = [];
  const taken = others.filter((node) => node.id !== source.id).map((node) => ({ ...node.position, width: node.width }));
  let y = source.position.y;
  for (let n = filled ? 0 : 1; n < results; n++) {
    do y += rowStep;
    while (taken.some((node) => Math.abs(node.y - y) < rowStep - 60 && node.x < source.position.x + source.width + 40 && node.x + node.width + 40 > source.position.x));
    spots.push({ x: source.position.x, y });
    taken.push({ x: source.position.x, y, width: source.width });
  }
  return { here: filled ? -1 : 0, spots };
}

// ---------- 复制、粘贴 ----------

interface Piece {
  id: string;
  type?: string;
  // 收在一叠里的节点是藏着的。
  hidden?: boolean;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}
interface Wire {
  id: string;
  source: string;
  target: string;
  data?: Record<string, unknown>;
}
export interface Clip {
  nodes: Piece[];
  edges: Wire[];
  upstream?: Wire[];
}

// 复制下来的是选中的节点，和两头都在其中的连线；连着外部上游输入的线记在 upstream 里（分支复制时可继承）。
export function clipOf(nodes: Piece[], edges: Wire[]): Clip {
  const ids = new Set(nodes.map((node) => node.id));
  // 历史版本是那个节点自己的，复制、粘贴、存成工作流都不带着走。
  const piece = ({ kept: _kept, ...rest }: Record<string, unknown>) => rest;
  return {
    nodes: nodes.map(({ id, type, position, data, hidden }) => ({ id, type, position: { ...position }, data: piece(stripNodeData(data) as Record<string, unknown>), ...(hidden ? { hidden } : {}) })),
    edges: edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)).map(({ id, source, target, data }) => ({ id, source, target, data })),
    upstream: edges.filter((edge) => !ids.has(edge.source) && ids.has(edge.target)).map(({ id, source, target, data }) => ({ id, source, target, data })),
  };
}

// 把复制下来的一份放回画布：节点和连线都换新 id，相互的位置不变。
// at 是这一份的左上角落在哪；没给就照原位置错开 by 这么多。
export function pasteClip(clip: Clip, place: { at?: { x: number; y: number }; by?: { x: number; y: number } }, newId: () => string): Clip {
  // 分组的框没有自己的位置，对齐左上角时不算它。
  const solid = clip.nodes.filter((node) => node.type !== 'group' && !node.hidden);
  const left = Math.min(...(solid.length ? solid : clip.nodes).map((node) => node.position.x));
  const top = Math.min(...(solid.length ? solid : clip.nodes).map((node) => node.position.y));
  const dx = place.at ? place.at.x - left : place.by?.x || 0;
  const dy = place.at ? place.at.y - top : place.by?.y || 0;
  const ids = new Map(clip.nodes.map((node) => [node.id, newId()]));
  return {
    // 分组里记的成员也换成新 id。
    nodes: clip.nodes.map((node) => ({ ...node, id: ids.get(node.id)!, position: { x: node.position.x + dx, y: node.position.y + dy }, data: { ...node.data, ...(Array.isArray(node.data.members) ? { members: (node.data.members as string[]).map((member) => ids.get(member)).filter(Boolean) } : {}) } })),
    edges: clip.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)).map((edge) => ({ ...edge, id: newId(), source: ids.get(edge.source)!, target: ids.get(edge.target)!, data: edge.data && { ...edge.data } })),
    upstream: (clip.upstream || []).filter((edge) => ids.has(edge.target)).map((edge) => ({ ...edge, id: newId(), source: edge.source, target: ids.get(edge.target)!, data: edge.data && { ...edge.data } })),
  };
}

// ---------- 节点对齐与等间距分布 ----------

export interface SizedNode {
  id: string;
  position: { x: number; y: number };
  width: number;
  height?: number;
}

export type AlignDirection = 'left' | 'center-h' | 'right' | 'top' | 'center-v' | 'bottom';

export function alignNodes<T extends SizedNode>(nodes: T[], type: AlignDirection): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  if (nodes.length < 2) {
    nodes.forEach((n) => result.set(n.id, { ...n.position }));
    return result;
  }
  const heightOf = (n: SizedNode) => n.height || (BOX_HEIGHT + TITLE_ROOM);
  if (type === 'left') {
    const minX = Math.min(...nodes.map((n) => n.position.x));
    nodes.forEach((n) => result.set(n.id, { x: minX, y: n.position.y }));
  } else if (type === 'right') {
    const maxRight = Math.max(...nodes.map((n) => n.position.x + n.width));
    nodes.forEach((n) => result.set(n.id, { x: maxRight - n.width, y: n.position.y }));
  } else if (type === 'center-h') {
    const minX = Math.min(...nodes.map((n) => n.position.x));
    const maxRight = Math.max(...nodes.map((n) => n.position.x + n.width));
    const midX = (minX + maxRight) / 2;
    nodes.forEach((n) => result.set(n.id, { x: Math.round(midX - n.width / 2), y: n.position.y }));
  } else if (type === 'top') {
    const minY = Math.min(...nodes.map((n) => n.position.y));
    nodes.forEach((n) => result.set(n.id, { x: n.position.x, y: minY }));
  } else if (type === 'bottom') {
    const maxBottom = Math.max(...nodes.map((n) => n.position.y + heightOf(n)));
    nodes.forEach((n) => result.set(n.id, { x: n.position.x, y: maxBottom - heightOf(n) }));
  } else if (type === 'center-v') {
    const minY = Math.min(...nodes.map((n) => n.position.y));
    const maxBottom = Math.max(...nodes.map((n) => n.position.y + heightOf(n)));
    const midY = (minY + maxBottom) / 2;
    nodes.forEach((n) => result.set(n.id, { x: n.position.x, y: Math.round(midY - heightOf(n) / 2) }));
  }
  return result;
}

export function distributeNodes<T extends SizedNode>(nodes: T[], axis: 'h' | 'v', defaultGap = 40): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  nodes.forEach((n) => result.set(n.id, { ...n.position }));
  if (nodes.length < 3) return result;

  const heightOf = (n: SizedNode) => n.height || (BOX_HEIGHT + TITLE_ROOM);
  if (axis === 'h') {
    const sorted = [...nodes].sort((a, b) => a.position.x - b.position.x);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const totalSpan = (last.position.x + last.width) - first.position.x;
    const totalWidths = sorted.reduce((sum, n) => sum + n.width, 0);
    const gap = Math.max(defaultGap, Math.round((totalSpan - totalWidths) / (sorted.length - 1)));
    let curX = first.position.x;
    for (const n of sorted) {
      result.set(n.id, { x: curX, y: n.position.y });
      curX += n.width + gap;
    }
  } else {
    const sorted = [...nodes].sort((a, b) => a.position.y - b.position.y);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const totalSpan = (last.position.y + heightOf(last)) - first.position.y;
    const totalHeights = sorted.reduce((sum, n) => sum + heightOf(n), 0);
    const gap = Math.max(defaultGap, Math.round((totalSpan - totalHeights) / (sorted.length - 1)));
    let curY = first.position.y;
    for (const n of sorted) {
      result.set(n.id, { x: n.position.x, y: curY });
      curY += heightOf(n) + gap;
    }
  }
  return result;
}
