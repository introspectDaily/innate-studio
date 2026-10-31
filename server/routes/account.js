// 账号这一组接口：Key 的状态和存取、能用的模型、余额。

import { AIHUBMIX, AIHUBMIX_MANAGE, ARK, AUTODL, DOUBAO_SPEECH, MINIMAX, VOLC_BILLING } from '../config.js';
import { HttpError, readJsonBody, route } from '../http.js';
import { config, saveConfig } from '../store.js';
import { aihubmixKey, aihubmixManageKey, apiKey, billingKeys, keyState, isUsableKey, badKeyMessage, minimaxKey } from '../keys.js';
import { isHosted, userView } from '../auth.js';
import { callArk, forgetAccount } from '../ark.js';
import { minimaxBalance, queryAihubmixBalance, queryBalance } from '../billing.js';
import { VIDEO_TASKS_PATH } from '../tasks.js';
import { VIDEO_MODELS, IMAGE_MODELS, ARK_TEXT_MODELS, imageProvider, videoProvider } from '../../shared/models.ts';

const KEY_SERVICES = { speech: DOUBAO_SPEECH, minimax: MINIMAX, aihubmix: AIHUBMIX, 'aihubmix-manage': AIHUBMIX_MANAGE, autodl: AUTODL };

// hosted 是多人模式，这时 user 是登录着的账号（没登录是 null，页面据此显示登录框）。
// 多人模式下 Key 的状态只给管理员；成员只知道服务能不能用（hasKey），接了哪些平台、各自配没配都不给。
route('GET', /^\/api\/state$/, async ({ user }) => {
  const state = keyState();
  const account = { hosted: isHosted(), user: user ? userView(user) : null };
  if (isHosted() && user?.role !== 'admin') return { hasKey: Boolean(user) && state.hasKey, ...account };
  return { ...state, ...account };
}, 'open');

// service 是 speech 时存的是豆包语音的 Key，是 minimax、aihubmix 时存的是 MiniMax、AiHubMix 的 Key，是 billing 时存的是查余额用的那对 Access Key，其余是火山方舟的 Key。
route('PUT', /^\/api\/key$/, async ({ req }) => {
  const { apiKey: key, service, accessKeyId, secretAccessKey } = await readJsonBody(req);
  if (service === 'billing') {
    const id = String(accessKeyId || '').trim();
    const secret = String(secretAccessKey || '').trim();
    if (!id || !secret) throw new HttpError(400, 'invalid_key', '请填写 Access Key ID 与 Secret Access Key');
    if (!isUsableKey(id) || !isUsableKey(secret)) throw new HttpError(400, 'invalid_key', 'Access Key 格式不正确：包含中文、空格或其他非法字符。请从火山引擎控制台重新复制。');
    // 先查一次，查得到才存，免得存下一对用不了的。
    await queryBalance({ id, secret });
    config[VOLC_BILLING.configId] = id;
    config[VOLC_BILLING.configSecret] = secret;
    saveConfig();
    return keyState();
  }
  const platform = KEY_SERVICES[service] || ARK;
  const value = String(key || '').trim();
  if (!value) throw new HttpError(400, 'invalid_key', 'API Key 不能为空');
  if (!isUsableKey(value)) throw new HttpError(400, 'invalid_key', badKeyMessage(platform.label));
  // Manage Key 和火山的 Access Key 一样，先查一次余额，查得到才存。
  if (platform === AIHUBMIX_MANAGE) await queryAihubmixBalance(value);
  config[platform.configKey] = value;
  saveConfig();
  forgetAccount();
  return keyState();
}, 'admin');

route('DELETE', /^\/api\/key$/, async ({ query }) => {
  const service = query.get('service');
  if (service === 'billing') {
    delete config[VOLC_BILLING.configId];
    delete config[VOLC_BILLING.configSecret];
  } else {
    delete config[(KEY_SERVICES[service] || ARK).configKey];
    forgetAccount();
  }
  saveConfig();
  return keyState();
}, 'admin');

// 火山方舟没有能用 API Key 读的模型列表，型号登记在 shared/models.ts。
// 这里只查一次最近的任务列表，用来确认 Key 能用；列表里有哪些任务不关心。账号有没有开通某个模型，要到提交时才知道。
// models 是视频模型，其余是图片模型和润色用的文本模型。
route('GET', /^\/api\/models$/, async ({ user }) => {
  const imageRatios = {};
  const imageRefs = {};
  const imageSizes = {};
  // 分画质的模型能选哪几档、默认哪一档。
  const imageQualities = {};
  for (const [id, { refs, sizes, size, qualities, quality }] of Object.entries(IMAGE_MODELS)) {
    if (qualities) imageQualities[id] = { options: qualities, default: quality };
    imageRatios[id] = Object.keys(sizes[size]);
    imageRefs[id] = refs;
    // 这个模型能选的各档分辨率，默认的那一档排在 default 里。
    imageSizes[id] = { options: Object.keys(sizes), default: size };
  }
  // 语音、音效、配乐用的是豆包语音的 Key，没填的话生成时会提示去设置里填，不在这里列。
  // MiniMax 的视频模型、AiHubMix 的图片模型也列在里面；它们所在平台的 Key 没填，就放进 unavailable，菜单里标出来、不能选，
  // 免得提交了才知道。只说哪几个型号用不了，不说是哪个平台缺 Key：成员看不到 Key 的状态。
  const keyed = { ark: Boolean(apiKey()), minimax: Boolean(minimaxKey()), aihubmix: Boolean(aihubmixKey()) };
  const unavailable = [...Object.keys(VIDEO_MODELS).filter((id) => !keyed[videoProvider(id)]), ...Object.keys(IMAGE_MODELS).filter((id) => !keyed[imageProvider(id)])];
  const base = { models: Object.keys(VIDEO_MODELS), videoSpecs: VIDEO_MODELS, imageModels: Object.keys(IMAGE_MODELS), imageRatios, imageRefs, imageSizes, imageQualities, unavailable };
  try {
    await callArk('GET', `${VIDEO_TASKS_PATH}?page_num=1&page_size=1`, { timeoutMs: 20000 });
    return { ...base, polishModels: ARK_TEXT_MODELS, source: 'remote' };
  } catch (err) {
    // 平台那边的报错只给管理员看。
    const hidden = isHosted() && user?.role !== 'admin';
    return { ...base, polishModels: [], source: 'default', error: hidden ? '服务暂不可用，请联系管理员' : err.message, errorCode: err.code };
  }
});

// 火山方舟没有能用 API Key 查余额的接口，要用账号的 Access Key 到费用中心查；没配就查不了。
// 另外两个账户的余额配了才带上：minimax 是手动填的余额减去之后估算的花费，aihubmix 是用 Manage Key 查的（美元）。
// AiHubMix 查不到时不影响别的，只把原因放在它自己的 error 里。
route('GET', /^\/api\/credits$/, async () => {
  const keys = billingKeys();
  const result = keys ? { currency: 'CNY', ...(await queryBalance(keys)) } : { unavailable: true };
  const minimax = minimaxBalance();
  if (minimax) result.minimax = minimax;
  if (aihubmixManageKey()) result.aihubmix = await queryAihubmixBalance(aihubmixManageKey()).catch((err) => ({ currency: 'USD', error: err.message }));
  return result;
}, 'admin');

// 手动填 MiniMax 的余额：填的是此刻控制台上显示的数，之后的花费从这个时刻算起。unit 是 credits 时填的是积分，否则是元。
route('PUT', /^\/api\/balance\/minimax$/, async ({ req }) => {
  const { amount, unit } = await readJsonBody(req);
  const value = Number(amount);
  if (amount === '' || amount == null || !Number.isFinite(value) || value < 0) throw new HttpError(400, 'invalid_request', '请输入有效的余额');
  config.minimaxBalance = { amount: Math.round(value * 100) / 100, unit: unit === 'credits' ? 'credits' : 'cny', at: Date.now() };
  saveConfig();
  return minimaxBalance();
}, 'admin');

route('DELETE', /^\/api\/balance\/minimax$/, async () => {
  delete config.minimaxBalance;
  saveConfig();
  return null;
}, 'admin');
