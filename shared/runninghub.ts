// RunningHub 的 ComfyUI 工作流：登记表，以及把登记表编译成界面能画的样子。
//
// 这里**不做**「RunningHub 上的工作流全自动接进来」。原因在平台这一侧：
// 1. 工作流 API 只能改「某个节点的某个字段的值」，不能增删节点、不能改连线。所以「原始工作流收 3 张图，
//    我们只想收 2 张」这件事，API 层做不到让第 3 个 LoadImage 节点消失——它只会用工作流里存着的那张默认图。
//    真要少收，只有三条路：在 ComfyUI 里把那个位置改成可选分支再另存一个 workflowId；或者另存一份精简版；
//    或者像下面这样，由我们把空着的槽位补成已有素材（fill 策略）。
// 2. 每个工作流该开放哪几个参数、参数取值是什么，平台不会告诉我们（只有 AI 应用有 apiCallDemo，
//    工作流没有）。所以每个工作流都要人读一遍它的 API JSON，挑出该让人改的节点登记在下面。
//
// 也就是说：架构是通用的（槽位 + 参数 + 机器档位 + 多 Key 路由），登记表是逐个工作流手工调的。
// 加一个工作流的步骤见 docs/runninghub-workflows.md。

import type { InputRule } from './autodl.ts';
import { cleanInputs } from './autodl.ts';

// 这些工作流在页面上的 id 前缀：flow:rh:<key>。和 AutoDL 的 flow:<uuid> 并列出现在模型菜单里。
export const RH_PROVIDER = 'runninghub';
export const RH_UUID_PREFIX = 'rh:';
export const rhUuid = (key: string): string => `${RH_UUID_PREFIX}${key}`;
export const isRhUuid = (uuid?: string | null): boolean => typeof uuid === 'string' && uuid.startsWith(RH_UUID_PREFIX);
export const rhKeyOfUuid = (uuid: string): string => uuid.slice(RH_UUID_PREFIX.length);

// 规则里的键名。图片、视频、音频按顺序编号，和 AutoDL 的 ref_image_0 一个写法，页面不用改。
export const rhImageKey = (index: number): string => `ref_image_${index}`;
export const rhVideoKey = (index: number): string => `ref_video_${index}`;
export const rhAudioKey = (index: number): string => `ref_audio_${index}`;
// 提示词、运行机器档位。
export const RH_PROMPT_KEY = 'prompt';
export const RH_MACHINE_KEY = 'machine';

// ---------- 机器档位 ----------
// RunningHub 按实例规格分三档，提交时用 instanceType 指定。平台只在「传了这档机器但账号没有」时报 435，
// 不会告诉你账号到底有没有——所以每个工作流自己声明开放哪几档，默认只开标准档。
export interface RhMachine {
  value: 'default' | 'plus' | 'ultra';
  label: string;
  note: string;
}

export const RH_MACHINES: RhMachine[] = [
  { value: 'default', label: '标准 24G', note: '默认档，多数工作流够用' },
  { value: 'plus', label: '加强 48G', note: '显存更大，单价比标准档高；账号没有这档机器会报 435' },
  { value: 'ultra', label: '旗舰 84G', note: '只有买了独占机器的账号能用' },
];

// ---------- 登记表的形状 ----------

// 一个素材位。nodeId 是画布上节点右上角的数字，field 是那个节点 inputs 里的 key。
export interface RhSlot {
  nodeId: string;
  field: string;
  label: string;
}

// 枚举的一个选项：label 给用户看，value 是真正发给节点的原值（类型必须和原字段一致）。
export interface RhChoice {
  label: string;
  value: string | number;
}

// 一个可调参数。除了提示词和素材位，其余都走这里。
export interface RhParam {
  key: string;
  label: string;
  nodeId: string;
  field: string;
  type: 'enum' | 'int' | 'float' | 'bool' | 'text';
  choices?: RhChoice[];
  min?: number;
  max?: number;
  default?: string | number | boolean;
  // 界面上那句说明（为什么这么填）。
  hint?: string;
}

// RunningHub 有两个站点：国内站 runninghub.cn、海外站 runninghub.ai。两边的账号、Key、工作流 id、
// 素材库都是各管各的，所以 Key 上必须写清它属于哪个站（Key 文件的 site 字段），工作流 id 也要按站配。
// 字段值就是域名后缀：cn = runninghub.cn，ai = runninghub.ai。
export type RhSite = 'ai' | 'cn';
export const RH_SITES: RhSite[] = ['cn', 'ai'];
// 工作流 id：可以只给一个（两个站点同一个 id 时），也可以按站分开给。
export type RhWorkflowIds = Partial<Record<RhSite, string>>;

// 把各种写法的站点值归一成 'ai' | 'cn'；认不出来返回空串（调用方决定是报错还是用默认值）。
// 除了 "ai" / "cn"，也认直接贴域名或站点地址（文档、聊天里两种写法都有人用）。
export function rhSiteOf(raw: unknown): RhSite | '' {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return '';
  if (text === 'ai' || text === 'cn') return text;
  if (text.includes('runninghub.ai')) return 'ai';
  if (text.includes('runninghub.cn')) return 'cn';
  return '';
}

export interface RhWorkflow {
  // 我们的内部 id，也是页面上的 workflow 标识。
  key: string;
  name: string;
  // 一句话说清它是干什么的，出现在工作流选择卡片上。
  summary: string;
  kind: 'video' | 'image' | 'audio';
  // RunningHub 上的工作流 id（按站点可不同）。留空表示「由服务端配置」，见 server/runninghub.js 的 resolveWorkflowId。
  workflowId?: string | RhWorkflowIds;
  images?: RhSlot[];
  videos?: RhSlot[];
  audios?: RhSlot[];
  // 至少要传几张图（默认等于槽位数）。少于这个数不提交；多出来的槽位按 fill 补。
  minImages?: number;
  // 图片不够时怎么补空位：
  // last —— 用已经给的最后一张重复填（默认，至少保证不会把工作流里存的测试图带进来）
  // skip —— 不传，让工作流用它自己存的值（只在那个位置本来就是可选的时候才对）
  fill?: 'last' | 'skip';
  prompt?: { nodeId: string; field: string; label?: string; required?: boolean };
  params?: RhParam[];
  // 开放哪几档机器，写 RH_MACHINES 里的 value。不写就是只有标准档。
  machines?: string[];
  // 每档机器的估价（元），提交时按它预扣积分；完成后再按平台回的 consumeMoney 对账。
  estimate?: Record<string, number>;
  cover?: string;
}

// ---------- 工作流登记表 ----------
// 顺序就是工作流选择里的顺序。

export const RH_WORKFLOWS: RhWorkflow[] = [
  {
    key: 'hailuo-h3-swap',
    name: '海螺 H3 人物替换 v1.5',
    summary: '把原视频里的人换成参考图里的角色，保留原片的动作、运镜和声音。',
    kind: 'video',
    // workflowId 留空：在 RunningHub 上「保存并导出 API」之后，把 id 配到环境变量
    // RUNNINGHUB_WORKFLOW_HAILUO_H3_SWAP（两个站点同一个 id）或
    // RUNNINGHUB_WORKFLOW_HAILUO_H3_SWAP_AI / _CN（两个站点各自一个 id），
    // 也可以写在数据目录 config.json 的 runninghubWorkflows.hailuo-h3-swap 里（可以给 {cn, ai}）。
    // 工作流 1.5 版按「海螺H3 人物替换专用流v1.5_api.json」登记的节点。
    images: [
      { nodeId: '215', field: 'image', label: '角色卡' },
      { nodeId: '218', field: 'image', label: '参考图 2' },
      { nodeId: '221', field: 'image', label: '参考图 3' },
    ],
    // 原工作流有三个 LoadImage。产品上只要求两张（角色卡 + 一张补充参考），第三张可选；
    // 只给两张时第三位重复第 2 张，避免把工作流里存着的那张测试图带进结果。
    minImages: 2,
    fill: 'last',
    videos: [{ nodeId: '286', field: 'video', label: '原视频' }],
    // 提示词的正文在 248 PrimitiveStringMultiline.value，208 节点的 prompt 是从它连线过去的，不能直接改。
    prompt: { nodeId: '248', field: 'value', label: '替换要求' },
    params: [
      {
        key: 'aspect_ratio',
        label: '画幅',
        nodeId: '209',
        field: 'aspect_ratio',
        type: 'enum',
        default: '16:9 (Widescreen)',
        // 选项是 KJNodes 的 ResolutionSelector 固定的那份下拉。第一次真跑时核对一遍：
        // 平台报 803 或者参数不合法，就照工作流 JSON 里 aspect_ratio 的写法改这里。
        choices: [
          { label: '16:9 横屏', value: '16:9 (Widescreen)' },
          { label: '9:16 竖屏', value: '9:16 (Portrait Widescreen)' },
          { label: '1:1 方形', value: '1:1 (Square)' },
          { label: '4:3 横向', value: '4:3 (Standard)' },
          { label: '3:4 纵向', value: '3:4 (Portrait)' },
          { label: '3:2 横向', value: '3:2 (Photo)' },
          { label: '2:3 纵向', value: '2:3 (Portrait Photo)' },
          { label: '21:9 宽银幕', value: '21:9 (Ultrawide)' },
        ],
      },
      { key: 'megapixels', label: '清晰度（百万像素）', nodeId: '209', field: 'megapixels', type: 'float', min: 0.2, max: 1.5, default: 0.5, hint: '越大越清晰也越慢' },
      { key: 'shorter_edge', label: '参考图短边', nodeId: '246', field: 'value', type: 'int', min: 512, max: 1536, default: 928, hint: '送进模型的参考图会缩到这个短边' },
      { key: 'steps', label: '采样步数', nodeId: '212', field: 'steps', type: 'int', min: 4, max: 20, default: 6, hint: '这个流用了 4 步加速 LoRA，超过 8 步一般不会更好' },
      // 种子放 205：它是最终那一遍采样（196）的噪声源。182 是预览那一遍的，改了看不到结果。
      { key: 'seed', label: '随机种子', nodeId: '205', field: 'noise_seed', type: 'int', min: 0, max: 4294967295, default: 0, hint: '填同一个数可以复现同一条结果' },
      // 帧率没有开放：207 的 frame_rate 和 286 的 force_rate、节点 340 里的 24 是联动的，
      // 只改一个会音画不同步。要改就在 ComfyUI 里一起改。
    ],
    machines: ['default', 'plus', 'ultra'],
    // 估价，按次。等真跑过几次，把这里换成平台回的实际 consumeMoney。
    estimate: { default: 0.5, plus: 1, ultra: 2 },
  },
];

export const rhWorkflow = (key?: string | null): RhWorkflow | null => RH_WORKFLOWS.find((item) => item.key === key) || null;

// 这个工作流开放了哪几档机器。默认只有标准档。
export function rhMachines(workflow: RhWorkflow): RhMachine[] {
  const wanted = workflow.machines?.length ? workflow.machines : ['default'];
  return RH_MACHINES.filter((machine) => wanted.includes(machine.value));
}

const MACHINE_DEFAULT = 'default';

// ---------- 编译成规则 ----------
// 页面（画布节点、「参数」面板、创作页的工作流表单）只认 AutoDL 那套 input_rules，
// 所以这里把登记表翻成同一形状，前端一行都不用为 RunningHub 单独写。

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/x-msvideo'];
const AUDIO_TYPES = ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/flac'];

const choiceLabel = (param: RhParam): string | undefined => {
  const found = (param.choices || []).find((choice) => choice.value === param.default);
  return found?.label;
};

export function rhRules(workflow: RhWorkflow): Record<string, InputRule> {
  const rules: Record<string, InputRule> = {};
  const minImages = workflow.minImages ?? (workflow.images || []).length;

  (workflow.images || []).forEach((slot, index) => {
    rules[rhImageKey(index)] = { type: 'image', label: slot.label, required: index < minImages, accept_types: IMAGE_TYPES };
  });
  (workflow.videos || []).forEach((slot, index) => {
    rules[rhVideoKey(index)] = { type: 'video', label: slot.label, required: true, accept_types: VIDEO_TYPES };
  });
  (workflow.audios || []).forEach((slot, index) => {
    rules[rhAudioKey(index)] = { type: 'audio', label: slot.label, required: false, accept_types: AUDIO_TYPES };
  });

  if (workflow.prompt) {
    // 类型用 prompt：页面上是文本域，并且会做提示词润色。
    rules[RH_PROMPT_KEY] = { type: 'prompt', label: workflow.prompt.label || '提示词', required: workflow.prompt.required !== false };
  }

  for (const param of workflow.params || []) {
    if (param.type === 'enum') {
      rules[param.key] = { type: 'enum', label: param.label, description: param.hint, default: choiceLabel(param), options: (param.choices || []).map((choice) => ({ label: choice.label })) };
    } else if (param.type === 'bool') {
      rules[param.key] = { type: 'boolean', label: param.label, description: param.hint, default: Boolean(param.default) };
    } else if (param.type === 'text') {
      rules[param.key] = { type: 'string', label: param.label, description: param.hint, default: typeof param.default === 'string' ? param.default : '' };
    } else {
      // integer / number 两种规则，界面上一律是数字输入框。
      rules[param.key] = { type: param.type === 'int' ? 'integer' : 'number', label: param.label, description: param.hint, min: param.min, max: param.max, default: param.default };
    }
  }

  const machines = rhMachines(workflow);
  if (machines.length > 1) {
    rules[RH_MACHINE_KEY] = { type: 'enum', label: '运行机器', description: '档位越高显存越大、单价越高', options: machines.map((machine) => ({ label: machine.label })), default: machines.find((machine) => machine.value === MACHINE_DEFAULT)?.label || machines[0].label };
  }
  return rules;
}

// 规则里存的机器档位（标签）换成 instanceType 里的值（default / plus / ultra）。
export function rhMachineOf(workflow: RhWorkflow, inputs: Record<string, unknown> = {}): string {
  const machines = rhMachines(workflow);
  const chosen = String(inputs[RH_MACHINE_KEY] ?? '');
  return machines.find((machine) => machine.label === chosen)?.value || machines[0]?.value || MACHINE_DEFAULT;
}

// 这个工作流要传哪几种素材（画布上挑选列表、历史记录里按类型分类用）。
export function rhMedia(workflow: RhWorkflow): ('image' | 'video' | 'audio')[] {
  return (['image', 'video', 'audio'] as const).filter((kind) => (kind === 'image' ? workflow.images : kind === 'video' ? workflow.videos : workflow.audios)?.length);
}

// ---------- 校验 + 拼 nodeInfoList ----------

export interface RhPlan {
  // 校验过、补好默认值的入参（记录里存的就是它）。
  inputs: Record<string, unknown>;
  problems: string[];
  // 真正发给 RunningHub 的 nodeInfoList。
  nodeInfoList: { nodeId: string; fieldName: string; fieldValue: string | number | boolean }[];
  // 提交时作为 instanceType 的那一档。
  machine: string;
  // 需要上传的素材：键是从 inputs 里取值的键，slot 说明是哪一个位置。
  uploads: { key: string; kind: 'image' | 'video' | 'audio'; label: string }[];
}

// 把页面给的入参按登记表检查一遍，再拼成 nodeInfoList。
// 注意：素材值在这里还是页面给的短地址（/media/... 或链接），由调用方换成像 RunningHub 认的 fileName。
export function rhPlan(workflow: RhWorkflow, raw: Record<string, unknown> = {}): RhPlan {
  const rules = rhRules(workflow);
  const cleaned = cleanInputs(rules, raw);
  // 素材缺失的说法自己重写一遍：cleanInputs 只知道规则的标签，拼出来是「请填写图片参考图 2」，
  // 这里的槽位标签本身已经是「角色卡」「原视频」这样的人话，直接说「请上传角色卡」。
  const inputs = cleaned.inputs;
  const problems = cleaned.problems.filter((problem) => !/^请填写(图片|视频|音频)/.test(problem));
  const nodeInfoList: RhPlan['nodeInfoList'] = [];
  const uploads: RhPlan['uploads'] = [];
  const push = (nodeId: string, fieldName: string, fieldValue: string | number | boolean) => nodeInfoList.push({ nodeId, fieldName, fieldValue });

  // 图片：给了几张就填几个位置，空位按 fill 策略补。
  const images = workflow.images || [];
  const minImages = workflow.minImages ?? images.length;
  const given = images.map((_, index) => String(inputs[rhImageKey(index)] ?? '').trim());
  const filled = given.filter(Boolean);
  const fallback = filled.length ? filled[filled.length - 1] : '';
  given.forEach((value, index) => {
    const final = value || (workflow.fill === 'skip' ? '' : fallback);
    if (!final) return;
    push(images[index].nodeId, images[index].field, final);
    uploads.push({ key: rhImageKey(index), kind: 'image', label: images[index].label });
  });
  // 一张都没给、或者少于下限：说清楚要几张。
  if (images.length && filled.length < minImages) {
    problems.push(minImages > 1 ? `请上传${images[filled.length]?.label || '图片'}（至少 ${minImages} 张）` : `请上传${images[0].label}`);
  }

  for (const [kind, slots, keyOf] of [
    ['video', workflow.videos || [], rhVideoKey],
    ['audio', workflow.audios || [], rhAudioKey],
  ] as const) {
    slots.forEach((slot, index) => {
      const value = String(inputs[keyOf(index)] ?? '').trim();
      if (!value) {
        // 视频是必需的，音频不是（多数工作流没有音频位）。
        if (kind === 'video') problems.push(`请上传${slot.label}`);
        return;
      }
      push(slot.nodeId, slot.field, value);
      uploads.push({ key: keyOf(index), kind, label: slot.label });
    });
  }

  if (workflow.prompt) {
    const text = String(inputs[RH_PROMPT_KEY] ?? '').trim();
    if (text) push(workflow.prompt.nodeId, workflow.prompt.field, text);
  }

  for (const param of workflow.params || []) {
    const value = inputs[param.key];
    if (value === undefined || value === null || value === '') continue;
    if (param.type === 'enum') {
      // 界面给的是标签，节点要的是原值。
      const choice = (param.choices || []).find((item) => item.label === String(value));
      if (choice) push(param.nodeId, param.field, choice.value);
      continue;
    }
    if (param.type === 'bool') {
      push(param.nodeId, param.field, Boolean(value));
      continue;
    }
    if (param.type === 'text') {
      push(param.nodeId, param.field, String(value));
      continue;
    }
    const number = Number(value);
    if (!Number.isFinite(number)) continue;
    push(param.nodeId, param.field, param.type === 'int' ? Math.round(number) : number);
  }

  const machine = rhMachineOf(workflow, inputs);
  // 机器档位不进 nodeInfoList（它是提交参数），但留在 inputs 里：记录要还原用户当时选的档位。
  return { inputs, problems, nodeInfoList, machine, uploads };
}

// ---------- 价格 ----------
// 登记表给的是每档机器的估价（元）。平台完成后会回 usage.consumeMoney（元），那时候以它为准。
export function rhCost(workflowKey: string, inputs: Record<string, unknown> = {}): number | null {
  const workflow = rhWorkflow(workflowKey);
  if (!workflow) return null;
  const machine = rhMachineOf(workflow, inputs);
  const estimate = workflow.estimate || {};
  const yuan = Number(estimate[machine] ?? estimate[MACHINE_DEFAULT]);
  return Number.isFinite(yuan) && yuan > 0 ? yuan : null;
}
