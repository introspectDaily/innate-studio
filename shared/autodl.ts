// AutoDL.art 的 ComfyUI 工作流：把平台上给出的 input_rules 变成表单能画的样子、校验提交的参数、按计费配置算价格。
// 全部是不碰网络、不碰页面、不碰磁盘的纯函数，本地服务和页面都读这一份，测试也直接测它。
// 规则的样子（平台文档 + 2026-10-31 线上核对）：
// - string / prompt：一段文字，可选 min_length、max_length。
// - integer / number：一个数，可选 min、max、default。
// - boolean：开关，可选 default。
// - enum：几选一，options 是 [{label, values:{node.field: value}}]。提交的是 label 本身。
// - image / video / audio：一份媒体，可选 accept_types（MIME 列表）；可选项的 default 可能是 "default_local_path:…;https://…" 这种占位说明，不能当值提交。

export type RuleType = 'string' | 'prompt' | 'integer' | 'number' | 'boolean' | 'enum' | 'image' | 'video' | 'audio';
export type MediaRuleType = 'image' | 'video' | 'audio';

export interface EnumOption {
  label: string;
  values?: Record<string, unknown>;
}

export interface InputRule {
  type: RuleType;
  required?: boolean;
  label?: string;
  description?: string;
  default?: unknown;
  min?: number;
  max?: number;
  min_length?: number;
  max_length?: number;
  step?: number;
  // 有 min/max 且适合拖的数字参数（输出时长这种）画成滑块，不是输入框。
  slider?: boolean;
  accept_types?: string[];
  options?: EnumOption[];
  node_id?: string;
  field?: string;
}

export interface WorkflowSummary {
  uuid: string;
  name: string;
  description?: string;
  cover_image_url?: string;
  price?: number;
  price_type?: string;
  billing_config?: Record<string, any>;
  billing_interval_seconds?: number;
  input_rules?: Record<string, InputRule>;
  input_example?: string;
  output_example?: string;
  version?: string;
  usage_count_7d?: number;
  endpoint_info?: Record<string, any>;
  api_reference_url?: string;
}

// 自动填的默认值。媒体描述里那串 default_local_path 占位不能当默认值，当作没有默认值。
export function ruleDefault(rule: InputRule): unknown {
  const value = rule.default;
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  if (rule.type === 'image' || rule.type === 'video' || rule.type === 'audio') {
    if (typeof value !== 'string' || value.startsWith('default_local_path:')) return undefined;
  }
  return value;
}

// input_example 是一串给人看的说明（JSON 字符串），只挑字符串里的值当占位示例；数字、布尔这些规则自己的默认值更可靠。
export function exampleValue(workflow: Pick<WorkflowSummary, 'input_example'>, key: string): unknown {
  if (!workflow.input_example) return undefined;
  try {
    const parsed = JSON.parse(workflow.input_example);
    return parsed && typeof parsed === 'object' ? parsed[key] : undefined;
  } catch {
    return undefined;
  }
}

// 这个工作流里哪些类型的素材是必填的，没有就是不需要。
export const requiredMedia = (rules: Record<string, InputRule> = {}): MediaRuleType[] => (['image', 'video', 'audio'] as MediaRuleType[]).filter((type) => Object.values(rules).some((rule) => rule.type === type && rule.required));

// 媒体规则里能收的 MIME 列表，没写就按这类素材常见的来。
export const mediaAccepts = (rule: InputRule): string[] => (rule.accept_types?.length ? rule.accept_types : []);

// 平台上大多数规则只有字段名（prompt、ref_image_3），没有 label。界面上和出错原因里按字段名写成人话：
// 认识的字段用下面这份对照，带序号的素材按序号称呼，其余的原样显示。
const KNOWN_LABELS: Record<string, string> = {
  prompt: '提示词',
  prompt_text: '朗读文本',
  prompt_simple: '音色参考音频',
  duration: '时长',
  audio_duration: '时长',
  mode: '模式',
  resolution: '分辨率',
  seed: '随机种子',
  style_preset: '风格预设',
  first_frame: '首帧',
  last_frame: '尾帧',
  ref_image: '参考图',
  ref_video: '参考视频',
  emo_control_method: '情感控制方式',
  emo_ref_audio: '情感参考音频',
  emo_random: '随机情感',
  emo_happy: '快乐',
  emo_angry: '愤怒',
  emo_sad: '悲伤',
  emo_afraid: '害怕',
  emo_disgusted: '厌恶',
  emo_melancholic: '忧郁',
  emo_surprised: '惊讶',
  emo_calm: '平静',
};

export function ruleLabel(rule: InputRule, key: string): string {
  if (rule.label) return rule.label;
  if (KNOWN_LABELS[key]) return KNOWN_LABELS[key];
  const image = /^ref_image_(\d+)$/.exec(key);
  if (image) return `参考图${Number(image[1]) + 1}`;
  const audio = /^ref_audio_(\d+)$/.exec(key);
  if (audio) return `参考音频${Number(audio[1]) + 1}`;
  return key;
}

// ---------- 价格 ----------
// AutoDL 的积分 1:1 折成 innate 的积分（1 积分 = 0.01 元）：价格 40 就是 40 积分。
// 计费配置有三种：
// - minimax_h3：按分辨率一档一个价，每档 {resolution, price, off_peak_price}。提交的分辨率是 "768p竖(768*1376)" 这样的 label，按开头的 480p / 768p / 1088p / 1440p 对档。
// - video_sec_cost：按秒计价 {price}，总价 = 每秒价 × 时长。
// - audio_sec_cost：按秒计价，但有一个最低价 {price, minimum_price}。
// 都按正常时段（price）算，不用 off_peak_price：提交时不保证一定在低价时段生成。
export function workflowPriceType(workflow: Pick<WorkflowSummary, 'price_type' | 'billing_config'>): string {
  if (workflow.price_type) return workflow.price_type;
  const config = workflow.billing_config || {};
  if (config.minimax_h3) return 'minimax_h3';
  if (config.video_sec_cost) return 'video_sec_cost';
  if (config.audio_sec_cost) return 'audio_sec_cost';
  return '';
}

// label 开头的分辨率档："768p竖(768*1376)" → "768p"，"736p横" → "736p"。认不出来就是空。
export const resolutionTier = (value: unknown): string => /^\s*(\d+p)/i.exec(String(value ?? ''))?.[1].toLowerCase() || '';

// 一条工作流的计费说明，界面和校验都用得上。金额到「元」为止，折算积分交给 toCredits。
export function stepPrice(workflow: Pick<WorkflowSummary, 'price_type' | 'billing_config' | 'price'>): { type: string; tiers?: { tier: string; yuan: number }[]; perSecond?: number; minimum?: number; fixed?: number } {
  const config = workflow.billing_config || {};
  const type = workflowPriceType(workflow);
  if (type === 'minimax_h3') {
    const tiers = (config.minimax_h3 || []).map((entry: { resolution?: string; price?: number }) => ({ tier: resolutionTier(entry.resolution), yuan: (Number(entry.price) || 0) / 100 })).filter((entry: { tier: string }) => entry.tier);
    return { type, tiers };
  }
  if (type === 'video_sec_cost') return { type, perSecond: (Number(config.video_sec_cost?.price) || 0) / 100 };
  if (type === 'audio_sec_cost') return { type, perSecond: (Number(config.audio_sec_cost?.price) || 0) / 100, minimum: (Number(config.audio_sec_cost?.minimum_price) || 0) / 100 };
  // 固定价格：price 是积分。
  return { type, fixed: (Number(workflow.price ?? config.price ?? 0) || 0) / 100 };
}

// 提交这一组参数大约多少元，算不出来是 null。inputs 是校验过、带默认值的提交参数；seconds 是输入素材的时长（按秒计费时用）。
export function workflowCost(workflow: Pick<WorkflowSummary, 'price_type' | 'billing_config' | 'price'>, inputs: Record<string, unknown>, seconds = 0): number | null {
  const config = workflow.billing_config || {};
  const type = workflowPriceType(workflow);
  // billing_config.minimax_h3 是按积分给的价：÷100 得到元。
  if (type === 'minimax_h3') {
    const tier = resolutionTier(inputs.resolution);
    const entry = (config.minimax_h3 || []).find((item: { resolution?: string }) => resolutionTier(item.resolution) === tier);
    if (!entry) return null;
    return (Number(entry.price) || 0) / 100;
  }
  if (type === 'video_sec_cost') {
    const rate = Number(config.video_sec_cost?.price) || 0;
    const length = durationOf(inputs);
    if (!rate || !(length > 0)) return null;
    return (rate / 100) * length;
  }
  if (type === 'audio_sec_cost') {
    const rate = Number(config.audio_sec_cost?.price) || 0;
    const minimum = (Number(config.audio_sec_cost?.minimum_price) || 0) / 100;
    if (!rate) return null;
    // 文字按每秒 4.5 个字估：中文正常朗读大约这个速度，宁可估多了也不要预扣少了。
    const spoken = Math.ceil(String(inputs.prompt_text || '').length / 4.5);
    return Math.max(minimum, (rate / 100) * Math.max(seconds, spoken, 1));
  }
  const fixed = Number(workflow.price ?? config.price ?? 0);
  return fixed > 0 ? fixed / 100 : type ? 0 : null;
}

// 按秒计费的时长参数：duration、audio_duration 都可能出现，都没有就看音频素材的时长（这是几分钟的活儿，不做精确计算）。
export function durationOf(inputs: Record<string, unknown>): number {
  for (const key of ['duration', 'audio_duration', 'seconds', 'video_seconds']) {
    const value = Number(inputs[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

// ---------- 校验 ----------
// 把一个提交参数对象按规则检查：不认识的 key 全拒；必填的不能缺；空的可选项删掉；
// 数字夹在 min/max 之间；enum 必须是 options 里的 label；文字长度在范围内；媒体必须是字符串（URL、data URL 或 base64）。
// 返回 { inputs, problems }，problems 非空时不能提交。inputs 是补好默认值、删掉空项之后要提交的对象。
export function cleanInputs(rules: Record<string, InputRule> = {}, raw: Record<string, unknown> = {}): { inputs: Record<string, unknown>; problems: string[] } {
  const problems: string[] = [];
  const inputs: Record<string, unknown> = {};
  const extra = Object.keys(raw || {}).filter((key) => !Object.hasOwn(rules, key));
  for (const key of extra) problems.push(`多出的参数：${key}`);

  for (const [key, rule] of Object.entries(rules)) {
    const name = ruleLabel(rule, key);
    const value = raw == null ? undefined : raw[key];
    const missing = value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
    if (missing) {
      // 必填但平台给了默认值的（声纹克隆的情感控制方式就是这样）就按默认值发，不拦。
      const fallback = ruleDefault(rule);
      if (fallback !== undefined) {
        inputs[key] = fallback;
      } else if (rule.required) {
        problems.push(`请填写${rule.type === 'string' || rule.type === 'prompt' ? '' : mediaName(rule.type)}${name}`);
      }
      continue;
    }
    if (rule.type === 'string' || rule.type === 'prompt') {
      const text = String(value);
      if (rule.min_length && text.length < rule.min_length) problems.push(`${name}不能少于 ${rule.min_length} 个字`);
      if (rule.max_length && text.length > rule.max_length) problems.push(`${name}不能超过 ${rule.max_length} 个字`);
      inputs[key] = text;
      continue;
    }
    if (rule.type === 'integer' || rule.type === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        problems.push(`${name}须为数字`);
        continue;
      }
      const fitted = rule.type === 'integer' ? Math.round(number) : number;
      if (rule.min !== undefined && fitted < rule.min) problems.push(`${name}不能小于 ${rule.min}`);
      if (rule.max !== undefined && fitted > rule.max) problems.push(`${name}不能大于 ${rule.max}`);
      inputs[key] = fitted;
      continue;
    }
    if (rule.type === 'boolean') {
      inputs[key] = value === true || value === 'true' || value === 1;
      continue;
    }
    if (rule.type === 'enum') {
      const labels = (rule.options || []).map((option) => option.label);
      if (labels.length && !labels.includes(String(value))) problems.push(`${name}须从可选值里选`);
      inputs[key] = String(value);
      continue;
    }
    // 媒体：本机文件在提交前已经换成 data URL 或公网链接，这里只确认是个能发出去的字符串。
    if (typeof value !== 'string') {
      problems.push(`${name}须为文件或链接`);
      continue;
    }
    inputs[key] = value;
  }
  return { inputs, problems };
}

const mediaName = (type: RuleType) => (type === 'image' ? '图片' : type === 'video' ? '视频' : type === 'audio' ? '音频' : '');

// 界面上这个规则该用什么控件：文字、文本域（prompt 或长文字）、数字、开关、下拉、媒体上传。
export function ruleKind(rule: InputRule): 'text' | 'textarea' | 'number' | 'toggle' | 'select' | 'media' {
  if (rule.type === 'string' || rule.type === 'prompt') return rule.type === 'prompt' || (rule.max_length || 0) > 200 ? 'textarea' : 'text';
  if (rule.type === 'integer' || rule.type === 'number') return 'number';
  if (rule.type === 'boolean') return 'toggle';
  if (rule.type === 'enum') return 'select';
  return 'media';
}

// ---------- 生成详情里的参数怎么摆 ----------
// 参数是三列小格（名称在上、取值在下）。提示词这类长文本塞进 1/3 列会被挤成一条竖线，
// 所以文本域、或者明显偏长的取值要独占一行；详情上方已经有全宽的「提示词」区块，
// 和它一字不差的那份参数就不必再列一遍。
const LONG_PARAM_CHARS = 60;
export const isLongParam = (text: string): boolean => text.length > LONG_PARAM_CHARS || text.includes('\n');
// 只有独占一行的文本才限高；型号名虽然独占一行，但短，不需要滚动。
export const paramIsLong = (wide?: boolean, value?: unknown): boolean => Boolean(wide) && typeof value === 'string' && isLongParam(value);

export type FlowDisplayParam = [name: string, value: string, wide?: boolean];

export function flowDisplayParams(
  payload: Record<string, unknown> = {},
  rules: Record<string, InputRule> = {},
  prompt = '',
): FlowDisplayParam[] {
  const main = prompt.trim();
  const entries: FlowDisplayParam[] = [];
  for (const [key, raw] of Object.entries(payload || {})) {
    const rule: InputRule = rules[key] || { type: 'string' };
    const kind = ruleKind(rule);
    // 素材在「参考素材」那一组里看，不在这儿重复。
    if (kind === 'media') continue;
    const text = typeof raw === 'boolean' ? (raw ? '开' : '关') : String(raw ?? '');
    const isText = rule.type === 'string' || rule.type === 'prompt';
    if (isText && main && text.trim() === main) continue;
    entries.push([ruleLabel(rule, key), text, kind === 'textarea' || isLongParam(text)]);
  }
  return entries;
}

// ---------- 工作流当成一种「模型」 ----------
// 画布节点和模型菜单里，工作流和 Seedance、MiniMax 这些型号并列出现。id 加个前缀，免得和工作流自己的 uuid、别的平台的型号混在一起。
export const FLOW_MODEL_PREFIX = 'flow:';
export const flowModelId = (uuid: string): string => `${FLOW_MODEL_PREFIX}${uuid}`;
export const isFlowModel = (model?: string | null): boolean => typeof model === 'string' && model.startsWith(FLOW_MODEL_PREFIX);
export const flowUuidOf = (model: string): string => model.slice(FLOW_MODEL_PREFIX.length);

// 工作流里放文字的那个参数：优先 prompt、prompt_text，没有就用第一条文字规则。
export function flowTextKey(rules: Record<string, InputRule> = {}): string | null {
  const text = Object.entries(rules).filter(([, rule]) => rule.type === 'string' || rule.type === 'prompt');
  return (text.find(([key]) => key === 'prompt') || text.find(([key]) => key === 'prompt_text') || text[0])?.[0] || null;
}

// 这个工作流收哪几份某种素材，按规则里键名的顺序排（ref_image_0、ref_image_1…、first_frame…）。
export function flowMediaKeys(rules: Record<string, InputRule> = {}, type: MediaRuleType): string[] {
  return Object.entries(rules).filter(([, rule]) => rule.type === type).map(([key]) => key);
}

// 工作流变成视频节点的那几个参数：分辨率取 resolution 的选项，时长取时长规则的范围，首尾帧看有没有对应的规则。
export interface FlowVideoSpec {
  resolutions: string[];
  ratios: string[];
  durations: number[];
  autoDuration: boolean;
  frames: string[];
  audio: boolean;
  seed: boolean;
  promptRequired: boolean;
}

export function flowVideoSpec(rules: Record<string, InputRule> = {}): FlowVideoSpec {
  const resolution = rules.resolution;
  const resolutions = resolution?.type === 'enum' ? (resolution.options || []).map((option) => option.label) : [];
  // 有的工作流时长参数叫 audio_duration（对口型那个）。范围太大时不给秒数选项，让用户去「参数」里自己填。
  const duration = rules.duration || rules.audio_duration;
  const min = Number(duration?.min);
  const max = Number(duration?.max);
  const durations = Number.isFinite(min) && Number.isFinite(max) && max >= min && max - min <= 30 ? Array.from({ length: max - min + 1 }, (_, i) => min + i) : [];
  const frames = ['first_frame', 'last_frame'].filter((key) => Object.hasOwn(rules, key));
  const text = flowTextKey(rules);
  return { resolutions, ratios: [], durations, autoDuration: false, frames, audio: false, seed: Object.hasOwn(rules, 'seed'), promptRequired: Boolean(text && rules[text].required) };
}

// 工作流当模型时，画布节点上收到的东西：一段文字、几份素材（按连线的顺序，图片带着首帧/尾帧的用途）、两个参数。
export interface FlowMedia {
  kind: MediaRuleType;
  url: string;
  role?: string;
  name?: string;
}

// 把节点的输入按工作流的规则拼成提交的入参：文字放第一个文字规则，首帧/尾帧放对应规则，
// 其余图片按 ref_image_0、1… 的顺序填，视频、音频同理；分辨率取规则里的 label，时长写进时长规则。
// placed 是每份素材落在哪个规则上，做记录里的素材快照用。
export function flowInputs(
  rules: Record<string, InputRule> = {},
  given: { prompt?: string; media?: FlowMedia[]; resolution?: string; duration?: number; extra?: Record<string, unknown> } = {},
): { inputs: Record<string, unknown>; problems: string[]; placed: { key: string; media: FlowMedia }[] } {
  const raw: Record<string, unknown> = {};
  const placed: { key: string; media: FlowMedia }[] = [];
  const textKey = flowTextKey(rules);
  const prompt = String(given.prompt || '').trim();
  if (textKey && prompt) raw[textKey] = prompt;

  const media = given.media || [];
  const imageKeys = flowMediaKeys(rules, 'image');
  let slot = 0;
  for (const item of media) {
    if (item.kind !== 'image') continue;
    const fixed = item.role === 'first' && rules.first_frame ? 'first_frame' : item.role === 'last' && rules.last_frame ? 'last_frame' : null;
    const key = fixed || imageKeys[slot++];
    if (!key) continue;
    raw[key] = item.url;
    placed.push({ key, media: item });
  }
  for (const kind of ['video', 'audio'] as MediaRuleType[]) {
    const keys = flowMediaKeys(rules, kind);
    let index = 0;
    for (const item of media) {
      if (item.kind !== kind) continue;
      const key = keys[index++];
      if (!key) continue;
      raw[key] = item.url;
      placed.push({ key, media: item });
    }
  }

  if (rules.resolution?.type === 'enum') {
    const labels = (rules.resolution.options || []).map((option) => option.label);
    const chosen = String(given.resolution ?? '');
    raw.resolution = labels.includes(chosen) ? chosen : ruleDefault(rules.resolution) ?? labels[0];
  }
  // 时长参数叫 duration 的居多，对口型那个叫 audio_duration。
  const durationKey = rules.duration ? 'duration' : rules.audio_duration ? 'audio_duration' : null;
  if (durationKey && given.duration) raw[durationKey] = given.duration;
  // 节点上另外选的参数（模式、风格、开关…）：只认规则里真有的键，不认识的丢掉（服务端也会拒）。
  for (const [key, rule] of Object.entries(rules)) {
    if (raw[key] !== undefined) continue;
    if (rule.type === 'image' || rule.type === 'video' || rule.type === 'audio' || rule.type === 'string' || rule.type === 'prompt') continue;
    if (given.extra && given.extra[key] !== undefined) raw[key] = given.extra[key];
  }

  const { inputs, problems } = cleanInputs(rules, raw);
  return { inputs, problems, placed };
}

// 表单的初始值：规则给的默认值；enum 没有默认值时取第一项；媒体空着等用户加。示例文字只当占位提示，不填进去。
export function formValues(workflow: Pick<WorkflowSummary, 'input_rules' | 'input_example'>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(workflow.input_rules || {})) {
    const fallback = ruleDefault(rule);
    if (fallback !== undefined) values[key] = fallback;
    else if (rule.type === 'enum' && rule.options?.length) values[key] = rule.options[0].label;
    else if (rule.type === 'image' || rule.type === 'video' || rule.type === 'audio') values[key] = null;
    else if (rule.type === 'boolean') values[key] = false;
    else values[key] = '';
  }
  return values;
}
