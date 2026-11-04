// 全局状态、本地服务调用、轮询。
// 状态是一个普通对象，改完后用 emit() 说一声是哪一块变了；组件用 useStore() 订阅自己关心的那几块。

import { useSyncExternalStore } from 'react';
import type { VideoSpec } from '../../shared/models.ts';
import { flowModelId, flowUuidOf, isFlowModel } from '../../shared/autodl.ts';
import type { AppInfo, Character, CreateType, FlowSummary, HistoryItem, Kind, Skill, ViewId, Voice } from './types.ts';

export class ApiError extends Error {
  status: number;
  code: string;
  // 平台的原话（英文、带错误码）。message 是给人看的中文原因，detail 留给详情和排查。
  detail: string;
  constructor(status: number, code: string, message: string, detail = '') {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export async function api<T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const init: RequestInit & { headers: Record<string, string> } = { method, headers: { ...headers } };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError(0, 'network', '无法连接服务，请确认服务已启动。');
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应按空处理 */
  }
  // 登录过期了（或者在别处改了密码）：回到登录页。
  if (res.status === 401 && data?.error?.code === 'login_required' && state.app.user) location.reload();
  if (!res.ok) throw new ApiError(res.status, data?.error?.code || '', data?.error?.message || `请求失败（${res.status}）`, data?.error?.detail || '');
  return data;
}

export const KINDS: Record<Kind, { label: string; accept: string; max: number; maxBytes: number }> = {
  image: { label: '图片', accept: 'image/*', max: 9, maxBytes: 30 * 1024 * 1024 },
  video: { label: '视频', accept: 'video/*', max: 3, maxBytes: 50 * 1024 * 1024 },
  audio: { label: '音频', accept: 'audio/*', max: 3, maxBytes: 15 * 1024 * 1024 },
};

// 画布有自己的地址：#/canvas 是项目列表，#/canvas/<id> 是一张画布。刷新之后还在原来那张画布里，也可以在新标签页里打开。
export const canvasPath = (id = '') => `#/canvas${id ? `/${id}` : ''}`;
const hash = () => (typeof location === 'undefined' ? '' : location.hash);
export const canvasInPath = () => /^#\/canvas\/([\w-]+)$/.exec(hash())?.[1] || '';

export const state = {
  // 读到 Key 的状态之后才画创作页。
  booted: false,
  view: (hash().startsWith('#/canvas') ? 'canvas' : 'create') as ViewId,
  // 正在一张画布里：侧栏收起来，整个窗口都给画布。
  immersive: Boolean(canvasInPath()),
  // 创作页当前选的是哪种内容（视频、图片、语音、音效、配乐）。下面的「最近生成」跟着它走。
  createType: 'video' as CreateType,
  // 记录页的类型筛选。放在这里是因为创作页的「查看全部」要带着类型过去。
  recordsType: 'all' as CreateType | 'all',
  // 记录页看的是创作页生成的，还是画布里生成的。
  recordsSource: 'create' as 'create' | 'canvas',
  app: { hosted: false, user: null, hasKey: false, keyHint: '', keySource: '', baseUrl: '', minimax: { hasKey: false, keyHint: '', keySource: '', baseUrl: '' }, aihubmix: { hasKey: false, keyHint: '', keySource: '', baseUrl: '' }, aihubmixManage: { hasKey: false, keyHint: '', keySource: '', baseUrl: '' }, speech: { hasKey: false, keyHint: '', keySource: '', baseUrl: '' }, autodl: { hasKey: false, keyHint: '', keySource: '', baseUrl: '' }, runninghub: { hasKey: false }, billing: { hasKey: false, keyHint: '', keySource: '', baseUrl: '' } } as AppInfo,
  models: [] as string[],
  // 每个视频模型各自支持什么（分辨率、比例、时长、首尾帧），由本地服务随模型列表一起给。
  videoSpecs: {} as Record<string, VideoSpec>,
  modelsInfo: { source: 'default', error: '', note: '' },
  // 视频之外账号还能用什么。known 为 false 表示还没读到模型列表，这时不拦任何一种创作。
  // imageRatios 是每个图片模型收哪些画面比例，imageRefs 是最多收几张参考图，imageSizes 是能选的几档分辨率和默认的那一档，imageQualities 是分画质的模型能选的几档画质和默认的那一档。
  catalog: { known: false, image: [] as string[], imageRatios: {} as Record<string, string[]>, imageRefs: {} as Record<string, number>, imageSizes: {} as Record<string, { options: string[]; default: string }>, imageQualities: {} as Record<string, { options: string[]; default: string }>, polish: [] as string[], unavailable: [] as string[] },
  voices: null as Voice[] | null,
  history: [] as HistoryItem[],
  // AutoDL.art 的工作流目录（带起价和必填素材的种类）。loaded 表示已经从服务端读过一次。
  flows: { hasKey: false, total: 0, items: [] as FlowSummary[], loaded: false, error: '' },
  historyLoaded: false,
  // 角色和技能。null 是还没读过。
  characters: null as Character[] | null,
  skills: null as Skill[] | null,
  // 多人模式下自己剩多少积分，随生成记录一起读回来。本机模式是 null。
  credits: null as number | null,
  // 账户余额（元），查不到是 null。
  balance: null as number | null,
  // 另外两个账户的余额，没配就是 null。MiniMax 的是手动填的数减去之后估算的花费，amount 是填的那个数，unit 是它的单位（cny 是元，credits 是积分）；AiHubMix 的（美元）是用 Manage Key 查的，查不到时 remaining 是 null。
  minimaxBalance: null as { remaining: number; amount: number; at: number; unit: 'cny' | 'credits' } | null,
  aihubmixBalance: null as { remaining: number | null; error?: string } | null,
};

export type StoreEvent = 'boot' | 'view' | 'app' | 'models' | 'history' | 'createType' | 'recordsType' | 'recordsSource' | 'composer' | 'immersive' | 'characters' | 'skills' | 'balance' | 'flows' | 'prefs';

const listeners: Partial<Record<StoreEvent, Set<() => void>>> = {};
const versions: Partial<Record<StoreEvent, number>> = {};

export function on(event: StoreEvent, fn: () => void) {
  (listeners[event] ||= new Set()).add(fn);
  return () => {
    listeners[event]?.delete(fn);
  };
}

export function emit(event: StoreEvent) {
  versions[event] = (versions[event] || 0) + 1;
  listeners[event]?.forEach((fn) => fn());
}

// 订阅状态里的几块；其中任何一块 emit 了，组件就重画。返回值每次变化都不同，可以拿来当 effect 的依赖。
export function useStore(...events: StoreEvent[]) {
  return useSyncExternalStore(
    (notify) => {
      const offs = events.map((event) => on(event, notify));
      return () => offs.forEach((off) => off());
    },
    () => events.map((event) => versions[event] || 0).join(','),
  );
}

// 切换页面。重复去同一页也算一次：点「创作」要回到顶部并把光标放回输入框。
export function goTo(view: ViewId) {
  // 去别的页面时把地址里的画布去掉，不然刷新会回到画布页。
  if (view !== 'canvas' && hash()) history.replaceState(null, '', location.pathname + location.search);
  else if (view === 'canvas' && !hash().startsWith('#/canvas')) history.replaceState(null, '', canvasPath());
  state.view = view;
  emit('view');
}

export function setImmersive(on: boolean) {
  if (state.immersive === on) return;
  state.immersive = on;
  emit('immersive');
}

// 地址自己变了（粘贴了画布链接、浏览器的后退和前进）：页面跟着走。goTo 用 replaceState 改地址，不会走到这里。
// 画布里面换哪一张由画布列表自己听；这里只管进出画布页。
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    const onCanvas = hash().startsWith('#/canvas');
    if (onCanvas === (state.view === 'canvas')) return;
    state.view = onCanvas ? 'canvas' : 'create';
    setImmersive(Boolean(canvasInPath()));
    emit('view');
  });
}

// 多人模式下还没登录：这时只显示登录页。
export const needsLogin = () => state.app.hosted && !state.app.user;
export const isAdmin = () => state.app.user?.role === 'admin';
// 能不能管 Key：本机模式谁都能，多人模式只有管理员能。
export const canManage = () => !state.app.hosted || isAdmin();

// 模型菜单里的一项：所在平台没配 Key 的型号标出来、不能选。附注说成员能懂的话：管理员去「管理」里配，成员只知道还没开通。
export function modelOption(id: string, label: string, note?: string | null) {
  if (!state.catalog.unavailable.includes(id)) return { value: id, label, note: note || undefined };
  return { value: id, label, note: canManage() ? '未配置 Key' : '暂未开通', disabled: true };
}
// 多人模式下的成员：看到的是积分，看不到元和各平台的余额。
export const usesCredits = () => state.app.hosted && !isAdmin();

// ---------- 工作流：当成一种模型 ----------
// 两个来源编译成同一种形状，和型号并列出现在模型菜单里，id 是 flow:<uuid>：
// - AutoDL.art：平台上全部的工作流，uuid 是平台给的；
// - RunningHub：我们在 shared/runninghub.ts 里登记过的那几个，uuid 是 rh:<key>。
// 目录里都带着规则和计费，不用再取一次。提交时按 provider 分到各自的接口。
export const flowSummary = (model?: string | null) => (isFlowModel(model) ? state.flows.items.find((item) => item.uuid === flowUuidOf(String(model))) || null : null);
export const flowModelLabel = (model: string) => flowSummary(model)?.name || flowUuidOf(model);
// 这个类型的节点能用哪些工作流：看出什么文件（video、audio、image）和有没有拿到规则。
export const flowModelsOf = (kind: Kind) => state.flows.items.filter((item) => item.output === kind && item.rules && Object.keys(item.rules).length).map((item) => flowModelId(item.uuid));
// 页面上写「来自 RunningHub / AutoDL」：平台的价格是它自己的单位（RH 币、元），不换算成积分，所以只说来源。
export const flowSource = (provider?: string) => (provider === 'runninghub' ? 'RunningHub' : 'AutoDL');
// 模型菜单里那行小字：这个工作流是哪一家的。
export const flowHint = (model: string) => {
  const flow = flowSummary(model);
  return flow?.provider === 'runninghub' ? (flow.endpoint === 'ai-app' ? 'RunningHub AI 应用' : 'RunningHub 工作流') : 'AutoDL 工作流';
};
// 工作流平台配好了（AutoDL.art 的令牌、或者 RunningHub 的一组 Key 里有能用的）。
// 管理员直接看 state，成员只能看目录接口给的 hasKey。
export const flowReady = () => Boolean(state.app.autodl?.hasKey || state.app.runninghub?.hasKey || state.flows.hasKey);
// 至少有一个平台能用（火山方舟或任一家工作流平台）：侧栏的提示和快捷键看这个。
export const hasAnyKey = () => Boolean(state.app.hasKey || flowReady());

export async function loadApp() {
  state.app = { ...state.app, ...(await api('GET', '/api/state')) };
  emit('app');
}

// 三个账户的余额。火山的（元）配了 Access Key 才查得到，查不到是 null；MiniMax、AiHubMix 的见上面 state 里的说明。每生成完一条就该再查一次。
export async function loadBalance() {
  if (!canManage()) return;
  let balance = state.balance;
  let minimax = state.minimaxBalance;
  let aihubmix = state.aihubmixBalance;
  try {
    const data = await api('GET', '/api/credits');
    balance = data.unavailable ? null : data.remaining;
    minimax = data.minimax || null;
    aihubmix = data.aihubmix ? { remaining: data.aihubmix.error ? null : data.aihubmix.remaining, error: data.aihubmix.error } : null;
  } catch {
    // 火山的没查到：保留上次的数，另外两个也不动。
  }
  if (balance === state.balance && JSON.stringify([minimax, aihubmix]) === JSON.stringify([state.minimaxBalance, state.aihubmixBalance])) return;
  state.balance = balance;
  state.minimaxBalance = minimax;
  state.aihubmixBalance = aihubmix;
  emit('balance');
}

export async function loadModels() {
  const data = await api('GET', '/api/models');
  state.models = data.models;
  state.videoSpecs = data.videoSpecs || {};
  state.modelsInfo = { source: data.source, error: data.error || '', note: data.note || '' };
  state.catalog = { known: !data.error, image: data.imageModels || [], imageRatios: data.imageRatios || {}, imageRefs: data.imageRefs || {}, imageSizes: data.imageSizes || {}, imageQualities: data.imageQualities || {}, polish: data.polishModels || [], unavailable: data.unavailable || [] };
  emit('models');
}

export async function loadVoices() {
  if (!state.voices) state.voices = (await api('GET', '/api/voices')).items;
  return state.voices;
}

// 工作流目录。两份一起读：RunningHub 是我们登记过的那几个（排在前面），AutoDL.art 是平台上的全部。
// 哪一份读不到都不影响另一份——只配了一家的账号照样能用。服务端对 AutoDL 的目录缓存一分钟。
export async function loadFlows(force = false) {
  if (state.flows.loaded && !force) return state.flows.items;
  type Catalog = { hasKey: boolean; total: number; items: FlowSummary[] };
  const failed: string[] = [];
  const read = async (url: string): Promise<Catalog> => {
    try {
      return await api<Catalog>('GET', url);
    } catch (err) {
      failed.push((err as Error).message);
      return { hasKey: false, total: 0, items: [] };
    }
  };
  const [runninghub, autodl] = await Promise.all([read('/api/runninghub/workflows'), read('/api/autodl/workflows')]);
  const items = [...runninghub.items, ...autodl.items];
  state.flows = { hasKey: Boolean(runninghub.hasKey || autodl.hasKey), total: items.length, items, loaded: true, error: items.length ? '' : failed[0] || '' };
  emit('flows');
  return state.flows.items;
}

// 润色提示词用哪个文本模型。选择存在浏览器里；没选过或选的已经不可用，就用列表里的第一个。
const POLISH_KEY = 'innate-studio.polish-model';

export function polishModel() {
  let saved = '';
  try {
    saved = localStorage.getItem(POLISH_KEY) || '';
  } catch {
    /* 读不到就用默认的 */
  }
  return state.catalog.polish.includes(saved) ? saved : state.catalog.polish[0] || '';
}

export function setPolishModel(model: string) {
  try {
    localStorage.setItem(POLISH_KEY, model);
  } catch {
    /* 存不了就只在本次打开期间生效 */
  }
}

// 画布上再次生成时，结果放在哪：'new' 另开一个新节点（默认），'here' 就地替换这个节点里的内容。
// 节点上单独选过的按节点，没选过的跟随这里。
const PLACE_KEY = 'innate-studio.canvas-place';

export function canvasPlace(): 'new' | 'here' {
  try {
    return localStorage.getItem(PLACE_KEY) === 'here' ? 'here' : 'new';
  } catch {
    return 'new';
  }
}

export function setCanvasPlace(place: 'new' | 'here') {
  try {
    localStorage.setItem(PLACE_KEY, place);
  } catch {
    /* 存不了就只在本次打开期间生效 */
  }
  emit('prefs');
}

let historySignature = '';

export async function loadHistory() {
  const data = await api<{ items: HistoryItem[]; credits?: number }>('GET', '/api/history');
  const signature = JSON.stringify(data.items.map((i) => [i.id, i.status, i.progress, i.mediaUrl, i.thumbUrl, i.pollError, i.downloadError, i.error?.message, i.credits?.charged]));
  state.history = data.items;
  if (data.credits !== undefined && data.credits !== state.credits) {
    state.credits = data.credits;
    emit('balance');
  }
  if (signature !== historySignature || !state.historyLoaded) {
    historySignature = signature;
    state.historyLoaded = true;
    emit('history');
  }
}

export const isPendingTask = (item: HistoryItem) => item.status === 'queued' || item.status === 'in_progress';
// 等太久、本地服务已停止自动查询的任务。它在平台那边不一定失败了，可以手动再查一次。
export const isTimedOutTask = (item: HistoryItem) => item.status === 'failed' && item.error?.code === 'poll_timeout';

let historyTimer: ReturnType<typeof setTimeout> | undefined;

export function startHistoryLoop() {
  clearTimeout(historyTimer);
  const run = async () => {
    try {
      await loadHistory();
    } catch {
      /* 下一轮再试 */
    }
    const busy = state.history.some((i) => isPendingTask(i) || (i.status === 'completed' && !i.savedLocally && !i.downloadError));
    historyTimer = setTimeout(run, busy ? 2500 : 15000);
  };
  run();
}

export async function loadCharacters() {
  state.characters = (await api<{ items: Character[] }>('GET', '/api/characters')).items;
  emit('characters');
  return state.characters;
}

export async function loadSkills() {
  state.skills = (await api<{ items: Skill[] }>('GET', '/api/skills')).items;
  emit('skills');
  return state.skills;
}
