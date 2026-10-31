// API Key：从环境变量或 config.json 里取，给页面看的只有头尾几个字符。

import { AIHUBMIX, AIHUBMIX_MANAGE, ARK, AUTODL, DOUBAO_SPEECH, MINIMAX, VOLC_BILLING } from './config.js';
import { config, saveConfig } from './store.js';

// Key 要放进 HTTP 请求头，只能由可见的 ASCII 字符组成。
export const isUsableKey = (value) => /^[\x21-\x7e]+$/.test(value);
export const badKeyMessage = (name) => `API Key 格式不正确：包含中文、空格或其他非法字符。请从 ${name} 控制台重新复制。`;

if (config[ARK.configKey] && !isUsableKey(config[ARK.configKey])) {
  delete config[ARK.configKey];
  saveConfig();
  console.log(`之前保存的 ${ARK.label} API Key 含有非法字符，已清除，请在「管理」里重新填写。`);
}

export const apiKey = () => process.env[ARK.envKey] || config[ARK.configKey] || '';
export const minimaxKey = () => process.env[MINIMAX.envKey] || config[MINIMAX.configKey] || '';
export const aihubmixKey = () => process.env[AIHUBMIX.envKey] || config[AIHUBMIX.configKey] || '';
export const aihubmixManageKey = () => process.env[AIHUBMIX_MANAGE.envKey] || config[AIHUBMIX_MANAGE.configKey] || '';
export const speechKey = () => process.env[DOUBAO_SPEECH.envKey] || config[DOUBAO_SPEECH.configKey] || '';
export const autodlToken = () => AUTODL.envKeys.reduce((found, key) => found || process.env[key] || '', '') || config[AUTODL.configKey] || '';
// 火山引擎账号的 Access Key，两项都有才算配好了。
export const billingKeys = () => {
  const id = process.env[VOLC_BILLING.envId] || config[VOLC_BILLING.configId] || '';
  const secret = process.env[VOLC_BILLING.envSecret] || config[VOLC_BILLING.configSecret] || '';
  return id && secret ? { id, secret } : null;
};

// 一个 Key 的状态：有没有、露出头尾几个字符给用户核对、是从环境变量来的还是存在文件里的。
function keyInfo({ envKey, envKeys, configKey, baseUrl }) {
  const fromEnv = (envKeys || [envKey]).some((name) => Boolean(process.env[name]));
  const key = (envKeys || [envKey]).reduce((found, name) => found || process.env[name] || '', '') || config[configKey] || '';
  return { hasKey: Boolean(key), keyHint: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : '', keySource: fromEnv ? 'env' : key ? 'file' : '', baseUrl };
}

// 最外面几项说的是火山方舟的 Key；minimax、aihubmix 是 MiniMax、AiHubMix 那两个 Key 的状态，speech 是豆包语音那个 Key 的状态，billing 是查余额用的 Access Key 的状态。
export function keyState() {
  const keys = billingKeys();
  return {
    ...keyInfo(ARK),
    minimax: keyInfo(MINIMAX),
    aihubmix: keyInfo(AIHUBMIX),
    // 查 AiHubMix 余额用的 Manage Key 的状态。
    aihubmixManage: keyInfo(AIHUBMIX_MANAGE),
    speech: keyInfo(DOUBAO_SPEECH),
    autodl: keyInfo(AUTODL),
    billing: { hasKey: Boolean(keys), keyHint: keys ? `${keys.id.slice(0, 6)}…${keys.id.slice(-4)}` : '', keySource: !keys ? '' : process.env[VOLC_BILLING.envId] ? 'env' : 'file', baseUrl: VOLC_BILLING.baseUrl },
  };
}
