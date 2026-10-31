// 页面里来回传的几种数据的形状。接口返回的字段不全列，只写页面用到的。

export type { Skill } from '../../shared/skills.ts';

export type Kind = 'image' | 'video' | 'audio';
export type CreateType = 'video' | 'image' | 'speech' | 'sfx' | 'music' | 'flow';
export type ViewId = 'create' | 'canvas' | 'materials' | 'records' | 'characters' | 'skills';
export type Tone = 'ok' | 'pending' | 'error';


// 火山引擎 TOS 素材库。配置里不会返回 Secret，只返回是否已配置和 Access Key 的头尾。
export interface TosConfig {
  configured: boolean;
  bucket: string;
  prefix: string;
  region: string;
  endpoint: string;
  publicBaseUrl: string;
  bucketUrl: string;
  hasCredentials: boolean;
  credentialHint: string;
  credentialSource: 'env' | 'file' | 'tos-file' | '';
}

export interface TosObject {
  key: string;
  name: string;
  url: string;
  kind: Kind;
  contentType: string;
  size: number;
  lastModified: string | null;
}

export interface TosObjectList {
  items: TosObject[];
  nextCursor: string;
  truncated: boolean;
  prefix: string;
}

// 一份参考素材：存在本机的文件，或者公网链接。
export interface Ref {
  uid: string;
  kind: Kind;
  source: 'url' | 'local';
  url: string;
  name: string;
  thumb: string | null;
  duration?: number;
}

export interface VideoForm {
  mode: 'text' | 'frames' | 'reference';
  prompt: string;
  model: string;
  resolution: string;
  ratio: string;
  duration: number;
  durationAuto: boolean;
  generateAudio: boolean;
  seed: string;
  frames: { first: Ref | null; last: Ref | null };
  refs: Record<Kind, Ref[]>;
  // 选了技能时，prompt 是用户写的那句话，发送前按技能的规则扩写。
  skill?: SkillRef | null;
}

export interface ImageForm {
  prompt: string;
  model: string;
  ratio: string;
  // 分辨率档位（1K、2K 这样）。不写就用模型默认的那一档。
  resolution?: string;
  // 画质（low、medium 这样）。只有分画质的模型才有。
  quality?: string;
  count: number;
  // 参考图（图生图）。
  refs?: Ref[];
  skill?: SkillRef | null;
}

export interface SpeechForm {
  prompt: string;
  voiceId: string;
  voiceName: string;
}

export interface SfxForm {
  prompt: string;
  // 'auto' 是交给模型决定。
  duration: string | number;
}

export interface MusicForm {
  prompt: string;
  // 要配的那段视频，可以不给。给了，音乐就和它一样长。
  video: Ref | null;
  // 没给视频时音乐多长（秒）。
  duration: string | number;
}

// AutoDL.art 的工作流。workflow 只记是哪一个；参数规则的完整定义在选中或复用记录时现取，不存进浏览器。
// values 是规则里的文字、数字、开关、枚举；refs 是媒体规则选的素材，键是规则里的字段名（ref_image_0 这样）。
export interface FlowForm {
  workflow: { uuid: string; name: string } | null;
  values: Record<string, unknown>;
  refs: Record<string, Ref | null>;
}

export interface Studio {
  type: CreateType;
  image: ImageForm;
  speech: SpeechForm;
  sfx: SfxForm;
  music: MusicForm;
  flow: FlowForm;
}

export interface RefStatus {
  ready: boolean;
  tone: Tone;
  label?: string;
}

export interface BuiltRequest {
  payload?: Record<string, unknown>;
  body?: Record<string, unknown>;
  problems: string[];
}

export interface HistoryItem {
  id: string;
  // 在哪个平台提交的。ark 是火山方舟，minimax 是 MiniMax，aihubmix 是 AiHubMix；其余是以前别的平台留下的记录，只能看，不能再查询。
  provider?: string;
  kind: Kind;
  tool?: 'speech' | 'sfx' | 'music';
  status: 'queued' | 'in_progress' | 'completed' | 'failed';
  progress?: number;
  prompt?: string;
  model: string;
  mediaUrl?: string;
  videoUrl?: string;
  // 列表里用的小图（图片的缩小版、视频开头那一帧）。本地服务没做出来时没有，这时显示原文件。
  thumbUrl?: string | null;
  // 视频原文件的宽高和时长，和小图一起得到。
  media?: { width?: number; height?: number; duration?: number };
  savedLocally?: boolean;
  fileSize?: number;
  downloadError?: string;
  pollError?: string;
  direct?: boolean;
  error?: { message: string; code?: string; detail?: string };
  // 提交时发给接口的内容和当时的表单，字段随类型不同。
  payload?: Record<string, any>;
  form?: Record<string, any>;
  createdAt?: number;
  completedAt?: number;
  // 平台返回的用量：视频是 token，图片是张数和大小，语音是计费字符数，音效和配乐是秒数；以前别的平台留下的记录直接给美元。
  usage?: { total_tokens?: number; completion_tokens?: number; cost_usd?: number; generated_images?: number; size?: string; text_words?: number; audio_seconds?: number };
  // 多人模式下这一条的积分：quote 是提交时预扣的，charged 是现在实际扣着的（完成后按用量结算，失败了是 0）。
  credits?: { quote: number; charged: number };
  // AutoDL 的工作流：提交时平台给的定义快照（计费配置、参数、当时的那份规则），和平台返回的一组结果文件。
  workflow?: { uuid: string; name: string; kind?: Kind; billing?: { price_type?: string; billing_config?: Record<string, any>; price?: number }; inputs?: Record<string, unknown>; rules?: Record<string, import('../../shared/autodl.ts').InputRule> } | null;
  results?: { url: string; type?: string; file_type?: string; duration?: number; alias?: string; description?: string }[];
  extraFiles?: { file: string; size: number }[];
}


export interface Publication {
  provider: 'tos';
  url: string;
  expiresAt: string | null;
  direct: boolean;
  valid: boolean;
  checkedAt: number | null;
  purpose: 'share' | 'reference';
}

// 本地素材：文件一直在 /media/uploads 下；publications 只是按需生成并缓存的公网地址。
export interface LocalMaterial {
  id: string;
  url: string;
  name: string;
  kind: Kind;
  size: number;
  contentType: string;
  createdAt: number;
  publications: Publication[];
}

export interface StorageStatus {
  preferred: 'tos' | '';
  direct: 'tos' | '';
  tos: TosConfig;
}

// 一个角色：名字、描述和几张参考图。images 是本机图片的地址。
export interface Character {
  id: string;
  name: string;
  description: string;
  images: string[];
  updatedAt: number;
}

// 输入框里选着的技能。只记是哪个、叫什么；规则在发送时由本地服务去取。
export interface SkillRef {
  id: string;
  name: string;
}

export interface Voice {
  id: string;
  name: string;
  gender: string;
  language: string;
  previewUrl?: string;
}

// 一个 Key 的状态。
export interface KeyInfo {
  hasKey: boolean;
  keyHint: string;
  keySource: string;
  baseUrl: string;
}

// 最外面的几项说的是火山方舟的 Key。
export interface AppInfo extends KeyInfo {
  // 多人模式：要登录才能用，Key 和成员由管理员管。user 是登录着的账号，没登录是 null。
  // 这时成员只拿得到 hasKey（服务能不能用），下面各个平台的 Key 状态只有管理员有。
  hosted: boolean;
  user: { id: string; name: string; role: 'admin' | 'member' } | null;
  // MiniMax、AiHubMix 那两个 Key 的状态。
  minimax: KeyInfo;
  aihubmix: KeyInfo;
  // 查 AiHubMix 余额用的 Manage Key 的状态。
  aihubmixManage: KeyInfo;
  // 豆包语音那个 Key 的状态。
  speech: KeyInfo;
  // AutoDL.art 的令牌（原样放进 Authorization，不加 Bearer）。
  autodl: KeyInfo;
  // 查余额用的火山引擎 Access Key 的状态，keyHint 是 Access Key ID 的头尾。
  billing: KeyInfo;
}

// AutoDL.art 工作流目录里的一项。平台列表接口不带参数规则，规则由服务端补详情时一并带上（提交前服务端还会现取一次）。
export interface FlowSummary {
  uuid: string;
  name: string;
  description?: string;
  cover?: string | null;
  priceType?: string;
  media?: Kind[];
  // 出什么类型的文件。画布是按这个把工作流列给对应类型的节点。
  output?: Kind;
  // 计费配置，页面预估花费用。
  billing?: { price_type?: string; billing_config?: Record<string, any>; price?: number };
  fromCredits?: number | null;
  usage?: number;
  rules?: Record<string, import('../../shared/autodl.ts').InputRule>;
}
