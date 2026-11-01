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
import { cleanInputs, ruleDefault } from './autodl.ts';

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
  // 这个参数改哪个节点。同一个字段常常在几个节点上各有一份（比如分块前馈，
  // 一采和二采各挂了一个），那就一次改完：给数组。
  nodeId: string | string[];
  field: string;
  type: 'enum' | 'int' | 'float' | 'bool' | 'text';
  choices?: RhChoice[];
  min?: number;
  max?: number;
  default?: string | number | boolean;
  // 界面上那句说明（为什么这么填）。
  hint?: string;
}

// 一组「一次调好多个参数」的档位，用来对付显存不够这种事：
// 用户不用自己研究该降分辨率还是该加分块，选一个档就行。
// 档里的值只覆盖「用户没自己动过」的参数——动过的以用户为准。
export interface RhPreset {
  key: string;
  label: string;
  note?: string;
  // key 是参数键（RhParam.key），value 是这个档要用的值。
  values: Record<string, string | number | boolean>;
}

// 画质档在界面上占的那一格（它本身也是一条规则，界面上是个下拉）。
export const RH_PRESET_KEY = 'preset';
// 没选档时显示这个。
export const RH_PRESET_CUSTOM = '自定义';

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
  // 参考图张数由这个节点的一个整数参数决定（工作流内部按张数切换分支时用）。
  // 值 = 用户真正给了几张图；后面为了填满槽位补的重复图不算。
  imageCount?: { nodeId: string; field: string };
  // 图片不够时怎么补空位：
  // last —— 用已经给的最后一张重复填（默认，至少保证不会把工作流里存的测试图带进来）
  // skip —— 不传，让工作流用它自己存的值（只在那个位置本来就是可选的时候才对）
  fill?: 'last' | 'skip';
  prompt?: { nodeId: string; field: string; label?: string; required?: boolean };
  // 成片在哪个节点。平台可能一次返回好几个文件（成片 + 一次采样的片段），
  // 主文件按这里的顺序排，下载和播放都以第一个为准。
  outputNodes?: string[];
  // 提示词里「@图片 1」这类引用在提交前换成什么写法。不写就是「图1」（画布默认，豆包那套模型认）。
  // 海螺 H3 工作流要写成 <Picture 1> / <Video 1> / <Audio 1>，模板里的 {n} 是这次请求里的序号。
  mentions?: { image?: string; video?: string; audio?: string };
  params?: RhParam[];
  // 画质/显存档位：界面上多一个下拉，选了就把档里的值套上去。
  presets?: RhPreset[];
  // 开放哪几档机器，写 RH_MACHINES 里的 value。不写就是只有标准档。
  machines?: string[];
  // 每档机器的估价（元），提交时按它预扣积分；完成后再按平台回的 consumeMoney 对账。
  estimate?: Record<string, number>;
  cover?: string;
}

// ---------- 工作流登记表 ----------
// 顺序就是工作流选择里的顺序。

// 两个海螺 H3 工作流的可调参数是一样的（v1.7 只是多了「参考图张数」由图片数量自动决定）。
const HAILUO_PARAMS: RhParam[] = [
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
      { key: 'megapixels', label: '一采分辨率（百万像素）', nodeId: '209', field: 'megapixels', type: 'float', min: 0.2, max: 1.5, default: 0.5, hint: '第一遍采样的分辨率：0.5 ≈ 960×544，0.3 ≈ 832×480。显存不够就往下降' },
      { key: 'shorter_edge', label: '参考图短边', nodeId: '246', field: 'value', type: 'int', min: 512, max: 1536, default: 928, hint: '参考图先缩到这个短边（只缩不放），是给参考编码省算力的预算上限。没有对齐要求：H3 节点内部会把宽高各自取整到 32 的倍数再编码，填别的数不会报错。填太小角色一致性变差；填太大参考 token 变多，每一步采样都更慢更吃显存。928 是作者给 24G 机器的折中' },
  { key: 'steps', label: '采样步数', nodeId: '212', field: 'steps', type: 'int', min: 4, max: 20, default: 6, hint: '这个流用了 4 步加速 LoRA，超过 8 步一般不会更好' },
  // 种子放 205：它是最终那一遍采样（196）的噪声源。182 是预览那一遍的，改了看不到结果。
  { key: 'seed', label: '随机种子', nodeId: '205', field: 'noise_seed', type: 'int', min: 0, max: 4294967295, default: 0, hint: '填同一个数可以复现同一条结果' },
  // 时长和显存是绑死的：海螺 H3 是音视频一体模型，帧数一多 token 就爆炸。
  // 实测：14.9 秒（362 帧）× 1344×768 在标准 24G 上直接 torch.OutOfMemoryError（死在二采的采样器上），
  // 而作者自己跑的样例是 125 帧（约 5.2 秒）。所以这里把源视频截断的帧数做成参数，默认给一个跑得动的长度。
  { key: 'max_frames', label: '源视频最长帧数', nodeId: '286', field: 'frame_load_cap', type: 'int', min: 0, max: 1200, default: 96, hint: '0 = 用整段视频（最容易 OOM）。24G 机器建议 ≤ 120（约 5 秒）；想跑长片要同时降成片分辨率或换 48G 机器' },
  // 二采（节点 247）决定成片的输出尺寸：1 百万像素 ≈ 1344×768，是显存的大头。
  { key: 'upscale_megapixels', label: '二采分辨率（百万像素）', nodeId: '247', field: 'value', type: 'float', min: 0.3, max: 2, default: 1, hint: '第二遍采样（成片）的分辨率：1 ≈ 1344×768，0.5 ≈ 960×544。显存不够就往下降' },
  // 一采的结果（节点 271）默认只放在临时目录，平台不返回。打开它，一次采样的片段也会一起回到我们这边。
  { key: 'save_first_pass', label: '同时保留一次采样片段', nodeId: '271', field: 'save_output', type: 'bool', default: true, hint: '打开后结果里会多一段一次采样的视频，可以先看它再决定要不要用成片' },
  // ---- 省显存的那几个开关 ----
  // 分块前馈（MiniMaxChunkFeedForward）：token 太多时把 FFN 按 token 轴切几块算，峰值显存跟着降。
  // 一采（277）和二采（201）各挂了一个，所以两个都要改。
  { key: 'ff_chunks', label: 'FFN 分块数', nodeId: ['201', '277'], field: 'chunks', type: 'int', min: 1, max: 16, default: 2, hint: '前馈按 token 分几块算。块数越多单次占用越低：2→4→8→16。1 = 不分块（最快、最占显存）' },
  { key: 'ff_seq_threshold', label: '分块触发阈值（token）', nodeId: ['201', '277'], field: 'seq_threshold', type: 'int', min: 512, max: 16384, default: 4096, hint: 'token 数超过它才分块。调到 2048 让它早点分，峰值更低' },
  // 低显存注意力（MiniMaxLowVRAMAttention）：把注意力头分几组算。只挂在二采那条链上（620→202→201→183→200）。
  { key: 'attn_head_chunks', label: '注意力分组数', nodeId: '202', field: 'head_chunks', type: 'int', min: 1, max: 32, default: 4, hint: '注意力头分几组算。越大峰值显存越低：4→8→16。1 = 一次算完（最占显存）' },
  // 二采的潜空间放大：分块算 = 省显存；用完就卸载 = 把显存还给后面的采样。
  { key: 'upscaler_chunking', label: '放大分块', nodeId: '206', field: 'enable_chunking', type: 'bool', default: false, hint: '二采放大时逐块算，省显存、略慢' },
  { key: 'upscaler_force_unload', label: '放大完立刻卸载', nodeId: '206', field: 'force_unload', type: 'bool', default: false, hint: '放大结束把模型从显存里踢掉，给后面的采样腾地方' },
      // 帧率没有开放：207 的 frame_rate 和 286 的 force_rate、节点 340 里的 24 是联动的，
      // 只改一个会音画不同步。要改就在 ComfyUI 里一起改。
];

// 画质档：给用户一个「按显存」的省心选择，不用自己研究该降分辨率还是该加分块。
// 档里的值只覆盖用户没自己动过的参数。
const HAILUO_PRESETS: RhPreset[] = [
  {
    key: 'safe-24g',
    label: '省显存（24G 保底）',
    note: '标准 24G 机器上最稳的一档：分辨率压低、时长截到 5 秒内、注意力分组加倍',
    values: {
      megapixels: 0.3,
      upscale_megapixels: 0.5,
      max_frames: 96,
      ff_chunks: 4,
      ff_seq_threshold: 2048,
      attn_head_chunks: 8,
      upscaler_chunking: true,
      upscaler_force_unload: true,
    },
  },
  {
    key: 'standard-24g',
    label: '标准（24G 能跑）',
    note: '作者那套参数：960×544 起、放大到 1344×768、时长约 5 秒',
    values: {
      megapixels: 0.5,
      upscale_megapixels: 1,
      max_frames: 96,
      ff_chunks: 2,
      ff_seq_threshold: 4096,
      attn_head_chunks: 4,
      upscaler_chunking: false,
      upscaler_force_unload: false,
    },
  },
  {
    key: 'quality-48g',
    label: '画质优先（48G+）',
    note: '成片放大到约 1600×896、时长放到 7 秒左右，需要加强档机器',
    values: {
      megapixels: 0.5,
      upscale_megapixels: 1.5,
      max_frames: 168,
      ff_chunks: 4,
      ff_seq_threshold: 2048,
      attn_head_chunks: 8,
      upscaler_chunking: false,
      upscaler_force_unload: false,
    },
  },
];

// 海螺 H3 的提示词只认 <Picture N> / <Video N> / <Audio N> 这种写法（见 h3-ref2va 的定版格式），
// 画布上用户点 @ 插入的是「@图片 1」，提交前按这个模板换成 H3 的说法。
const HAILUO_MENTIONS = { image: '<Picture {n}>', video: '<Video {n}>', audio: '<Audio {n}>' };

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
    mentions: HAILUO_MENTIONS,
    params: HAILUO_PARAMS,
    presets: HAILUO_PRESETS,
    machines: ['default', 'plus', 'ultra'],
    // 207 是成片，271 是一次采样的片段（打开「同时保留一次采样片段」后才会回来）。
    outputNodes: ['207'],
    // 估价，按次。等真跑过几次，把这里换成平台回的实际 consumeMoney。
    estimate: { default: 0.5, plus: 1, ultra: 2 },
  },
  {
    // v1.7：同一套采样链，但参考图槽位在 ComfyUI 里做成了「按张数切分支」，
    // 所以 1~9 张都能用，且未启用的那几张既不加载也不编码。
    // 张数不用在这里暴露成参数：服务端按用户实际给了几张图去填 736。
    key: 'hailuo-h3-swap-9',
    name: '海螺 H3 人物替换 v1.7（参考图 1~9 张）',
    summary: '同 v1.5，但给几张参考图就用几张（1~9），多出来的不会拖慢。',
    kind: 'video',
    // 这个 id 才是能在 API 上调的 v1.7。之前配的 2116816328607047681 每次提交都返回
    // 810 WORKFLOW_NOT_SAVED_OR_NOT_RUNNING（那份从没在 RunningHub 界面里保存并运行过）。
    // 用 /api/openapi/getJsonApiFormat 核对过：95 个节点，736 是 PrimitiveInt(value=3)，
    // 750/751/757 是 a>=2/a>=3/a>=9，9 个 LoadImage 都在。
    workflowId: { ai: '2116808527745449985' },
    // 节点 215/218/221/614/615/618/730/731/732 是工作流里的 9 个 LoadImage，
    // 对应提示词里的 <Picture 1> ~ <Picture 9>。顺序不能改。
    images: [
      { nodeId: '215', field: 'image', label: '角色卡 1（<Picture 1>）' },
      { nodeId: '218', field: 'image', label: '角色卡 2（<Picture 2>）' },
      { nodeId: '221', field: 'image', label: '角色卡 3（<Picture 3>）' },
      { nodeId: '614', field: 'image', label: '角色卡 4（<Picture 4>）' },
      { nodeId: '615', field: 'image', label: '角色卡 5（<Picture 5>）' },
      { nodeId: '618', field: 'image', label: '角色卡 6（<Picture 6>）' },
      { nodeId: '730', field: 'image', label: '角色卡 7（<Picture 7>）' },
      { nodeId: '731', field: 'image', label: '角色卡 8（<Picture 8>）' },
      { nodeId: '732', field: 'image', label: '角色卡 9（<Picture 9>）' },
    ],
    minImages: 1,
    // 空出来的槽位用最后一张补：LoadImage 不至于读到工作流里存的旧图，
    // 真正的张数由下面的 imageCount 决定，补出来的位置不参与计算。
    fill: 'last',
    imageCount: { nodeId: '736', field: 'value' },
    videos: [{ nodeId: '286', field: 'video', label: '原视频' }],
    prompt: { nodeId: '248', field: 'value', label: '替换要求' },
    mentions: HAILUO_MENTIONS,
    params: HAILUO_PARAMS,
    presets: HAILUO_PRESETS,
    machines: ['default', 'plus', 'ultra'],
    outputNodes: ['207'],
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

  // 画质档放在参数最前面：它是「省心那一键」，先看到它再看到各个细项。
  if (workflow.presets?.length) {
    rules[RH_PRESET_KEY] = {
      type: 'enum',
      label: '画质档',
      description: '按显存给的一组推荐值，一次调好几个参数；自己动过的参数以你改的为准',
      options: [{ label: RH_PRESET_CUSTOM }, ...workflow.presets.map((preset) => ({ label: preset.label }))],
      default: RH_PRESET_CUSTOM,
    };
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
  // 需要上传的素材：key 是入参里的键，slot 说明是哪一个位置。
  // value 是这个位置最终要传的值——补位补出来的位置（用户没给这一张）在 inputs 里是空的，
  // 但平台那边这个 LoadImage 也得有一个真实文件，所以上传时按 value 读，不能回 inputs 里取。
  uploads: { key: string; kind: 'image' | 'video' | 'audio'; label: string; value: string }[];
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
    uploads.push({ key: rhImageKey(index), kind: 'image', label: images[index].label, value: final });
  });
  // 一张都没给、或者少于下限：说清楚要几张。
  if (images.length && filled.length < minImages) {
    problems.push(minImages > 1 ? `请上传${images[filled.length]?.label || '图片'}（至少 ${minImages} 张）` : `请上传${images[0].label}`);
  }
  // 工作流自己用「张数」参数挑分支（v1.7 的 1~9 张可选流）：按用户实际给了几张填，
  // 不按槽位数——上面为了填满 LoadImage 补出来的重复图不参与计数。
  if (workflow.imageCount && filled.length) {
    push(workflow.imageCount.nodeId, workflow.imageCount.field, filled.length);
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
      uploads.push({ key: keyOf(index), kind, label: slot.label, value });
    });
  }

  if (workflow.prompt) {
    const text = String(inputs[RH_PROMPT_KEY] ?? '').trim();
    if (text) push(workflow.prompt.nodeId, workflow.prompt.field, text);
  }

  // 页面没带某个参数时，用登记表里的默认值补上。
  // 必须补：画布那边只有「用户动过的」参数才会带过来，没带的就落回平台保存的那份工作流——
  // 而平台那份的 286.frame_load_cap 是 0（整段视频），一漏传就会又走回 OOM 那条路。
  // 创作页那边每个参数都带着默认值上来，这段对它没有影响。
  for (const param of workflow.params || []) {
    if (inputs[param.key] !== undefined && inputs[param.key] !== null && inputs[param.key] !== '') continue;
    // 枚举的 default 存的是节点要的原值，登记表里对外是标签，这里统一成标签。
    const fallback = param.type === 'enum'
      ? (param.choices || []).find((choice) => choice.value === param.default)?.label
      : param.default;
    if (fallback === undefined || fallback === null || fallback === '') continue;
    inputs[param.key] = fallback;
  }

  // 画质档：把档里的值套到「用户没自己动过」的参数上。
  // 动过的判断标准是：提交上来的值和规则里的默认值不一样（页面不填就用默认值，
  // 所以创作页那边每个参数都会带着默认值上来，画布那边只有动过的才带）。
  const preset = (workflow.presets || []).find((item) => item.label === String(inputs[RH_PRESET_KEY] ?? '')) || null;
  if (preset) {
    for (const [key, value] of Object.entries(preset.values)) {
      const rule = rules[key];
      if (!rule) continue;
      const given = inputs[key];
      const fallback = ruleDefault(rule);
      const touched = given !== undefined && fallback !== undefined && given !== fallback;
      if (touched) continue;
      inputs[key] = value;
    }
  }

  for (const param of workflow.params || []) {
    const value = inputs[param.key];
    if (value === undefined || value === null || value === '') continue;
    const targets = Array.isArray(param.nodeId) ? param.nodeId : [param.nodeId];
    // 枚举：界面给的是标签，节点要的是原值。
    if (param.type === 'enum') {
      const choice = (param.choices || []).find((item) => item.label === String(value));
      if (choice) for (const nodeId of targets) push(nodeId, param.field, choice.value);
      continue;
    }
    if (param.type === 'bool') {
      for (const nodeId of targets) push(nodeId, param.field, Boolean(value));
      continue;
    }
    if (param.type === 'text') {
      for (const nodeId of targets) push(nodeId, param.field, String(value));
      continue;
    }
    const number = Number(value);
    if (!Number.isFinite(number)) continue;
    const out = param.type === 'int' ? Math.round(number) : number;
    for (const nodeId of targets) push(nodeId, param.field, out);
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
