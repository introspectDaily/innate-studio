#!/usr/bin/env node
// Innate Studio 的 Agent CLI：用一行命令替代手写 curl，把生成 / 上传 / 画布摆放都包好。
// 设计目标：比 MCP 灵活（可组合、可管道、可脚本），比裸 curl 省心（自动带鉴权、自动等结果、返回本机绝对路径）。
//
// 鉴权：isk_… 令牌。用一次 `innate config set --key isk_…` 记住，之后不用每次带。
// 服务地址：默认 http://127.0.0.1:5178；服务换端口时会自动发现，不用手动改。
// 输出：默认人类可读；任意命令加 --json 打印服务器原始 JSON，方便 jq 提取。
//
// 安装成全局命令（只需一次，装完就不用 node/pnpm 了）：
//   node <项目>/cli/install.mjs
//
// 例子：
//   innate models
//   innate generate image --model seedream-5.0-pro --prompt "一只猫" --ratio 1:1 --wait --json
//   innate upload ./ref.png
//   innate canvas grid --name 分镜 --ids r1,r2,r3,r4,r5,r6,r7,r8,r9 --cols 3 --gap 360 --wait
//   innate wait <记录id> --timeout 60
//   innate doctor          连不上服务时先跑这个自查

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 装在 PATH 上后是软链，Node 会解析到真实路径，所以这里拿到的仍然是项目根目录。
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_URL = 'http://127.0.0.1:5178';

// ---------- 配置 ----------
// 优先级：命令行 --api-url/--api-key > 环境变量 > ~/.innate/config.json > 自动发现 > 默认值。
function configPath() {
  return process.env.INNATE_CLI_CONFIG || path.join(os.homedir(), '.innate', 'config.json');
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')) || {}; } catch { return {}; }
}

const str = (v) => (typeof v === 'string' && v ? v : null);
const maskKey = (k) => (k ? `${k.slice(0, 8)}…${k.slice(-4)}（共 ${k.length} 位）` : null);

// 服务启动时会把监听地址写进数据目录的 server.json，端口改了也能找到。
function discoverUrl() {
  const dirs = [process.env.INNATE_DATA_DIR, path.join(ROOT, 'data'), path.join(os.homedir(), '.innate', 'data')];
  for (const dir of dirs) {
    if (!dir) continue;
    let info;
    try { info = JSON.parse(fs.readFileSync(path.join(dir, 'server.json'), 'utf8')); } catch { continue; }
    if (!info || !info.url) continue;
    // 记了 pid 就顺手确认进程还活着，避免指到一个早就退出的旧服务。
    if (info.pid && !pidAlive(info.pid)) continue;
    return info.url;
  }
  return null;
}

function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

let API_URL = DEFAULT_URL;
let API_KEY = '';

function applyConfig(flags = {}) {
  const file = readConfig();
  const url = str(flags['api-url']) || str(process.env.INNATE_API_URL) || str(file.apiUrl) || discoverUrl() || DEFAULT_URL;
  const key = str(flags['api-key']) || str(process.env.INNATE_API_KEY) || str(file.apiKey) || '';
  API_URL = String(url).replace(/\/+$/, '');
  API_KEY = String(key);
}

applyConfig();

// ---------- 参数解析 ----------
// 支持 --flag value / --flag=value / --flag（布尔）/ 重复出现同一 flag 自动变数组。
function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { positionals.push(a); continue; }
    const eq = a.indexOf('=');
    let key, val;
    if (eq !== -1) { key = a.slice(2, eq); val = a.slice(eq + 1); }
    else {
      key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { val = next; i += 1; }
      else val = true;
    }
    if (Object.prototype.hasOwnProperty.call(flags, key)) {
      const cur = flags[key];
      flags[key] = Array.isArray(cur) ? [...cur, val] : [cur, val];
    } else flags[key] = val;
  }
  return { positionals, flags };
}

const toArr = (v) => (Array.isArray(v) ? v : [v]);
const has = (flags, k) => Object.prototype.hasOwnProperty.call(flags, k);

const EXT_CT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};
const contentTypeFor = (file) => EXT_CT[path.extname(file).toLowerCase()] || null;

// ---------- 底层请求 ----------
async function api(method, p, { body, binary, headers } = {}) {
  const url = API_URL + p;
  const h = { ...(headers || {}) };
  if (API_KEY) h.Authorization = `Bearer ${API_KEY}`;
  const init = { method, headers: h };
  if (binary) {
    init.body = body; // 调用方已设置 Content-Type
  } else if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await globalThis.fetch(url, init);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = (data && data.error) || {};
    const msg = err.message || res.statusText || `HTTP ${res.status}`;
    throw new Error(`${msg}${err.code ? ` (${err.code})` : ''}`);
  }
  return data;
}

// 服务端长轮询：阻塞到完成/失败或超时再返回。Agent 不用自己 sleep。
async function awaitJob(id, timeout) {
  const secs = Math.max(1, Math.min(60, Number(timeout) || 60));
  return api('POST', `/api/history/${id}/refresh?wait=${secs}`);
}

// ---------- 各命令 ----------
async function cmdModels(args) {
  const data = await api('GET', '/api/models');
  if (has(args.flags, 'json')) return { _cmd: 'models', data };
  const kind = args.flags.kind;
  const pick = (obj) => (kind ? { [kind]: obj[kind] } : obj);
  return {
    _cmd: 'models',
    videoModels: pick(data).models || data.models,
    imageModels: pick(data).imageModels || data.imageModels,
    unavailable: data.unavailable || [],
    source: data.source,
  };
}

async function cmdGenerate(args) {
  const type = args.positionals[0];
  if (!type) throw new Error('用法: innate generate <image|video|speech|sfx|music> [选项]');
  const wait = has(args.flags, 'wait');
  const timeout = args.flags.timeout;
  let endpoint;
  let payload = {};
  switch (type) {
    case 'image':
      endpoint = '/api/images';
      payload = {
        model: args.flags.model, prompt: args.flags.prompt, aspect_ratio: args.flags.ratio,
        resolution: args.flags.resolution, quality: args.flags.quality,
        n: args.flags.count ? Number(args.flags.count) : 1,
      };
      // 图片参考图：input_references = [{ image_url: { url } }]
      if (args.flags.ref) payload.input_references = toArr(args.flags.ref).map((u) => ({ image_url: { url: u } }));
      break;
    case 'video':
      endpoint = '/api/videos';
      payload = {
        model: args.flags.model, prompt: args.flags.prompt, aspect_ratio: args.flags.ratio,
        duration: args.flags.duration ? Number(args.flags.duration) : undefined,
        seed: args.flags.seed !== undefined ? Number(args.flags.seed) : undefined,
      };
      // 首/尾帧：frame_images = [{ image_url, frame_type }]
      if (args.flags['first-frame']) payload.frame_images = [{ image_url: args.flags['first-frame'], frame_type: 'first_frame' }];
      if (args.flags['last-frame']) (payload.frame_images = payload.frame_images || []).push({ image_url: args.flags['last-frame'], frame_type: 'last_frame' });
      // 视频参考：input_references = [{ image_url }]（注意和图片不同，这里 image_url 是字符串）
      if (args.flags.ref) payload.input_references = toArr(args.flags.ref).map((u) => ({ image_url: u }));
      break;
    case 'speech':
      endpoint = '/api/audio/speech';
      payload = { text: args.flags.text, voiceId: args.flags['voice-id'] };
      break;
    case 'sfx':
      endpoint = '/api/audio/sfx';
      payload = { text: args.flags.text, duration: args.flags.duration ? Number(args.flags.duration) : undefined };
      break;
    case 'music':
      endpoint = '/api/audio/music';
      payload = { text: args.flags.text, duration: args.flags.duration ? Number(args.flags.duration) : undefined };
      break;
    default:
      throw new Error(`未知类型: ${type}（可选 image|video|speech|sfx|music）`);
  }
  // 高级用法：--data '{...}' 直接合并原始字段，绕过上面所有 flag 的限制。
  if (args.flags.data) {
    try { Object.assign(payload, JSON.parse(args.flags.data)); }
    catch { throw new Error('--data 不是合法 JSON'); }
  }
  payload = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined));
  if (!payload.model && type !== 'speech' && type !== 'sfx' && type !== 'music') throw new Error('缺少 --model');
  if (!payload.prompt && (type === 'image' || type === 'video')) throw new Error('缺少 --prompt');

  const result = await api('POST', endpoint, { body: payload });
  const items = Array.isArray(result.items) ? result.items : [result];
  if (wait) {
    for (const it of items) Object.assign(it, await awaitJob(it.id, timeout));
  }
  return { _cmd: 'generate', type, items };
}

async function cmdWait(args) {
  const id = args.positionals[0];
  if (!id) throw new Error('用法: innate wait <记录id> [--timeout 60]');
  const data = await awaitJob(id, args.flags.timeout);
  return { _cmd: 'wait', item: data };
}

async function cmdStatus(args) {
  const id = args.positionals[0];
  if (!id) throw new Error('用法: innate status <记录id>');
  const data = await api('GET', `/api/history/${id}`);
  return { _cmd: 'status', item: data };
}

async function cmdHistory(args) {
  const data = await api('GET', '/api/history');
  const items = data.items || [];
  const limit = args.flags.limit ? Number(args.flags.limit) : items.length;
  return { _cmd: 'history', credits: data.credits, items: items.slice(0, limit) };
}

async function cmdUpload(args) {
  const file = args.positionals[0];
  if (!file || !fs.existsSync(file)) throw new Error('用法: innate upload <本地文件路径>');
  const ct = contentTypeFor(file);
  if (!ct) throw new Error(`不支持的文件类型: ${path.extname(file)}（支持 png/jpg/webp/mp4/mov/webm/mp3/wav）`);
  const buf = fs.readFileSync(file);
  const data = await api('POST', '/api/uploads', { binary: true, body: buf, headers: { 'Content-Type': ct } });
  return { _cmd: 'upload', url: data.url, size: data.size };
}

async function cmdCanvas(args) {
  const sub = args.positionals[0];
  switch (sub) {
    case 'create': {
      const name = args.flags.name || '画布';
      const canvas = await api('POST', '/api/canvases', { body: { name } });
      return { _cmd: 'canvas', action: 'create', id: canvas.id, name: canvas.name };
    }
    case 'get': {
      if (!args.positionals[1]) throw new Error('用法: innate canvas get <画布id>');
      return { _cmd: 'canvas', action: 'get', ...(await api('GET', `/api/canvases/${args.positionals[1]}`)) };
    }
    case 'list': {
      const data = await api('GET', '/api/canvases');
      return { _cmd: 'canvas', action: 'list', items: data.items || [] };
    }
    case 'update': {
      const id = args.positionals[1];
      if (!id) throw new Error('用法: innate canvas update <画布id> [--nodes <文件.json>]');
      const body = args.flags.nodes ? JSON.parse(fs.readFileSync(args.flags.nodes, 'utf8')) : {};
      const canvas = await api('PUT', `/api/canvases/${id}`, { body });
      // 服务端返回的 canvasMeta 不带节点数，用这次写进去的自己算。
      const count = Array.isArray(body.nodes) ? body.nodes.length : undefined;
      return { _cmd: 'canvas', action: 'update', id: canvas.id, name: canvas.name, count };
    }
    case 'grid':
      return cmdCanvasGrid(args);
    default:
      throw new Error('用法: innate canvas <create|get|list|update|grid> ...');
  }
}

// 一条命令把「建画布 + 按网格算坐标 + 摆节点 + 连线」做完：直接回应“精确摆放”的诉求。
async function cmdCanvasGrid(args) {
  const ids = String(args.flags.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) throw new Error('需要 --ids a,b,c（生成记录的 id，逗号分隔）');
  const cols = Number(args.flags.cols) || 3;
  const gap = Number(args.flags.gap) || 360;
  const type = args.flags.type || 'image';
  const startX = Number(args.flags['start-x']) || 0;
  const startY = Number(args.flags['start-y']) || 0;
  const name = args.flags.name || '网格画布';

  const created = await api('POST', '/api/canvases', { body: { name } });
  const id = created.id;
  const nodes = ids.map((rid, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return {
      id: `n-${i + 1}`, type, position: { x: startX + col * gap, y: startY + row * gap },
      data: { no: i + 1, recordId: rid },
    };
  });
  const edges = has(args.flags, 'chain')
    ? nodes.slice(1).map((n, i) => ({ id: `e-${i + 1}`, source: nodes[i].id, target: n.id }))
    : [];
  const updated = await api('PUT', `/api/canvases/${id}`, { body: { nodes, edges } });
  return { _cmd: 'canvas', action: 'grid', id, name: updated.name, nodes: nodes.length, edges: edges.length, cols, gap };
}

async function cmdVoices() {
  const data = await api('GET', '/api/voices');
  return { _cmd: 'voices', items: data.items || [] };
}

async function cmdCost() {
  const data = await api('GET', '/api/history');
  return { _cmd: 'cost', credits: data.credits, records: (data.items || []).length };
}

async function cmdState() {
  const data = await api('GET', '/api/state');
  return { _cmd: 'state', hosted: data.hosted, hasKey: data.hasKey, user: data.user };
}

// ---------- 人类可读输出 ----------
function printHuman(out) {
  switch (out._cmd) {
    case 'models':
      console.log(`视频模型: ${(out.videoModels || []).join(', ') || '（无）'}`);
      console.log(`图片模型: ${(out.imageModels || []).join(', ') || '（无）'}`);
      console.log(`不可用(缺Key): ${(out.unavailable || []).join(', ') || '无'}`);
      if (out.source) console.log(`来源: ${out.source}`);
      break;
    case 'generate':
    case 'wait':
    case 'status': {
      const items = out.items || (out.item ? [out.item] : []);
      for (const it of items) {
        const icon = it.status === 'completed' ? '✓' : it.status === 'failed' ? '✗' : '…';
        console.log(`${icon} ${it.kind || out.type || 'task'}  ${it.id}  ${it.status || '?'}`);
        if (it.localPath) console.log(`   文件: ${it.localPath}`);
        else if (it.mediaUrl) console.log(`   链接: ${it.mediaUrl}`);
        if (it.credits != null) console.log(`   积分: ${it.credits}`);
        if (it.error) console.log(`   失败: ${it.error.message || it.error}${it.error.code ? ` (${it.error.code})` : ''}`);
      }
      break;
    }
    case 'history':
      if (out.credits != null) console.log(`积分余额: ${out.credits}`);
      console.log(`记录数: ${out.items.length}`);
      for (const it of out.items.slice(0, 10)) console.log(`  ${it.status || '?'}  ${it.id}  ${it.model || ''}  ${it.localPath || ''}`);
      break;
    case 'upload':
      console.log(`已上传: ${out.url}  (${out.size} 字节)`);
      break;
    case 'canvas':
      if (out.action === 'grid') {
        console.log(`画布已创建: ${out.id}  (${out.name})`);
        console.log(`  节点: ${out.nodes}  连线: ${out.edges}  布局: ${out.cols}列 × 间距${out.gap}`);
      } else if (out.action === 'list') {
        for (const c of out.items) console.log(`  ${c.id}  ${c.name}`);
      } else if (out.action === 'update') {
        console.log(`画布已更新: ${out.id}  (${out.name})${out.count != null ? `  节点: ${out.count}` : ''}`);
      } else {
        console.log(`画布: ${out.id}  (${out.name})`);
      }
      break;
    case 'voices':
      console.log(`音色: ${(out.items || []).map((v) => v.id || v.name).join(', ')}`);
      break;
    case 'cost':
      console.log(`积分余额: ${out.credits != null ? out.credits : '（本机模式不记积分）'}`);
      console.log(`记录数: ${out.records}`);
      break;
    case 'state':
      console.log(`模式: ${out.hosted ? '多人' : '本机'}`);
      console.log(`平台Key已配置: ${out.hasKey ? '是' : '否'}`);
      if (out.user) console.log(`当前用户: ${out.user.name} (${out.user.role})`);
      break;
    case 'config':
      if (out.action === 'path') console.log(out.path);
      else if (out.action === 'clear') console.log(`已清空: ${out.path}`);
      else if (out.action === 'set') console.log(`已写入: ${out.path}\n服务地址: ${out.apiUrl || '（未设置，用自动发现/默认）'}\n令牌: ${out.apiKey || '（未设置）'}`);
      else {
        console.log(`配置文件: ${out.path}`);
        console.log(`服务地址: ${out.apiUrl || '（未设置）'}`);
        console.log(`令牌: ${out.apiKey || '（未设置）'}`);
        if (out.fromEnvUrl) console.log(`环境变量覆盖了地址: ${out.fromEnvUrl}`);
        if (out.fromEnvKey) console.log(`环境变量覆盖了令牌: ${out.fromEnvKey}`);
        if (!out.apiUrl && out.discoveredUrl) console.log(`自动发现的服务地址: ${out.discoveredUrl}`);
      }
      break;
    case 'doctor':
      console.log(`服务地址: ${out.apiUrl}`);
      console.log(`令牌: ${out.apiKey || '（本机模式可不设）'}`);
      console.log(`连通性: ${out.reachable ? '✓ 已连上' : `✗ ${out.error || '连不上'}`}`);
      if (out.reachable) {
        console.log(`模式: ${out.hosted ? '多人' : '本机'}`);
        if (out.user) console.log(`身份: ${out.user}`);
      }
      for (const h of out.hints || []) console.log(`→ ${h}`);
      break;
    default:
      console.log(JSON.stringify(out, null, 2));
  }
}

// ---------- config / doctor ----------
async function cmdConfig({ positionals, flags }) {
  const action = positionals[0] || 'show';
  const p = configPath();
  if (action === 'path') return { _cmd: 'config', action: 'path', path: p };
  if (action === 'clear') {
    try { fs.unlinkSync(p); } catch { /* 本来就没有 */ }
    return { _cmd: 'config', action: 'clear', path: p };
  }
  if (action === 'set') {
    const next = readConfig();
    const url = str(flags.url);
    const key = str(flags.key);
    if (url) next.apiUrl = url.replace(/\/+$/, '');
    if (key) next.apiKey = key;
    if (!url && !key) throw new Error('要设置点什么：--url <地址> 或 --key <isk_…>');
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    return { _cmd: 'config', action: 'set', path: p, apiUrl: next.apiUrl || null, apiKey: maskKey(next.apiKey) };
  }
  const cur = readConfig();
  return {
    _cmd: 'config',
    action: 'show',
    path: p,
    apiUrl: cur.apiUrl || null,
    apiKey: maskKey(cur.apiKey),
    fromEnvUrl: str(process.env.INNATE_API_URL),
    fromEnvKey: maskKey(str(process.env.INNATE_API_KEY)),
    discoveredUrl: discoverUrl(),
  };
}

// 连不上、鉴权不对时给一句能照着做的提示，别让 AI 瞎猜。
async function cmdDoctor() {
  const out = {
    _cmd: 'doctor',
    apiUrl: API_URL,
    apiKey: maskKey(API_KEY) || null,
    configPath: configPath(),
    reachable: false,
  };
  try {
    const state = await api('GET', '/api/state');
    out.reachable = true;
    out.user = state?.user ? `${state.user.name}（${state.user.role}）` : null;
    out.hosted = Boolean(state?.user);
  } catch (err) {
    out.error = err.message;
  }
  const hints = [];
  if (!out.reachable) {
    hints.push(`连不上 ${API_URL}，先确认服务在跑（项目里 node server.js，或 pnpm start）。`);
    const found = discoverUrl();
    if (found && found !== API_URL) hints.push(`发现另一个可能的服务地址：${found}，可以 innate config set --url ${found}`);
  } else if (!out.hosted && !API_KEY) {
    hints.push('本机模式，不需要令牌。');
  } else if (out.hosted && !out.user) {
    hints.push('多人模式但没认出身份：用 innate config set --key isk_… 绑定一个令牌。');
  }
  out.hints = hints;
  return out;
}

// ---------- 入口 ----------
const COMMANDS = {
  models: cmdModels, generate: cmdGenerate, wait: cmdWait, status: cmdStatus,
  history: cmdHistory, upload: cmdUpload, canvas: cmdCanvas, voices: cmdVoices,
  cost: cmdCost, state: cmdState, config: cmdConfig, doctor: cmdDoctor,
};

const USAGE = `Innate Studio Agent CLI

用法: innate <命令> [选项]
全局: --api-url <url> 覆盖 INNATE_API_URL
      --api-key <key> 覆盖 INNATE_API_KEY
      --json          打印服务器原始 JSON

命令:
  models [--kind image|video|audio]      查看可用模型
  generate <image|video|speech|sfx|music> [--model --prompt --ratio --wait --timeout 60 --ref <url> --data '{...}']
  wait <记录id> [--timeout 60]           阻塞等结果（服务端长轮询）
  status <记录id>                        查一次状态
  history [--limit N]                    生成记录与余额
  upload <本地文件>                      上传参考素材，返回 /media/uploads/... 地址
  canvas create --name <名>
  canvas get <id> | list
  canvas update <id> [--nodes <文件.json>]
  canvas grid --ids a,b,c [--cols 3] [--gap 360] [--type image] [--chain]   建画布并按网格精确摆放
  voices                                 可用音色
  cost                                   积分与记录数
  state                                  服务状态
  config show|set --url <地址> --key <isk_…>|clear   记住服务地址与令牌（写 ~/.innate/config.json，权限 600）
  doctor                                 自查：服务地址、连通性、身份、下一步建议

安装成全局命令（只需一次）：node <项目>/cli/install.mjs
环境变量（优先级高于配置文件）: INNATE_API_KEY  INNATE_API_URL`;

export async function main(argv) {
  const args = parseArgs(argv);
  // 全局覆盖：--api-url / --api-key 要在跑命令前生效。
  applyConfig(args.flags);
  const json = has(args.flags, 'json');
  const cmd = args.positionals[0];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    return 0;
  }
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(`未知命令: ${cmd}\n${USAGE}`);
    return 2;
  }
  // 把最外层的命令名去掉，子命令（generate 的类型、canvas 的子动作）拿到的才是真正的参数。
  const out = await fn({ positionals: args.positionals.slice(1), flags: args.flags });
  if (json) console.log(JSON.stringify(out, null, 2));
  else printHuman(out);
  return 0;
}

// 作为命令直接运行时才执行；被测试 import 时不自动跑。
// 装在 PATH 上后是通过软链调用的：process.argv[1] 是软链路径，import.meta.url 是真实路径，
// 直接比对会不相等，所以先比真实路径，再退一步看调用时的命令名是不是 innate。
function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try { if (import.meta.url === pathToFileURL(fs.realpathSync(entry)).href) return true; } catch { /* 路径取不到就继续比 */ }
  return import.meta.url === pathToFileURL(entry).href || path.basename(entry).replace(/\.(mjs|js|cmd)$/, '') === 'innate';
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  });
}
