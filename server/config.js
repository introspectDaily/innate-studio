// 服务的固定设置：地址、目录、各种上限。能用环境变量改的都在这里读。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPEECH_MODEL, AUDIO_MODEL } from '../shared/models.ts';
import { rhSiteOf } from '../shared/runninghub.ts';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const PORT = Number(process.env.PORT) || 5178;
// 默认只听本机。部署到服务器上时一般前面有反向代理，仍然听本机就行；要直接对外就设 HOST=0.0.0.0。
export const HOST = process.env.HOST || '127.0.0.1';

const trimSlash = (url) => url.replace(/\/+$/, '');
// 读一个非负数的环境变量；没给或写错了就用默认值。
const envNumber = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};
// RunningHub 的默认站点：Key 文件没写 site、或者用 RUNNINGHUB_API_KEY 临时给一个 Key 时用它。
const RH_DEFAULT_SITE = rhSiteOf(process.env.RUNNINGHUB_SITE) || 'cn';
// 火山方舟：视频（Seedance）、图片（Seedream）、文本（豆包）都走它。地址里已经带着版本号，所以接口路径前面没有 /v1。
export const ARK = { label: '火山方舟', baseUrl: trimSlash(process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3'), envKey: 'ARK_API_KEY', configKey: 'arkKey' };
// MiniMax 开放平台（国内站）：视频模型 MiniMax H3 走它。地址里不带版本号，接口路径自己带 /v2。
// 环境变量不叫 MINIMAX_API_KEY：那个名字常被国际站（api.minimax.io）的 Key 占着，国内站不认。
export const MINIMAX = { label: 'MiniMax', baseUrl: trimSlash(process.env.MINIMAX_BASE_URL || 'https://api.minimax.cn'), envKey: 'MINIMAX_CN_API_KEY', configKey: 'minimaxKey' };
// AiHubMix：聚合平台，图片模型 GPT Image 2.5 和 Nano Banana 2.1 走它（这两家的官方接口国内用不了）。接口路径自己带 /ai/v1。
export const AIHUBMIX = { label: 'AiHubMix', baseUrl: trimSlash(process.env.AIHUBMIX_BASE_URL || 'https://aihubmix.com'), envKey: 'AIHUBMIX_API_KEY', configKey: 'aihubmixKey' };
// AiHubMix 的 Manage Key：查它的账户余额用。普通的 API Key 查不了余额，要在它的控制台另外生成这个管理密钥。
export const AIHUBMIX_MANAGE = { label: 'AiHubMix Manage Key', baseUrl: AIHUBMIX.baseUrl, envKey: 'AIHUBMIX_MANAGE_KEY', configKey: 'aihubmixManageKey' };
// 火山引擎费用中心：查余额用，认的是账号的 Access Key（一对：ID 和 Secret）。
export const VOLC_BILLING = { baseUrl: trimSlash(process.env.VOLC_BILLING_BASE_URL || 'https://billing.volcengineapi.com'), envId: 'VOLC_ACCESS_KEY_ID', envSecret: 'VOLC_SECRET_ACCESS_KEY', configId: 'volcAccessKeyId', configSecret: 'volcSecretAccessKey' };
// 豆包语音：语音合成、音效、配乐用它。它是另一个产品，地址和 Key 都和方舟不是一套。
// seed-tts-2.0 是「豆包语音合成模型 2.0」，seed-audio-1.0 是「豆包音频生成模型 1.0」。
export const DOUBAO_SPEECH = { label: '豆包语音', baseUrl: trimSlash(process.env.DOUBAO_SPEECH_BASE_URL || 'https://openspeech.bytedance.com'), envKey: 'DOUBAO_SPEECH_API_KEY', configKey: 'doubaoSpeechKey', model: SPEECH_MODEL, audioModel: AUDIO_MODEL };
// AutoDL.art：ComfyUI 云工作流。工作流目录由平台在线给出，表单按每个工作流的 input_rules 生成。
// 认证方式和其他平台不同：令牌原样放进 Authorization，不加 Bearer。
// 环境变量优先认 AUTODL_ART_API_KEY（控制台叫「令牌」），也认早期脚本用的 AUTODL_TOKEN。
// 不带 www 的域名解析不到，接口在 www.autodl.art 上。
export const AUTODL = {
  label: 'AutoDL.art',
  baseUrl: trimSlash(process.env.AUTODL_BASE_URL || 'https://www.autodl.art'),
  envKey: 'AUTODL_ART_API_KEY',
  envKeys: ['AUTODL_ART_API_KEY', 'AUTODL_TOKEN'],
  configKey: 'autodlToken',
};

// RunningHub：ComfyUI 云工作流。和 AutoDL.art 不一样，不接「平台上的全部工作流」，
// 只接 shared/runninghub.ts 里登记过的（每个都要人工对着它的 API JSON 配槽位和参数）。
// Key 可以有好几个、按并发路由，所以不放在 config.json 的单值里：从一份 JSON 读，环境变量给路径。
// 单个 Key 也可以用 RUNNINGHUB_API_KEY 直接给（临时排查用）。
//
// 站点：RunningHub 国内站 runninghub.cn、海外站 runninghub.ai 是两个独立的站——账号、Key、工作流 id、
// 素材库都不通用。所以 Key 文件里每个 Key 都要写 site（ai / cn，枚举），请求按它打到对应域名；
// 没写 site 的按 RUNNINGHUB_SITE（默认 cn，照顾原来只配国内站的部署）。
export const RUNNINGHUB_SITES = {
  cn: { label: '国内站', host: 'https://www.runninghub.cn', short: 'runninghub.cn' },
  ai: { label: '海外站', host: 'https://www.runninghub.ai', short: 'runninghub.ai' },
};

export const RUNNINGHUB = {
  label: 'RunningHub',
  // 两个站点的域名表。Key 的 site 是这里的键。
  sites: RUNNINGHUB_SITES,
  // Key 文件里没写 site 时算哪个站（枚举 cn / ai）。
  site: RH_DEFAULT_SITE,
  // 所有 Key 走同一个自定义域名时用（调试、自建代理）；平时留空，按 Key 的 site 走。
  baseUrl: process.env.RUNNINGHUB_BASE_URL ? trimSlash(process.env.RUNNINGHUB_BASE_URL) : '',
  envKey: 'RUNNINGHUB_API_KEY',
  envKeys: 'RUNNINGHUB_KEYS',
  envKeysFile: 'RUNNINGHUB_KEYS_FILE',
  envSite: 'RUNNINGHUB_SITE',
  configKey: 'runninghubKeys',
  // 所有 Key 都在忙时，提交最多等这么久再报错（毫秒）。
  waitMs: Number(process.env.RUNNINGHUB_QUEUE_WAIT_MS ?? 15000),
  // 上传的素材地址在平台那边只留一天，缓存比这个短一点。
  uploadTtlMs: 20 * 60 * 60 * 1000,
  // 账户余额路由：/uc/openapi/accountStatus 会带回 remainCoins（RH 币）。挑 Key 时优先用余额多的，
  // 高余额的先被消耗，各账号的余额自然趋近。设 RUNNINGHUB_ROUTE_BY_COINS=0 回到纯轮转。
  routeByCoins: process.env.RUNNINGHUB_ROUTE_BY_COINS !== '0',
  // 后台多久问一次平台状态（毫秒）。0 = 不定时问，只在打开管理面板/提交任务时问。
  coinsRefreshMs: envNumber('RUNNINGHUB_COINS_REFRESH_MS', 60000),
  // 快照之外每派一单先虚拟扣掉多少币：只为把同一批并发请求摊到不同 Key，不是精确记账。
  // 平台余额的更新有延迟，这笔虚拟账只从上次快照时刻算起，拿到新快照就作废。
  routeSpend: envNumber('RUNNINGHUB_ROUTE_SPEND', 1),
};

// 环境变量原来叫 SEEDANCE_*（项目改名前），旧名字还认。
export const DATA_DIR = path.resolve(process.env.INNATE_DATA_DIR || process.env.SEEDANCE_DATA_DIR || path.join(ROOT, 'data'));
export const PUBLIC_DIR = path.join(ROOT, 'web', 'dist');
// 生成结果按类型分目录存；uploads 放的是从本机选来当输入的文件。
export const MEDIA_DIRS = { video: 'videos', image: 'images', audio: 'audio' };

export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_JSON_BYTES = 6 * 1024 * 1024;
export const POLL_INTERVAL_MS = 6000;
// 任务提交后超过这么久还没有结果，就停止自动查询。可以用环境变量 INNATE_PENDING_LIMIT_MS 改。
export const MAX_PENDING_MS = Number(process.env.INNATE_PENDING_LIMIT_MS || process.env.SEEDANCE_PENDING_LIMIT_MS) || 6 * 60 * 60 * 1000;
export const DOWNLOAD_RETRY_MS = 30000;
export const MAX_DOWNLOAD_ATTEMPTS = 6;
export const MAX_IMAGES = 4;
