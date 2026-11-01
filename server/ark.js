// 调用模型平台（火山方舟、MiniMax、AiHubMix）：发请求、把出错的原因说成人话、问文本模型要一段文字。

import { AIHUBMIX, ARK, MINIMAX } from './config.js';
import { HttpError } from './http.js';
import { aihubmixKey, apiKey, minimaxKey, isUsableKey, badKeyMessage } from './keys.js';
import { ARK_TEXT_MODELS } from '../shared/models.ts';

// 火山方舟的错误码（官方文档《错误码》）。
export const ERROR_HINTS = {
  AuthenticationError: 'API Key 无效或已被删除',
  AccountOverdueError: '火山引擎账号已欠费，请充值后重试',
  ModelNotOpen: '账号未开通该模型。Seedance 2.0、2.5 需账户余额大于 200 元，请在火山方舟控制台「开通管理」中开通',
  'InvalidEndpointOrModel.NotFound': '模型不存在，或账号未开通该模型',
  'InvalidEndpointOrModel.ModelIDAccessDisabled': '账号已禁用模型 ID 直接调用，请在火山方舟控制台开启',
  ModelAccountRpmRateLimitExceeded: '请求过于频繁，请稍后重试',
  ModelAccountIpmRateLimitExceeded: '请求过于频繁，请稍后重试',
  APIAccountRpmRateLimitExceeded: '请求过于频繁，请稍后重试',
  SetLimitExceeded: '已达到该模型的用量上限，请在火山方舟控制台调整',
  InputTextSensitiveContentDetected: '提示词未通过内容审核',
  InputImageSensitiveContentDetected: '参考图片未通过内容审核',
  'InputImageSensitiveContentDetected.PrivacyInformation': '参考图片包含真人人脸，Seedance 不支持',
  InputVideoSensitiveContentDetected: '参考视频未通过内容审核',
  'InputVideoSensitiveContentDetected.PrivacyInformation': '参考视频包含真人人脸，Seedance 不支持',
  InputAudioSensitiveContentDetected: '参考音频未通过内容审核',
  OutputVideoSensitiveContentDetected: '生成的视频未通过内容审核',
  OutputImageSensitiveContentDetected: '生成的图片未通过内容审核',
  // AiHubMix（文档《异步任务》里的错误码）
  async_not_enabled: '账号未开启「异步任务」，请在 AiHubMix 控制台开启',
  output_blocked: '生成的图片被模型方拦截，请修改提示词或参考图',
  image_not_generated: '模型未返回图片，请调整后重试',
  image_too_large: '参考图过大',
  // MiniMax
  authorized_error: 'API Key 无效。请确认是 MiniMax 国内站（platform.minimax.cn）创建的 Key',
  // RunningHub（平台侧工作流执行失败）
  vram_oom: '显存不够（OOM）：把视频时长或成片分辨率降下来，或者换成加强 48G 机器再跑',
};

// 平台给的原因多半是英文，还带着状态码，直接摆在卡片上看不懂。
// 所以拆成两半：message 是一句中文的原因，卡片和提示条只显示它；detail 是平台的原话，放进详情里，排查时再看。
export function explainUpstream(name, status, code, raw) {
  const known = ERROR_HINTS[code]
    || (status === 402 ? `${name} 账户余额不足，请充值后重试` : '')
    || (/audit|sensitive|moderation|censor/i.test(raw) ? '内容未通过审核，请修改提示词或参考素材后重试' : '');
  const fallback = status === 401 || status === 403 ? `${name} 的 API Key 无效，或没有调用权限`
    : status === 429 ? '请求过于频繁，请稍后重试'
    : status >= 500 ? `${name} 服务暂时异常，请稍后重试`
    : `${name} 拒绝了这次请求，请检查提示词和参数`;
  const tag = !code || /^http_/.test(code) ? `HTTP ${status}` : code;
  return { message: known || fallback, detail: `${name}（${tag}）：${raw}` };
}

export function upstreamError(name, status, code, raw, upstream) {
  const { message, detail } = explainUpstream(name, status, code, raw);
  const err = new HttpError(status, code, message, upstream);
  err.detail = detail;
  return err;
}

// 这几种错误都发生在连接建立之前，请求还没发出去，重试不会重复下单。
const CONNECT_ERRORS = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
const MAX_CONNECT_ATTEMPTS = 3;

export function requireKey() {
  if (!apiKey()) throw new HttpError(401, 'no_api_key', `请先在「管理」中配置 ${ARK.label} 的 API Key。`);
}

export const callArk = (method, pathname, options) => callPlatform(ARK, apiKey(), method, pathname, options);
export const callAihubmix = (method, pathname, options) => callPlatform(AIHUBMIX, aihubmixKey(), method, pathname, options);
export const callMinimax = (method, pathname, options) => callPlatform(MINIMAX, minimaxKey(), method, pathname, options);

async function callPlatform(platform, key, method, pathname, { json, timeoutMs = 60000 } = {}) {
  const name = platform.label;
  if (!key) throw new HttpError(401, 'no_api_key', `请先在「管理」中配置 ${name} 的 API Key。`);
  if (!isUsableKey(key)) throw new HttpError(400, 'invalid_key', badKeyMessage(name));

  const headers = { Authorization: `Bearer ${key}` };
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }

  let res;
  for (let attempt = 1; ; attempt += 1) {
    try {
      res = await fetch(platform.baseUrl + pathname, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
      break;
    } catch (err) {
      if (CONNECT_ERRORS.has(err.cause?.code) && attempt < MAX_CONNECT_ATTEMPTS) continue;
      const reason = err.name === 'TimeoutError' ? '请求超时' : err.cause?.code || err.message;
      throw new HttpError(502, 'upstream_unreachable', `连接 ${name} 失败：${reason}`);
    }
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 2000) };
    }
  }

  if (!res.ok) {
    const e = data?.error;
    const message = (typeof e === 'string' ? e : e?.message) || data?.message || `${name} 返回 ${res.status}`;
    // MiniMax 的错误没有 code，只有 type（authorized_error 这样）。
    const code = String((typeof e === 'object' && (e?.code || e?.type)) || data?.code || `http_${res.status}`);
    // 402 各家都是余额不足（MiniMax 实际返回过：insufficient balance (1008)），在 explainUpstream 里统一处理。
    throw upstreamError(name, res.status, code, message, data);
  }
  return { status: res.status, data };
}

export function listOf(data) {
  if (Array.isArray(data)) return data;
  for (const key of ['data', 'items', 'list', 'results']) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
}

// ---------- 文本模型 ----------
// 润色、技能扩写、画布上的文本节点都用豆包的文本模型，型号登记在 shared/models.ts。

// 登记着的文本模型不一定都调得通：有的被限流，有的账号没开通。
// 所以选中的模型不行就换下一个；刚失败过的模型十分钟内先不再试，免得每次都白等一回。
const textFailedAt = new Map();
const TEXT_RETRY_MS = 10 * 60 * 1000;

export const isTextModel = (model) => ARK_TEXT_MODELS.includes(model);

// 换了 Key，之前记下的哪个模型调不通就不作数了。
export const forgetAccount = () => textFailedAt.clear();

// 问文本模型要一段文字，返回文字和实际用的模型。
export async function askTextModel(model, messages, maxTokens) {
  const others = ARK_TEXT_MODELS.filter((id) => id !== model);
  const fresh = (id) => Date.now() - (textFailedAt.get(id) || 0) > TEXT_RETRY_MS;
  // 先试没失败过的；全都刚失败过，就还是从选中的那个试起。
  const candidates = [model, ...others].filter(fresh);
  let lastError;
  for (const candidate of candidates.length ? candidates : [model, ...others]) {
    try {
      // 豆包的文本模型默认会先深度思考再回答，这里用不上，还会把限定的输出长度占掉，所以关掉。
      const { data } = await callArk('POST', '/chat/completions', { json: { model: candidate, max_tokens: maxTokens, messages, thinking: { type: 'disabled' } }, timeoutMs: 90000 });
      const text = String(data?.choices?.[0]?.message?.content || '').trim();
      if (!text) throw new HttpError(502, 'bad_upstream_response', '模型未返回内容', data);
      textFailedAt.delete(candidate);
      return { text, model: candidate };
    } catch (err) {
      // Key 有问题或者连不上平台，换模型也没用。
      if (!(err instanceof HttpError) || err.status === 401 || err.code === 'upstream_unreachable') throw err;
      textFailedAt.set(candidate, Date.now());
      lastError = err;
    }
  }
  throw lastError;
}
