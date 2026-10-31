// 创作输入框的状态和动作：正在编辑的表单、润色、音色试听、提交。界面在 Composer.tsx，把表单拼成请求的逻辑在 request.ts。
// 这里改完状态都要调 changed()，输入框才会重画。

import { api, state, on, emit, KINDS, startHistoryLoop, loadVoices, loadFlows, polishModel, goTo, usesCredits, type ApiError } from '../store.ts';
import { fmtCredits } from '../format.ts';
import { exclusive } from '../playback.ts';
import { refFromRecord, kindOfFile, uploadLocalFile } from '../media.ts';
import { toast } from '../ui/layers.tsx';
import { buildVideoRequest, buildImageRequest, buildSpeechRequest, buildSfxRequest, buildMusicRequest, refsInUse, carryRefs } from '../request.ts';
import { quoteCost, toCredits, type VideoSpec } from '../../../shared/models.ts';
import { workflowCost, cleanInputs, formValues, ruleKind, ruleLabel, type InputRule, type WorkflowSummary } from '../../../shared/autodl.ts';
import type { BuiltRequest, Character, CreateType, FlowSummary, HistoryItem, Kind, Ref, SkillRef, Studio, VideoForm, Voice } from '../types.ts';

// 视频的表单单独存一份（生成记录里存的也是它）；当前选的类型和其余几种的表单存在另一份里。
const FORM_KEY = 'innate-studio.form.v1';
const STUDIO_KEY = 'innate-studio.studio.v1';

// 能生成的六种内容。polish 表示这种内容的文字可以让模型帮忙润色：提示词是补得更具体，要朗读的文稿是改得更适合朗读。
// 工作流没有固定的提示词框：参数是按平台给出的规则画的，所以不写 placeholder、不润色。
export const TYPES: { value: CreateType; label: string; title: string; action: string; polish?: boolean; placeholder?: string }[] = [
  { value: 'video', label: '视频', title: '想生成什么视频？', action: '生成视频', polish: true, placeholder: '描述主体、动作、场景、运镜、光线与风格' },
  { value: 'image', label: '图片', title: '想生成什么图片？', action: '生成图片', polish: true, placeholder: '描述主体、环境、构图、光线与风格' },
  { value: 'speech', label: '语音', title: '想让它读什么？', action: '生成语音', polish: true, placeholder: '输入朗读文本' },
  { value: 'sfx', label: '音效', title: '想要什么声音？', action: '生成音效', polish: true, placeholder: '描述声音的来源、材质与动作' },
  { value: 'music', label: '配乐', title: '想要什么配乐？', action: '生成配乐', polish: true, placeholder: '描述风格、情绪、节奏与乐器' },
  { value: 'flow', label: '工作流', title: '想用哪个工作流？', action: '运行工作流' },
];

export const RATIOS = [
  { value: '16:9', label: '16:9' },
  { value: '4:3', label: '4:3' },
  { value: '1:1', label: '1:1' },
  { value: '3:4', label: '3:4' },
  { value: '9:16', label: '9:16' },
  { value: '21:9', label: '21:9' },
];

export const defaults = (): VideoForm => ({
  mode: 'reference',
  prompt: '',
  model: 'doubao-seedance-2-0-260128',
  resolution: '720p',
  ratio: '16:9',
  duration: 5,
  durationAuto: false,
  generateAudio: true,
  seed: '',
  frames: { first: null, last: null },
  refs: { image: [], video: [], audio: [] },
  skill: null,
});

const studioDefaults = (): Studio => ({
  type: 'video',
  image: { prompt: '', model: 'doubao-seedream-5-0-pro-260628', ratio: '16:9', count: 1, refs: [], skill: null },
  speech: { prompt: '', voiceId: '', voiceName: '' },
  sfx: { prompt: '', duration: 'auto' },
  music: { prompt: '', video: null, duration: 30 },
  flow: { workflow: null, values: {}, refs: {} },
});

// 以前存下的表单、别的平台留下的记录里，可能带着现在用不了的素材。只留本机的文件和公网链接。
const usable = (ref: Ref | null | undefined): ref is Ref => Boolean(ref) && (ref!.source === 'local' || ref!.source === 'url');

function mergeForm(saved: Partial<VideoForm> | null): VideoForm {
  const base = defaults();
  if (!saved || typeof saved !== 'object') return base;
  const frames = { ...base.frames, ...(saved.frames || {}) };
  const refs = { ...base.refs, ...(saved.refs || {}) };
  // 只取现在还有的那几项设置，以前的版本多存的不带进来。
  const fields = Object.fromEntries(Object.keys(base).filter((key) => key in saved).map((key) => [key, saved[key as keyof VideoForm]]));
  return {
    ...base,
    ...fields,
    frames: { first: usable(frames.first) ? frames.first : null, last: usable(frames.last) ? frames.last : null },
    refs: { image: (refs.image || []).filter(usable), video: (refs.video || []).filter(usable), audio: (refs.audio || []).filter(usable) },
  };
}

function mergeStudio(saved: Partial<Studio> | null): Studio {
  const base = studioDefaults();
  if (!saved || typeof saved !== 'object') return base;
  const flow = (saved.flow || {}) as Partial<Studio['flow']>;
  const refs = (flow.refs || {}) as Record<string, Ref | null>;
  return {
    type: TYPES.some((t) => t.value === saved.type) ? saved.type! : base.type,
    image: { ...base.image, ...(saved.image || {}), refs: (saved.image?.refs || []).filter(usable) },
    speech: { ...base.speech, ...(saved.speech || {}) },
    sfx: { ...base.sfx, ...(saved.sfx || {}) },
    music: { ...base.music, ...(saved.music || {}) },
    // 工作流只记选的是哪一个和已经填的值；规则在选中时重新取，上次没填完的参数按规则筛一遍。
    flow: {
      workflow: flow.workflow?.uuid ? { uuid: String(flow.workflow.uuid), name: String(flow.workflow.name || '') } : null,
      values: flow.values && typeof flow.values === 'object' ? { ...flow.values } : {},
      refs: Object.fromEntries(Object.entries(refs).filter(([, ref]) => usable(ref))) as Record<string, Ref | null>,
    },
  };
}

// 输入框的内容存在浏览器里。多人模式下按账号分开存（键名后面接账号 id）：同一台电脑换个人登录，看不到上一个人写到一半的东西。
// 读到账号之前（initComposer 之前）先按本机模式的键读，登录、退出都会整页重新加载，所以不会写错地方。
let owner = '';
const keyOf = (key: string) => (owner ? `${key}:${owner}` : key);

function load<T>(key: string, merge: (saved: any) => T): T {
  try {
    return merge(JSON.parse(localStorage.getItem(keyOf(key))!));
  } catch {
    return merge(null);
  }
}

// 输入框当前的全部状态。form 是视频的表单，studio 是当前类型和其余几种的表单。
export const composer = {
  form: load(FORM_KEY, mergeForm),
  studio: load(STUDIO_KEY, mergeStudio),
  submitting: false,
  // 提交时就被拒绝的原因（没开通模型、参数不对）。这时没有生成记录，所以写在输入框下面，改了输入或关掉才消失。
  submitError: '',
  submitDetail: '',
  // 润色之前的原文。留着它，「润色」就变成「撤销润色」；用户再动一下文字就丢掉。
  beforePolish: null as string | null,
  polishing: false,
  voicesError: '',
  // 工作流的定义没取到时（令牌失效、平台不通）写在这里，输入框里显示出来。
  flowsError: '',
  voiceFilter: 'all' as 'all' | 'zh' | 'en' | 'other',
  // 正在试听的音色。
  previewing: '',
};
state.createType = composer.studio.type;

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export const typeOf = (value: CreateType = composer.studio.type) => TYPES.find((t) => t.value === value) || TYPES[0];
// 当前类型正在编辑的那份表单里的文字。工作流的主文本是规则里第一段文字（prompt、prompt_text）。
export const draftPrompt = () => {
  const { type } = composer.studio;
  if (type === 'video') return composer.form.prompt;
  if (type === 'flow') {
    const key = flowPrimaryKey();
    const value = key ? composer.studio.flow.values[key] : '';
    return typeof value === 'string' ? value : '';
  }
  return composer.studio[type].prompt || '';
};
function writePrompt(text: string) {
  const { type } = composer.studio;
  if (type === 'video') composer.form.prompt = text;
  else if (type === 'flow') {
    const key = flowPrimaryKey();
    if (key) composer.studio.flow.values = { ...composer.studio.flow.values, [key]: text };
  } else composer.studio[type].prompt = text;
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(keyOf(FORM_KEY), JSON.stringify(composer.form));
      localStorage.setItem(keyOf(STUDIO_KEY), JSON.stringify(composer.studio));
    } catch {
      /* 存不下就不存，不影响使用 */
    }
  }, 300);
}

// 每个视频模型支持什么，由本地服务随模型列表一起给。列表还没读到时先按这一份保守的来。
const FALLBACK_SPEC: VideoSpec = { resolutions: ['480p', '720p'], ratios: ['16:9', '4:3', '1:1', '3:4', '9:16'], durations: [4, 5, 6, 7, 8], autoDuration: false, frames: ['first_frame'], audio: false, seed: false };
export const specOf = (model = composer.form.model) => state.videoSpecs[model] || FALLBACK_SPEC;

const allRefs = () => refsInUse(composer.form);

// ---------- AutoDL.art 的工作流 ----------
// 选中的工作流是哪一种、参数规则是什么。规则在选中时从详情接口取一份放在内存里（目录接口不带规则）；
// 复用记录时用记录里存的那一份，平台之后改了规则也还原得回去。
type Flow = Pick<WorkflowSummary, 'uuid' | 'name' | 'description' | 'price' | 'price_type' | 'billing_config' | 'input_rules'>;
const MAX_FLOWS = 8;
const flowCache = new Map<string, Flow>();
const patch = (prev: Record<string, unknown>, next: Record<string, unknown>) => ({ ...prev, ...next });

export const flowForm = () => composer.studio.flow;
// 选中的工作流的完整定义；还没取到时是 null。
export const flowDefinition = (): Flow | null => {
  const { workflow } = composer.studio.flow;
  return workflow ? flowCache.get(workflow.uuid) || null : null;
};
// 选中的工作流放在内存里的定义（测试和演示会直接塞一份）。
export function rememberFlow(flow: Flow) {
  flowCache.delete(flow.uuid);
  flowCache.set(flow.uuid, flow);
  while (flowCache.size > MAX_FLOWS) flowCache.delete(flowCache.keys().next().value!);
  emit('composer');
}
async function fetchFlow(uuid: string, force = false): Promise<Flow | null> {
  if (!force && flowCache.has(uuid)) return flowCache.get(uuid)!;
  try {
    const { workflow } = await api<{ workflow: WorkflowSummary }>('GET', `/api/autodl/workflows/${encodeURIComponent(uuid)}`);
    rememberFlow(workflow);
    return workflow;
  } catch (err) {
    // 目录里带出来的规则也够画表单了：拿它当一份定义，详情只是补充说明和计费快照。
    const summary = state.flows.items.find((item) => item.uuid === uuid);
    if (summary?.rules && Object.keys(summary.rules).length) return { uuid, name: summary.name, description: summary.description, input_rules: summary.rules } as Flow;
    composer.flowsError = (err as Error).message;
    emit('composer');
    return null;
  }
}
// 工作流记在记录上的名字。目录还没读到、记录里也没存名字时用 uuid。
export const flowName = () => composer.studio.flow.workflow?.name || '工作流';
// 工作流是干什么的：平台上给的说明。
export const flowAbout = () => flowDefinition()?.description || '';

// 工作流里要填的文字字段（string / prompt）。输入框里的主文本用第一段：优先 prompt、prompt_text。
export function flowTextRules(): [string, InputRule][] {
  return Object.entries(flowDefinition()?.input_rules || {}).filter(([, rule]) => rule.type === 'string' || rule.type === 'prompt');
}
export function flowPrimaryKey(): string | null {
  const entries = flowTextRules();
  return (entries.find(([key]) => key === 'prompt') || entries.find(([key]) => key === 'prompt_text') || entries[0])?.[0] || null;
}

// 记录上的提示词：规则里第一段填了的文字（服务端建记录时也是这么取）。
export function flowPrompt(flow: { input_rules?: Record<string, InputRule> } | null): string {
  const { values } = composer.studio.flow;
  for (const [key, rule] of Object.entries(flow?.input_rules || {})) {
    if (rule.type !== 'string' && rule.type !== 'prompt') continue;
    const text = typeof values[key] === 'string' ? String(values[key]).trim() : '';
    if (text) return text;
  }
  return '';
}

// 换了工作流：从目录里找到它，取一份完整定义，按规则给表单铺初始值。上次填的值里规则还在的留着，规则已经变了的丢掉。
// 同一条工作流重新选一次是把表单恢复成默认值。
export async function selectFlow(uuid: string, options: { restore?: Record<string, unknown>; rules?: Record<string, InputRule>; restoreRefs?: Record<string, Ref | null> } = {}) {
  const summary = state.flows.items.find((item) => item.uuid === uuid);
  const same = composer.studio.flow.workflow?.uuid === uuid;
  composer.studio.flow.workflow = { uuid, name: summary?.name || composer.studio.flow.workflow?.name || uuid };
  composer.studio.flow.values = {};
  composer.studio.flow.refs = {};
  composer.flowsError = '';
  persist();
  changed();
  const workflow = await fetchFlow(uuid, !same || Boolean(options.restore));
  if (!workflow || composer.studio.flow.workflow?.uuid !== uuid) return;
  const definition = options.rules ? { ...workflow, input_rules: options.rules } : workflow;
  const defaults = formValues(definition);
  const wanted = options.restore || {};
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defaults)) {
    const rule = definition.input_rules?.[key];
    if (!rule) continue;
    const given = wanted[key];
    // 只有形状对得上的才恢复：文字给文字，数字给数字，开关给开关，枚举必须在选项里。
    const fits =
      given !== undefined &&
      given !== null &&
      (rule.type === 'string' || rule.type === 'prompt' ? typeof given === 'string' : rule.type === 'integer' || rule.type === 'number' ? Number.isFinite(Number(given)) : rule.type === 'boolean' ? typeof given === 'boolean' : rule.type === 'enum' ? (rule.options || []).some((option) => option.label === given) : false);
    values[key] = fits ? given : value;
  }
  // 素材也带过去，但只放在类型对得上的位置（换到要参考音频的工作流，原来的图片不硬塞进去）。
  const refs: Record<string, Ref | null> = {};
  for (const [key, ref] of Object.entries(options.restoreRefs || {})) {
    const rule = definition.input_rules?.[key];
    if (rule && (rule.type === 'image' || rule.type === 'video' || rule.type === 'audio') && rule.type === ref?.kind && usable(ref)) refs[key] = ref;
  }
  composer.studio.flow.values = values;
  composer.studio.flow.refs = refs;
  persist();
  changed();
}

// 换了工作流（刷新目录后选中一个）：主文本（提示词、朗读文本）和素材留着，规律一样的参数也留着——
// 平台上那二十几个 H3 工作流大多是同一组参数，换个工作流不用重填。新工作流多出来的字段按默认值，没有的字段丢掉。
export async function pickFlow(uuid: string) {
  if (composer.studio.flow.workflow?.uuid === uuid) return;
  const { values, refs } = composer.studio.flow;
  const restore: Record<string, unknown> = {};
  for (const [key, rule] of flowTextRules()) if (typeof values[key] === 'string' && values[key]) restore[key] = values[key];
  await selectFlow(uuid, { restore, restoreRefs: refs });
}

// 填规则里的一个值。
export function setFlowValue(key: string, value: unknown) {
  composer.studio.flow.values = patch(composer.studio.flow.values, { [key]: value });
  composer.submitError = '';
  persist();
  changed();
}
// 给媒体规则放一份素材（null 是拿掉）。
export function setFlowRef(key: string, ref: Ref | null) {
  composer.studio.flow.refs = { ...composer.studio.flow.refs, [key]: ref };
  composer.submitError = '';
  persist();
  changed();
}

// 工作流里某一类素材的空槽：字段名。拖进来的文件按顺序放进第一个空的。没有空槽时是 null。
export function firstEmptySlot(kind: Kind): string | null {
  const flow = flowDefinition();
  const refs = composer.studio.flow.refs;
  for (const [key, rule] of Object.entries(flow?.input_rules || {})) {
    if (rule.type === kind && !refs[key]) return key;
  }
  return null;
}
// 工作流总共要几份这种素材：给按规则画出来的媒体格子和拖入时的提示用。
export function flowSlots(kind: Kind): { key: string; rule: InputRule }[] {
  const flow = flowDefinition();
  return Object.entries(flow?.input_rules || {})
    .filter(([, rule]) => rule.type === kind)
    .map(([key, rule]) => ({ key, rule }));
}

// 按规则检查现在填的参数：补默认值、删空项、查长度和范围。返回要提交的 inputs 和问题。
let lastFlowInputs: Record<string, unknown> = {};
export function flowInputs(): { inputs: Record<string, unknown>; problems: string[] } {
  const flow = flowDefinition();
  if (!flow) return { inputs: {}, problems: [composer.flowsError ? `工作流加载失败：${composer.flowsError}` : '请先选择工作流'] };
  const { values, refs } = composer.studio.flow;
  const raw: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(flow.input_rules || {})) {
    const kind = ruleKind(rule);
    if (kind === 'media') {
      const ref = refs[key];
      if (ref) raw[key] = ref.url;
    } else if (kind === 'number') {
      const text = values[key];
      if (text !== '' && text != null) raw[key] = Number(text);
    } else if (kind === 'toggle') {
      if (values[key] !== undefined) raw[key] = values[key];
    } else if (kind === 'select') {
      if (values[key]) raw[key] = values[key];
    } else if (values[key] !== '' && values[key] != null) {
      raw[key] = values[key];
    }
  }
  const result = cleanInputs(flow.input_rules || {}, raw);
  lastFlowInputs = result.inputs;
  return result;
}
// 按秒计费的工作流要知道要生成多长：duration、audio_duration 这类数字参数，或者参考素材自己的时长。
export function flowSeconds(): number {
  const flow = flowDefinition();
  for (const [key, rule] of Object.entries(flow?.input_rules || {})) {
    if (rule.type !== 'integer' && rule.type !== 'number') continue;
    if (!/duration|seconds/i.test(key)) continue;
    const value = Number(composer.studio.flow.values[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}
// 这次大约多少积分。和目录里的起价、服务端预扣用的是同一个算法（shared/autodl.ts 的 workflowCost）。
export function flowCredits(): number | null {
  const flow = flowDefinition();
  if (!flow) return null;
  const yuan = workflowCost(flow, lastFlowInputs, flowSeconds());
  return yuan == null ? null : toCredits(yuan);
}

// 把一条工作流记录的参数填回输入框：工作流、规则、填的值、用的素材。记录里存了当时的那份规则就用它。
export async function setFlow(item: HistoryItem) {
  const snapshot = item.workflow || null;
  const uuid = snapshot?.uuid || (item.form?.workflow as { uuid?: string } | undefined)?.uuid;
  if (!uuid) return;
  const restore: Record<string, unknown> = { ...(snapshot?.inputs || {}) };
  // 数字规则存的是数、输入框里是字：按记录里的输入框形状还原。
  if (item.form?.values && typeof item.form.values === 'object') Object.assign(restore, item.form.values);
  await selectFlow(String(uuid), { restore, ...(snapshot?.rules ? { rules: snapshot.rules } : {}), ...(item.form?.refs ? { restoreRefs: item.form.refs as Record<string, Ref | null> } : {}) });
  setType('flow');
}

// ---------- 提交 ----------

// 当前类型的请求和不能提交的原因。prompt 是技能扩写出来的提示词：给了就用它代替输入框里的那句话。
export function currentRequest(prompt?: string): BuiltRequest {
  const { studio } = composer;
  if (studio.type === 'flow') {
    const { inputs, problems } = flowInputs();
    return { payload: inputs, problems };
  }
  if (studio.type === 'image') return buildImageRequest(prompt === undefined ? studio.image : { ...studio.image, prompt }, imageRefLimit());
  if (studio.type === 'speech') return buildSpeechRequest(studio.speech);
  if (studio.type === 'sfx') return buildSfxRequest(studio.sfx);
  if (studio.type === 'music') return buildMusicRequest(studio.music);
  const form = prompt === undefined ? composer.form : { ...composer.form, prompt };
  return buildVideoRequest(form, specOf(form.model));
}

// 现在为什么不能提交：表单本身的问题在前；多人模式下估出来的积分比剩下的多，也不能提交（服务端预扣时同样会拦）。
// 没有问题是空字符串。发送键变淡、悬停说明原因，和表单的问题一个样子。
export function submitProblem(): string {
  const problem = currentRequest().problems[0];
  if (problem) return problem;
  if (usesCredits() && state.credits != null) {
    const need = currentCredits();
    if (need != null && need > state.credits) return `积分不足：本次约需 ${fmtCredits(need)}，剩余 ${fmtCredits(state.credits)}`;
  }
  return '';
}

// 这次生成大约要多少积分，写在发送键旁边。和服务端预扣用的是同一个算法（shared/models.ts 的 quoteCost）。估不出来是 null。
export function currentCredits(): number | null {
  const { type } = composer.studio;
  const { payload, body } = currentRequest();
  if (type === 'flow') return flowCredits();
  if (type === 'video' || type === 'image') {
    const yuan = quoteCost({ kind: type, model: String(payload?.model || ''), payload });
    return yuan == null ? null : toCredits(yuan) * (type === 'image' ? Number(payload?.n) || 1 : 1);
  }
  const yuan = quoteCost({ tool: type, prompt: String(body?.text || ''), payload: { duration_seconds: body?.duration } });
  return yuan == null ? null : toCredits(yuan);
}

// ---------- 技能 ----------
// 技能只用在视频和图片上，两种各记各的。选了技能，输入框里写的就是一句简单的话，发送前按技能的规则扩写成提示词。

export function activeSkill(): SkillRef | null {
  const { type } = composer.studio;
  return (type === 'video' ? composer.form.skill : type === 'image' ? composer.studio.image.skill : null) || null;
}

export function setSkill(skill: SkillRef | null) {
  if (composer.studio.type === 'video') update({ skill });
  else if (composer.studio.type === 'image') updateStudio('image', { skill });
}

// 这次生成的设置，扩写时放在用户那句话前面：规则里有些写法要看它们（时长、要不要写声音、有没有参考图）。
function skillContext() {
  const { form, studio } = composer;
  if (studio.type === 'image') return `参考图：${studio.image.refs?.length || 0} 张\n画面比例：${studio.image.ratio}`;
  const images = refsInUse(form).filter((ref) => ref.kind === 'image').length;
  return [`时长：${form.durationAuto ? '由模型决定' : `${form.duration} 秒`}`, `生成声音：${specOf().audio && form.generateAudio ? '是' : '否'}`, `参考图：${images} 张`].join('\n');
}

// 换模型后，把当前模型不支持的取值换成它支持的，免得带着一个提交不了的设置。
function fitModel() {
  const { form } = composer;
  const able = specOf();
  // 常用的那一档这个模型有就用它，没有就用它支持的第一档。
  const pick = <T,>(list: T[], usual: T) => (list.includes(usual) ? usual : (list[0] ?? usual));
  if (!able.resolutions.includes(form.resolution)) form.resolution = pick(able.resolutions, '720p');
  if (!able.ratios.includes(form.ratio)) form.ratio = pick(able.ratios, '16:9');
  if (!able.autoDuration) form.durationAuto = false;
  if (!able.durations.includes(Number(form.duration))) form.duration = pick(able.durations, 5);
  if (form.mode === 'frames' && !able.frames.includes('first_frame')) form.mode = 'reference';
  // 没有单独的「文生视频」：不加素材的全能参考就是它。
  if (form.mode === 'text') form.mode = 'reference';
}

// 状态改完了：让输入框重画。
const changed = () => emit('composer');

export function update(patch: Partial<VideoForm>) {
  Object.assign(composer.form, patch);
  fitModel();
  composer.submitError = '';
  persist();
  changed();
}

// 换生成方式。
export function setMode(mode: VideoForm['mode']) {
  update({ mode, ...carryRefs(composer.form, mode, KINDS.image.max) });
}

// ---------- 添加素材 ----------
// 选素材的弹窗、拖进输入框、粘贴，三条路加进来的素材都走这里，规则只有一份。

const sameMedia = (a: Ref, b: Ref) => a.url === b.url;
// 视频的参考素材里，现在能加的是哪几类。没有视频：参考视频只收公网链接，本机的文件发不过去；图片和音频可以内嵌进请求。
export const addableKinds = (): Kind[] => ['image', 'audio'];
// 首尾帧里能不能给尾帧。
export const hasLastFrame = (model = composer.form.model) => specOf(model).frames.includes('last_frame');

// 当前类型和生成方式下，每种素材还能加几份。一种都不能加时是空的。
export function mediaRoom(): Partial<Record<Kind, number>> {
  const { form, studio } = composer;
  if (studio.type === 'flow') {
    const used = studio.flow.refs;
    return Object.fromEntries((['image', 'video', 'audio'] as Kind[]).map((kind) => [kind, flowSlots(kind).filter(({ key }) => !used[key]).length]).filter(([, left]) => (left as number) > 0));
  }
  if (studio.type === 'image') return imageRefLimit() ? { image: imageRefLimit() - (studio.image.refs?.length || 0) } : {};
  if (studio.type === 'music') return { video: 1 };
  if (studio.type !== 'video' || form.mode === 'text') return {};
  if (form.mode === 'frames') return { image: [form.frames.first, hasLastFrame() ? form.frames.last : true].filter((slot) => !slot).length };
  return Object.fromEntries(addableKinds().map((kind) => [kind, KINDS[kind].max - form.refs[kind].length]));
}

// 已经用上的本机文件的地址：选素材时同一份不让加第二次。
export function usedMediaUrls() {
  const { studio } = composer;
  const refs = studio.type === 'flow' ? Object.values(studio.flow.refs) : studio.type === 'image' ? studio.image.refs || [] : studio.type === 'music' ? [studio.music.video] : allRefs();
  return refs.filter((ref): ref is Ref => Boolean(ref)).map((ref) => ref.url);
}

// 把一份素材加进当前的输入框。slot 是首尾帧里指定放哪一格；没指定就放进第一个空着的。加不进去时返回原因。
export function addMedia(ref: Ref, slot?: 'first' | 'last'): string | null {
  const { form, studio } = composer;
  const label = KINDS[ref.kind].label;
  if (studio.type === 'flow') {
    // 工作流的素材槽是规则的字段名。拖进来的文件放进第一个空着、类型对得上的槽里。
    const key = firstEmptySlot(ref.kind);
    if (!key) return `当前工作流没有空着的${label}位`;
    setFlowRef(key, ref);
    return null;
  }
  if (studio.type === 'music') {
    if (ref.kind !== 'video') return '请添加视频文件';
    updateStudio('music', { video: ref });
    return null;
  }
  const room = mediaRoom();
  if (!(ref.kind in room)) return `当前不支持添加${label}`;
  if (studio.type === 'image') {
    const refs = studio.image.refs || [];
    if (refs.some((r) => sameMedia(r, ref))) return null;
    if (refs.length >= imageRefLimit()) return `${label}数量已达上限`;
    updateStudio('image', { refs: [...refs, ref] });
    return null;
  }
  if (form.mode === 'frames') {
    const key = slot || (!form.frames.first ? 'first' : hasLastFrame() && !form.frames.last ? 'last' : null);
    if (!key) return '首帧和尾帧均已添加';
    update({ frames: { ...form.frames, [key]: ref } });
    return null;
  }
  const list = form.refs[ref.kind];
  if (list.some((r) => sameMedia(r, ref))) return null;
  if (list.length >= KINDS[ref.kind].max) return `${label}数量已达上限`;
  update({ refs: { ...form.refs, [ref.kind]: [...list, ref] } });
  return null;
}

// 拖进来或粘贴进来的文件：先传上去，再按 addMedia 的规则加进输入框。
export async function addFiles(files: File[]) {
  if (!files.length) return;
  if (!Object.keys(mediaRoom()).length) return toast('当前类型不支持添加素材', 'info');
  let uploading = false;
  for (const file of files) {
    const kind = kindOfFile(file);
    const room = mediaRoom();
    const problem = !kind ? `不支持的文件类型：${file.name}` : !(kind in room) ? `当前不支持添加${KINDS[kind].label}` : room[kind]! <= 0 ? `${KINDS[kind].label}数量已达上限` : null;
    if (problem) {
      toast(problem, 'info');
      continue;
    }
    if (!uploading) toast('正在上传…', 'info', 1800);
    uploading = true;
    try {
      const ref = await uploadLocalFile(file, kind!);
      const refused = addMedia(ref);
      if (refused) toast(refused, 'info');
    } catch (err) {
      toast((err as Error).message, 'error', 6000);
    }
  }
}

// 首帧和尾帧对调。
export function swapFrames() {
  const { first, last } = composer.form.frames;
  update({ frames: { first: last, last: first } });
}

// 图片能选的画面比例：各模型收的比例登记好了，只留这个模型收的。模型列表还没读到时先全列着。
export const IMAGE_RATIOS = ['16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'];
export function imageRatios(model = composer.studio.image.model) {
  const accepted = state.catalog.imageRatios[model];
  return accepted ? IMAGE_RATIOS.filter((r) => accepted.includes(r)) : IMAGE_RATIOS;
}
// 图片能选的分辨率档位。模型列表还没读到时是空的，这时不显示分辨率。
export const imageSizes = (model = composer.studio.image.model) => state.catalog.imageSizes[model]?.options || [];
// 选着的档位这个模型没有（或者还没选过）时，用它默认的那一档；模型不分档时不带档位。
export function fitImageSize(model: string, resolution?: string) {
  const sizes = state.catalog.imageSizes[model];
  if (!sizes) return undefined;
  return resolution && sizes.options.includes(resolution) ? resolution : sizes.default;
}
// 图片能选的画质档位。只有分画质的模型（GPT Image 2.5）才有，其余是空的，这时不显示画质。
export const imageQualities = (model = composer.studio.image.model) => state.catalog.imageQualities[model]?.options || [];
// 选着的画质这个模型没有（或者还没选过）时，用它默认的那一档；模型不分画质时不带。
export function fitImageQuality(model: string, quality?: string) {
  const qualities = state.catalog.imageQualities[model];
  if (!qualities) return undefined;
  return quality && qualities.options.includes(quality) ? quality : qualities.default;
}
// 这个图片模型最多收几张参考图（图生图）。0 是不能带参考图。
export const imageRefLimit = (model = composer.studio.image.model) => state.catalog.imageRefs[model] || 0;
// 换了图片模型后，选着的比例它不收就换成它收的第一个；分辨率、画质它没有那一档就换成它默认的；参考图超出它收的张数，多的去掉。
function fitImage() {
  const { image } = composer.studio;
  const ratios = imageRatios();
  if (state.catalog.known && (image.refs?.length || 0) > imageRefLimit()) image.refs = (image.refs || []).slice(0, imageRefLimit());
  if (ratios.length && !ratios.includes(image.ratio)) image.ratio = ratios[0];
  // 模型列表还没读到时先不动，免得把存着的选择冲掉。
  if (state.catalog.known) image.resolution = fitImageSize(image.model, image.resolution);
  if (state.catalog.known) image.quality = fitImageQuality(image.model, image.quality);
}

export function updateStudio<T extends 'image' | 'speech' | 'sfx' | 'music'>(type: T, patch: Partial<Studio[T]>) {
  Object.assign(composer.studio[type], patch);
  if (type === 'image') fitImage();
  composer.submitError = '';
  persist();
  changed();
}

// 把整份工作流表单（选的工作流、填的值、用的素材）换掉：复用记录时用，记录里有当时的那份规则。
export function setFlowForm(next: Studio['flow']) {
  composer.studio.flow = { workflow: next.workflow, values: { ...next.values }, refs: { ...next.refs } };
  composer.submitError = '';
  persist();
  changed();
}

export function setType(type: CreateType) {
  composer.studio.type = type;
  state.createType = type;
  emit('createType');
  composer.beforePolish = null;
  composer.submitError = '';
  stopPreview();
  persist();
  changed();
  if (type === 'speech') ensureVoices();
}

// 把一份视频表单填回输入框（复用记录时用）。
export function setForm(next: Partial<VideoForm>) {
  composer.form = mergeForm(JSON.parse(JSON.stringify(next)));
  if (!state.models.includes(composer.form.model) && state.models.length) composer.form.model = state.models[0];
  fitModel();
  setType('video');
}

// 把图片、语音、音效、配乐的表单填回输入框。
export function setStudio(type: 'image' | 'speech' | 'sfx' | 'music', next: Record<string, unknown> | undefined) {
  const { type: _ignored, ...fields } = JSON.parse(JSON.stringify(next || {}));
  (composer.studio[type] as object) = { ...studioDefaults()[type], ...fields };
  setType(type);
}

// 拿一张生成的图片去生成视频：当作参考图（全能参考）。模型照着图里的人和物另拍一段，不要求视频从这张图原样开始；
// 想让视频严格从这张图开始，再手动改成首尾帧。
export async function useImageForVideo(item: HistoryItem) {
  // 从卡片拿过来的是一件新的事：上一次写到一半的提示词不带着，免得连着旧字一起发出去。
  Object.assign(composer.form, { mode: 'reference', refs: { image: [await refFromRecord(item)], video: [], audio: [] }, prompt: '' });
  composer.beforePolish = null;
  setType('video');
  goTo('create');
}

// 把角色的参考图变成一组本机的参考素材。
export const refsFromCharacter = (character: Character): Ref[] => character.images.map((url) => ({ uid: crypto.randomUUID(), kind: 'image', source: 'local', url, name: character.name, thumb: url }));

// 拿一个角色去生成图片或视频：把它的参考图加进输入框，已经加好的素材留着；角色的描述接在提示词后面（空着就是它本身），
// 常见的顺序是先写要做什么、再选角色，只在空着时才填的话描述就用不上了。已经写进去的不重复加。
// 图片：当参考图（图生图），当前模型不收参考图就换成第一个收的。视频：当参考图。
const withDescription = (prompt: string, description: string) => {
  const text = prompt.trim();
  const extra = (description || '').trim();
  if (!extra || text.includes(extra)) return prompt;
  return text ? `${text}\n${extra}` : extra;
};

export function useCharacter(character: Character, type: 'image' | 'video') {
  const refs = refsFromCharacter(character);
  if (!refs.length) throw new Error('该角色暂无参考图，请先添加');
  const { form, studio } = composer;
  // 角色的图排在已有参考图的后面，同一张不重复加。
  const merged = (current: Ref[]) => [...current, ...refs.filter((ref) => !current.some((r) => r.url === ref.url))];
  if (type === 'image') {
    const model = [studio.image.model, ...state.catalog.image].find((id) => imageRefLimit(id) > 0);
    if (!model) throw new Error('暂无支持参考图的图片模型');
    Object.assign(studio.image, { model, refs: merged(studio.image.refs || []).slice(0, imageRefLimit(model)) });
    studio.image.prompt = withDescription(studio.image.prompt, character.description);
    fitImage();
  } else {
    Object.assign(form, { mode: 'reference', refs: { ...form.refs, image: merged(form.refs.image).slice(0, KINDS.image.max) } });
    form.prompt = withDescription(form.prompt, character.description);
    fitModel();
  }
  setType(type);
  goTo('create');
}

// 给一条已经存到本机的视频配乐：把它放进配乐的输入框，等用户写上要什么样的音乐再提交。
export async function useVideoForMusic(item: HistoryItem) {
  // 同上：换了一条要配的视频，旧的描述不留。
  composer.studio.music = { ...composer.studio.music, video: await refFromRecord(item), prompt: '' };
  composer.beforePolish = null;
  setType('music');
  goTo('create');
}

// ---------- 音色 ----------

export async function ensureVoices() {
  if (state.voices || !state.app.hasKey) return;
  composer.voicesError = '';
  try {
    await loadVoices();
  } catch (err) {
    composer.voicesError = (err as Error).message;
  }
  // 还没选过音色：有中文音色就先用第一个中文的，朗读中文最自然。
  const { speech } = composer.studio;
  const voices = (state.voices || []) as Voice[];
  if (voices.length && !voices.some((v) => v.id === speech.voiceId)) {
    const first = voices.find((v) => v.language === 'zh') || voices[0];
    Object.assign(speech, { voiceId: first.id, voiceName: voiceName(first) });
    persist();
  }
  changed();
}

const VOICE_GENDERS: Record<string, string> = { male: '男声', female: '女声', neutral: '中性' };
const VOICE_LANGUAGES: Record<string, string> = { zh: '中文', en: '英语', ja: '日语', ko: '韩语', es: '西班牙语', pt: '葡萄牙语', fr: '法语', de: '德语', it: '意大利语', ru: '俄语', ar: '阿拉伯语', id: '印尼语', th: '泰语', vi: '越南语', ms: '马来语', fil: '菲律宾语' };
// 音色的名字是「名字 - 一句描述」，前半截当名字，后半截当附注。
export const voiceName = (voice: Voice) => voice.name.split(/\s[-–]\s/)[0];
export const voiceNote = (voice: Voice) => [VOICE_GENDERS[voice.gender], VOICE_LANGUAGES[voice.language] || voice.language.toUpperCase(), voice.name.split(/\s[-–]\s/)[1]].filter(Boolean).join(' · ');

const preview = new Audio();

export function stopPreview() {
  preview.pause();
  composer.previewing = '';
}
// 试听放完、或者被别处的播放顶掉时，按钮变回「试听」。换一个音色试听时地址会换，那一下不算停。
exclusive(preview);
const previewStopped = () => {
  if (!preview.paused && !preview.ended) return;
  composer.previewing = '';
  emit('composer');
};
preview.addEventListener('ended', previewStopped);
preview.addEventListener('pause', previewStopped);

export function togglePreview(voice: Voice) {
  if (composer.previewing === voice.id) {
    stopPreview();
  } else {
    preview.src = voice.previewUrl!;
    preview.play().catch(() => toast('试听播放失败', 'error'));
    composer.previewing = voice.id;
  }
  emit('composer');
}

export function setVoiceFilter(filter: typeof composer.voiceFilter) {
  composer.voiceFilter = filter;
  emit('composer');
}

export function pickVoice(voice: Voice) {
  stopPreview();
  updateStudio('speech', { voiceId: voice.id, voiceName: voiceName(voice) });
}

// ---------- 润色、提交 ----------

// 用户自己在输入框里打字。动了文字，润色前的原文就不再留着，「撤销润色」变回「润色」。
export function typePrompt(text: string) {
  writePrompt(text);
  composer.beforePolish = null;
  composer.submitError = '';
  persist();
  emit('composer');
}

function setPrompt(text: string) {
  writePrompt(text);
  composer.submitError = '';
  persist();
  emit('composer');
}

// 让文本模型把提示词补充得更具体。结果直接替换输入框里的文字，可以撤销。
export async function polish() {
  const { type } = composer.studio;
  const original = draftPrompt();
  if (!original.trim()) return toast(type === 'speech' ? '请先输入朗读文本' : '请先输入提示词', 'info');
  composer.polishing = true;
  emit('composer');
  try {
    const wanted = polishModel();
    // 各个生成模型的提示词写法不一样，所以把这次要用的模型、生成方式和带了几份参考素材一起告诉它。
    const { form, studio } = composer;
    const target =
      type === 'video'
        ? { model: form.model, mode: form.mode, refs: { image: form.refs.image.length, video: form.refs.video.length, audio: form.refs.audio.length }, duration: form.durationAuto ? undefined : Number(form.duration) }
        : type === 'image'
          ? { model: studio.image.model, refs: { image: studio.image.refs?.length || 0 } }
          : {};
    const { text, model } = await api('POST', '/api/polish', { text: original, kind: type, model: wanted, target });
    // 等结果的时候用户换了类型或者又改了文字，就不去覆盖。
    if (composer.studio.type === type && draftPrompt() === original) {
      composer.beforePolish = original;
      setPrompt(text);
      if (model !== wanted) toast('润色模型不可用，已自动切换', 'info', 5000);
    }
  } catch (err) {
    toast((err as Error).message, 'error', 6000);
  } finally {
    composer.polishing = false;
    emit('composer');
  }
}

export function undoPolish() {
  const original = composer.beforePolish;
  composer.beforePolish = null;
  setPrompt(original || '');
}

export async function submit() {
  const { studio, form } = composer;
  const { type } = studio;
  let request = currentRequest();
  const problem = submitProblem();
  if (problem) return toast(problem, 'info');
  const skill = activeSkill();
  if (skill && !polishModel()) return toast('暂无可用的文本模型，请取消技能后重试', 'info');
  composer.submitting = true;
  composer.submitError = '';
  emit('composer');
  try {
    // 选了技能：先让文本模型按规则把这句话扩写成提示词，再拿扩写的结果去生成。输入框里留着的还是用户写的那句话。
    if (skill) {
      const { text } = await api('POST', '/api/skills/expand', { id: skill.id, text: draftPrompt(), context: skillContext(), model: polishModel() });
      request = currentRequest(text);
      if (request.problems.length) throw new Error(request.problems[0]);
    }
    if (type === 'video') await api('POST', '/api/videos', { payload: request.payload, form });
    else if (type === 'image') await api('POST', '/api/images', { payload: request.payload, form: { type, ...studio.image } });
    else if (type === 'flow') {
      // 工作流只给服务端工作流的 uuid 和填的值；素材的地址是记录里的短地址或链接，服务端负责内嵌或换公网直链。
      const { workflow, refs, values } = studio.flow;
      await api('POST', '/api/autodl/submit', { workflow: workflow!.uuid, inputs: request.payload, form: { type, workflow, values, refs } });
    } else await api('POST', `/api/audio/${type}`, { ...request.body, form: { type, ...studio[type] } });
    toast('已提交', 'success');
    startHistoryLoop();
  } catch (err) {
    composer.submitError = (err as Error).message;
    composer.submitDetail = (err as ApiError).detail || '';
  } finally {
    composer.submitting = false;
    emit('composer');
  }
}

// 输入框的文本框。点侧栏的「创作」时要把光标放回去。
let promptEl: HTMLTextAreaElement | null = null;
export const registerPrompt = (el: HTMLTextAreaElement | null) => {
  promptEl = el;
};
// 下一次把光标放回文本框时，放在第几个字后面。用完就清掉。
let caretAfterFocus: number | null = null;
export function focusComposer() {
  if (!promptEl || promptEl.hidden) return;
  promptEl.focus();
  if (caretAfterFocus !== null) promptEl.setSelectionRange(caretAfterFocus, caretAfterFocus);
  caretAfterFocus = null;
}

// 读到 Key 的状态之后调一次，然后才画输入框。
export function initComposer() {
  // 多人模式：换成这个账号自己的那份。不分账号的那份是以前谁留下的说不准，删掉。
  const user = state.app.user;
  if (user) {
    owner = user.id;
    composer.form = load(FORM_KEY, mergeForm);
    composer.studio = load(STUDIO_KEY, mergeStudio);
    state.createType = composer.studio.type;
    try {
      localStorage.removeItem(FORM_KEY);
      localStorage.removeItem(STUDIO_KEY);
    } catch {
      /* 读写不了就算了 */
    }
  }
  const { studio } = composer;
  fitModel();
  if (studio.type === 'speech') ensureVoices();

  on('app', () => {
    if (composer.studio.type === 'speech') ensureVoices();
  });
  on('models', () => {
    const info = state.modelsInfo;
    // 选着的型号不在列表里（以前别的平台的型号、已经下线的型号），或者它所在的平台没配 Key，就换成第一个能用的。
    const usable = (list: string[]) => list.filter((m) => !state.catalog.unavailable.includes(m));
    const videos = usable(state.models);
    if (!videos.includes(composer.form.model) && videos.length) composer.form.model = videos[0];
    fitModel();
    const images = usable(state.catalog.image);
    if (images.length && !images.includes(composer.studio.image.model)) composer.studio.image.model = images[0];
    fitImage();
    persist();
    if (state.app.hasKey && info.source === 'default' && info.error) toast(`模型列表加载失败，已显示默认模型。${info.error}`, 'error', 6000);
    changed();
  });
  // 读到工作流目录之后，上次选的工作流还在的话把它的规则取回来（表单按规则画）。已经填着的值不动。
  on('flows', () => {
    loadFlowDefinition();
    changed();
  });
}

// 选中了工作流、但规则还没取到（页面刚打开、目录刚读到）：取一份，按规则把缺的默认值补上，已经填的值留着。
export async function loadFlowDefinition() {
  const { workflow } = composer.studio.flow;
  if (!workflow || flowCache.has(workflow.uuid)) return;
  const flow = await fetchFlow(workflow.uuid);
  if (!flow || composer.studio.flow.workflow?.uuid !== workflow.uuid) return;
  const defaults = formValues(flow);
  const values: Record<string, unknown> = {};
  const current = composer.studio.flow.values;
  for (const [key, value] of Object.entries(defaults)) values[key] = current[key] !== undefined ? current[key] : value;
  composer.studio.flow.values = values;
  persist();
  changed();
}

export function dismissSubmitError() {
  composer.submitError = '';
  emit('composer');
}
