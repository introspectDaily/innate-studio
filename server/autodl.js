// 调用 AutoDL.art 的 ComfyUI 工作流接口：列工作流、取单个工作流的定义、提交任务、查任务结果。
// 和别的平台不一样的两点：
// 1. 认证：令牌原样放进 Authorization，不加 Bearer（照平台文档和官方客户端）。
// 2. 返回都裹着一层 {code, data, msg}，code 是 Success / 0 / 200 才算成功，真正的内容在 data 里。
// 令牌只在这个文件里读、只放进请求头，不落盘、不写日志。

import { AUTODL } from './config.js';
import { HttpError } from './http.js';
import { autodlToken, isUsableKey, badKeyMessage } from './keys.js';
import { upstreamError } from './ark.js';

const OK_CODES = new Set([0, 200, '0', '200', 'Success', 'success']);
// 和官方客户端一样带上自己的标识；页面上的请求头在服务端统一发。
const USER_AGENT = 'innate-studio/1.0 (autodl-comfyui)';
const LIST_PATH = '/api/v1/comfyui/workflows';
const SUBMIT_PATH = '/api/v1/comfyui/comfyui_workflow';
const RESULT_PATH = '/api/v1/comfyui/comfyui_workflow/result';
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

const CONNECT_ERRORS = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
const MAX_CONNECT_ATTEMPTS = 3;

export function requireAutodlToken() {
  if (!autodlToken()) throw new HttpError(401, 'no_api_key', `请先在「管理」中配置 ${AUTODL.label} 的令牌。`);
}

// 一次请求：发出去、读回来、拆信封。成功后返回 data（平台有时 data 不是对象，那就原样返回整个返回体）。
// 平台失败时把它的 code/msg 翻成中文原因，原话放进 detail。
async function call(method, pathname, { json, timeoutMs = 60000 } = {}) {
  const token = autodlToken();
  if (!token) throw new HttpError(401, 'no_api_key', `请先在「管理」中配置 ${AUTODL.label} 的令牌。`);
  if (!isUsableKey(token)) throw new HttpError(400, 'invalid_key', badKeyMessage(AUTODL.label));

  const headers = { Authorization: token, Accept: 'application/json', 'User-Agent': USER_AGENT };
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }

  let res;
  for (let attempt = 1; ; attempt += 1) {
    try {
      res = await fetch(AUTODL.baseUrl + pathname, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
      break;
    } catch (err) {
      if (CONNECT_ERRORS.has(err?.cause?.code) && attempt < MAX_CONNECT_ATTEMPTS) continue;
      const reason = err?.name === 'TimeoutError' ? '请求超时' : err?.cause?.code || err?.message;
      throw new HttpError(502, 'upstream_unreachable', `连接 ${AUTODL.label} 失败：${reason}`);
    }
  }

  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text.slice(0, 2000) };
    }
  }

  if (!res.ok) {
    const message = payload?.msg || payload?.message || payload?.raw || `${AUTODL.label} 返回 ${res.status}`;
    throw upstreamError(AUTODL.label, res.status, `http_${res.status}`, String(message).slice(0, 2000), payload);
  }
  if (payload && !('code' in payload)) {
    // 有的接口直接返回数据，没有信封。
    return payload;
  }
  if (!OK_CODES.has(payload?.code)) {
    const message = payload?.msg || payload?.message || '未知错误';
    throw upstreamError(AUTODL.label, 502, String(payload?.code), String(message).slice(0, 2000), payload);
  }
  const data = payload?.data;
  return data !== null && typeof data === 'object' ? data : payload;
}

// 全部工作流。平台分页（page_index 从 1 开始），跟着 result_total 一页页取；最多 20 页，防止死循环。
export async function listWorkflows() {
  const workflows = [];
  let total = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const data = await call('POST', LIST_PATH, { json: { page_index: page, page_size: PAGE_SIZE } });
    total = Number(data?.result_total) || total;
    const batch = data?.workflows || data?.list || [];
    workflows.push(...batch);
    if (!batch.length || workflows.length >= total) break;
  }
  return { total, workflows };
}

// 单个工作流的完整定义（input_rules、计费配置、示例都在里面）。
export async function getWorkflow(id) {
  const data = await call('GET', `${LIST_PATH}/${encodeURIComponent(id)}`);
  if (!data?.uuid && !data?.input_rules) throw new HttpError(502, 'bad_upstream_response', `${AUTODL.label} 未返回工作流定义`);
  return data;
}

// 提交一个任务。请求体就是工作流自己的那组参数，不多不少。返回 task_id。
export async function submitWorkflow(id, inputs) {
  const data = await call('POST', `${SUBMIT_PATH}/${encodeURIComponent(id)}`, { json: inputs });
  const taskId = data?.task_id || data?.id;
  if (!taskId) throw new HttpError(502, 'bad_upstream_response', `${AUTODL.label} 未返回任务 ID`, data);
  return { taskId: String(taskId), data };
}

// 查一个任务。返回 { status, results, data }，status 统一成大写平台状态（QUEUED、RUNNING、SUCCESS、FAILED）。
export async function getResult(taskId) {
  const data = await call('GET', `${RESULT_PATH}/${encodeURIComponent(taskId)}`, { timeoutMs: 20000 });
  return { status: normalizeStatus(data?.status), results: Array.isArray(data?.results) ? data.results : [], data };
}

// 平台偶尔会把 SUCCESS 写成 COMPLETED / COMPLETE / DONE，把 FAILED 写成 FAILURE / FAIL / ERROR，统一成这两种。
export function normalizeStatus(status) {
  const text = String(status ?? '').trim().toUpperCase();
  if (text === 'COMPLETED' || text === 'COMPLETE' || text === 'DONE') return 'SUCCESS';
  if (text === 'FAILURE' || text === 'FAIL' || text === 'ERROR') return 'FAILED';
  return text;
}
