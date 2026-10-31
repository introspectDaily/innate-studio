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
//   innate generate image --model doubao-seedream-5-0-pro-260628 --prompt "一只猫" --ratio 1:1 --wait --json
//   innate upload ./ref.png
//   innate canvas grid --name 分镜 --ids r1,r2,r3,r4,r5,r6,r7,r8,r9 --cols 3 --gap 360
//   innate canvas node set <画布id> <节点id> --prompt "改成雪夜"   只改这一个节点的提示词
//   innate canvas node set <画布id> <节点id> --prompt --edit '[{"ori_text":"雨夜","new_text":"雪夜"}]'
//                                                          在现有提示词上按原文替换（可以一次改多处）
//   innate canvas node list <画布id>                          先看画布上有哪些节点
//   innate canvas node get <画布id> <节点id> inputs            这个节点吃了哪些素材，给本机路径
//   innate media /media/uploads/up_xxx.png                    素材在哪：本机路径或下载下来
//   innate workflow save --canvas <画布id> --name 分镜模板    把整张画布存成可复用的工作流
//   innate flow list                                          平台工作流（AutoDL.art）目录
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

// 读一个 JSON 文件（节点、连线、工作流参数），读不到就报一句能照着做的话。
function readJsonFile(file, what) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`读不了 ${what} 文件 ${file}：${err.message}`);
  }
}

// 会冲突的 id（节点、连线）用随机短 id，避免和画布上已有的撞上。
function freshId(prefix) {
  const rand = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID().slice(0, 8) : Math.random().toString(16).slice(2, 10);
  return `${prefix}-${rand}`;
}

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
    // 只读令牌是最容易踩的一堵墙：看着像"生成失败"，其实只是手上这把 key 没写权限，直接把出路写出来。
    const hint = err.code === 'read_only_key'
      ? '\n手上这个令牌是 scope=read（只能看，不能生成/上传）。换一把 write 令牌：pnpm user token add --scope write，再 innate config set --key isk_…'
      : '';
    throw new Error(`${msg}${err.code ? ` (${err.code})` : ''}${hint}`);
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
  // --kind 只留一类：video 走 models，image 走 imageModels，audio 没有"模型"这回事（音色走 voices）。
  const kind = str(args.flags.kind);
  const wantVideo = !kind || kind === 'video';
  const wantImage = !kind || kind === 'image';
  // 不可用名单是跨类型的；--kind 只看一类时，别把另一类的缺 Key 型号也报出来。
  const shown = new Set([...(wantVideo ? data.models || [] : []), ...(wantImage ? data.imageModels || [] : [])]);
  const unavailable = (data.unavailable || []).filter((id) => !kind || shown.has(id));
  // --json 给服务器原始字段（--kind 时也只留这一类，免得调用方自己筛）。
  if (has(args.flags, 'json')) {
    if (!kind) return { _cmd: 'models', data };
    const keys = { video: ['models', 'videoSpecs'], image: ['imageModels', 'imageRatios', 'imageSizes', 'imageQualities', 'imageRefs'] }[kind] || [];
    return { _cmd: 'models', kind, data: { ...Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])), unavailable } };
  }
  return {
    _cmd: 'models',
    kind: kind || null,
    videoModels: wantVideo ? data.models || [] : undefined,
    videoSpecs: wantVideo ? data.videoSpecs || {} : undefined,
    imageModels: wantImage ? data.imageModels || [] : undefined,
    imageSpecs: wantImage
      ? { ratios: data.imageRatios || {}, sizes: data.imageSizes || {}, qualities: data.imageQualities || {}, refs: data.imageRefs || {} }
      : undefined,
    unavailable,
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
  if (!payload.model && (type === 'image' || type === 'video')) throw new Error('缺少 --model（先 innate models 看可用模型）');
  if (!payload.prompt && type === 'image') throw new Error('缺少 --prompt');
  // 视频允许只给素材不写提示词（图生视频）；两样都没有才算漏。
  if (type === 'video' && !payload.prompt && !payload.frame_images?.length && !payload.input_references?.length) {
    throw new Error('视频要么给 --prompt，要么给 --first-frame / --last-frame / --ref');
  }
  if (type === 'speech' && !payload.voiceId) throw new Error('语音要 --voice-id（可用音色：innate voices）');

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
  // history delete <记录id>：删掉一条记录（磁盘上的结果文件一起删）。试错留下的记录用它清掉。
  if (args.positionals[0] === 'delete') {
    const id = args.positionals[1];
    if (!id) throw new Error('用法: innate history delete <记录id>');
    await api('DELETE', `/api/history/${id}`);
    return { _cmd: 'history', action: 'delete', id };
  }
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

// ---------- 取文件：记录 id 或 /media/... → 本机路径 ----------
// 本机有文件就把路径直接给出来（大文件不复制），没有才下载到目录里。看了才知道怎么改提示词，靠的就是这个。
function humanSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

async function downloadTo(mediaUrl, dest) {
  const res = await globalThis.fetch(API_URL + mediaUrl, { headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {} });
  if (!res.ok) throw new Error(`取文件失败：HTTP ${res.status}（${mediaUrl}）`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return fs.statSync(dest).size;
}

async function cmdMedia(args) {
  const target = args.positionals[0];
  if (!target || target === true) throw new Error('用法: innate media <记录id|/media/…|https://…> [--out 目录]');
  const out = str(args.flags.out);
  // 记录 id、本机地址都问服务端「文件在哪」；公网链接本机肯定没有，直接下。
  const info = /^https?:\/\//i.test(target)
    ? { url: target, localPath: null, exists: false, remote: true }
    : await api('GET', /^\//.test(target) ? `/api/media?url=${encodeURIComponent(target)}` : `/api/media?record=${encodeURIComponent(target)}`);
  const source = String(info.mediaUrl || info.url || info.localPath || '');
  const name = info.name || path.basename(source.split('?')[0]) || `innate-${Date.now()}`;
  // 本机已经有、又没指定目录：直接给路径，不复制一份几十 MB 的。
  if (info.localPath && !out) return { _cmd: 'media', target, ...info, path: info.localPath, copied: false };
  const dir = out || path.join(os.tmpdir(), 'innate-media');
  const dest = path.join(dir, name);
  const mediaUrl = info.mediaUrl || (/^\//.test(String(info.url || '')) ? info.url : null);
  // localPath 是服务端算出来的；CLI 和服务不在同一台机器时那个路径不存在，这时改走下载。
  if (info.localPath) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(info.localPath, dest);
      return { _cmd: 'media', target, ...info, path: dest, copied: true, bytes: fs.statSync(dest).size };
    } catch (err) {
      if (!mediaUrl) throw new Error(`复制不了 ${info.localPath}：${err.message}`);
    }
  }
  if (!mediaUrl) throw new Error(`拿不到这个文件的路径：${info.note || target}`);
  if (info.exists === false) throw new Error(`文件不在了：${mediaUrl}（记录或素材可能已被删掉）`);
  await downloadTo(mediaUrl, dest);
  return { _cmd: 'media', target, ...info, path: dest, copied: false, bytes: fs.statSync(dest).size };
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
      let body = {};
      if (args.flags.nodes) {
        const parsed = readJsonFile(args.flags.nodes, 'nodes');
        // 文件可以是节点数组（文档里就是这么写的），也可以是 {nodes, edges} 整个请求体。
        // 数组以前会被当成请求体原样发出去，服务端找不到 nodes 字段，于是什么也没改——静默失败，最坑。
        body = Array.isArray(parsed) ? { nodes: parsed } : parsed;
        if (!Array.isArray(body.nodes)) throw new Error(`--nodes 文件要是节点数组，或者带 nodes 字段的对象：${args.flags.nodes}`);
      }
      const canvas = await api('PUT', `/api/canvases/${id}`, { body });
      // 服务端返回的 canvasMeta 不带节点数，用这次写进去的自己算。
      const count = Array.isArray(body.nodes) ? body.nodes.length : undefined;
      return { _cmd: 'canvas', action: 'update', id: canvas.id, name: canvas.name, count };
    }
    case 'delete': {
      const id = args.positionals[1];
      if (!id) throw new Error('用法: innate canvas delete <画布id>');
      await api('DELETE', `/api/canvases/${id}`);
      return { _cmd: 'canvas', action: 'delete', id };
    }
    case 'node':
      // 和 main 一样，把「node」这一层去掉，子命令拿到的才是真正的参数。
      return cmdCanvasNode({ positionals: args.positionals.slice(1), flags: args.flags });
    case 'grid':
      return cmdCanvasGrid(args);
    default:
      throw new Error('用法: innate canvas <create|get|list|update|delete|grid|node> ...');
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

// ---------- 画布上的单个节点：只读一个、只改一个 ----------
// `canvas update` 是整份替换，改一个提示词也得把整个节点数组搬一遍，中途页面上的改动会被一起盖掉。
// 改字走这里：只把要改的字段发出去，服务端合到一个节点上，历史版本、分组关系都留着。
const nodeBrief = (node) => ({
  id: node.id,
  type: node.type,
  no: node.data?.no ?? null,
  prompt: node.data?.prompt ?? null,
  text: node.data?.text ?? null,
  content: node.data?.recordId || node.data?.upload?.url || null,
  hidden: Boolean(node.hidden),
  ...(Array.isArray(node.data?.members) ? { members: node.data.members.length } : {}),
});

// --edit 的一项：{ori_text, new_text}，照原文定位再换掉，跟改文件时的 old/new 是一回事。
// 一组改动不限于一对：重复给 --edit、一次给一个数组、或者给一个装着数组的 .json 文件都行，按顺序叠加。
// 短的时候也可以写成 ["原文","新文"]。值以 { 或 [ 开头就当 JSON 解析；否则当文件路径读。
function readEditSpec(value) {
  const one = (item) => {
    // ["原文", "新文"]：只改一两处时比写对象省事。
    if (Array.isArray(item)) {
      if (item.length !== 2 || typeof item[0] !== 'string' || typeof item[1] !== 'string') {
        throw new Error('--edit 里的数组项要写成 ["原文","新文"]，两项都是字符串');
      }
      return { ori: item[0], next: item[1] };
    }
    if (!item || typeof item !== 'object') throw new Error('--edit 的每一项要长这样：{"ori_text":"…","new_text":"…"}');
    if (item.ori_text != null && typeof item.ori_text !== 'string') throw new Error('--edit 的 ori_text 要写成字符串');
    if (typeof item.new_text !== 'string') throw new Error('--edit 的 new_text 要写成字符串（要删掉一段就写 ""）');
    return { ori: item.ori_text ?? '', next: item.new_text };
  };
  const ops = toArr(value).flatMap((raw) => {
    if (raw === true) throw new Error(`--edit 要给一组改动：{"ori_text":"原文","new_text":"改成"}`);
    const text = String(raw).trim();
    let parsed;
    if (text.startsWith('{') || text.startsWith('[')) {
      try { parsed = JSON.parse(text); } catch { throw new Error(`--edit 不是合法 JSON：${text.slice(0, 40)}`); }
    } else {
      parsed = readJsonFile(text, 'edit');
    }
    // 一串字符串（["原文","新文"]）是一对，不是两个改动。
    if (Array.isArray(parsed) && parsed.length && parsed.every((item) => typeof item === 'string')) return [one(parsed)];
    return (Array.isArray(parsed) ? parsed : [parsed]).map(one);
  });
  if (!ops.length) throw new Error('--edit 里没有改动');
  return ops;
}

// 一处一处往现有的内容上改。ori_text 必须原样找得到：找不到说明记错了原文，出现多次说明定位不够明确，
// 两种都报错而不是猜——猜错就是悄悄改坏别人的提示词。--all 才允许一次改掉所有出现的地方。
function applyEdits(before, ops, all) {
  let text = before;
  const applied = [];
  for (const { ori, next } of ops) {
    // ori_text 留空 = 追加到结尾（补一句风格要求这类）。
    if (!ori) {
      text = text ? `${text}${next}` : next;
      applied.push({ ori_text: '', new_text: next, count: 1 });
      continue;
    }
    const count = text.split(ori).length - 1;
    if (!count) {
      throw new Error(`没找到要改的原文：${JSON.stringify(ori.slice(0, 40))}\n   节点里现在是：${JSON.stringify(before.slice(0, 120))}\n   （用 innate canvas node get 看全文，ori_text 必须一字不差）`);
    }
    if (count > 1 && !all) {
      throw new Error(`「${ori.slice(0, 40)}」出现了 ${count} 次，说不准改哪一处：把 ori_text 写长一点带上上下文，或者加 --all 全改`);
    }
    // 用 indexOf 拼接，不用 replace：new_text 里出现 $& 这类字符时 replace 会当成替换语法。
    const at = text.indexOf(ori);
    text = all ? text.split(ori).join(next) : `${text.slice(0, at)}${next}${text.slice(at + ori.length)}`;
    applied.push({ ori_text: ori, new_text: next, count: all ? count : 1 });
  }
  return { text, applied };
}

async function cmdCanvasNode(args) {
  const flags = args.flags;
  const sub = args.positionals[0];
  let rest = args.positionals.slice(1);
  // inputs 是 get 的一个视角，不是另一个命令：canvas node get <画布id> <节点id> inputs
  // 也认 canvas node get inputs <画布id> <节点id> 和 --inputs，怎么说都能读到。
  let view = 'node';
  if (sub === 'get') {
    if (rest[0] === 'inputs') { view = 'inputs'; rest = rest.slice(1); }
    else if (rest[2] === 'inputs') { view = 'inputs'; rest = rest.slice(0, 2); }
    else if (has(flags, 'inputs')) view = 'inputs';
  }
  const canvasId = rest[0];
  const nodeId = rest[1];
  if (!canvasId) throw new Error('用法: innate canvas node <get|set|list> <画布id> [节点id] [inputs]');

  // 只拿节点清单：画布可能很大，先看一眼有哪几个节点、各自写了什么。
  if (sub === 'list') {
    const canvas = await api('GET', `/api/canvases/${canvasId}`);
    return { _cmd: 'canvas', action: 'node', nodeAction: 'list', canvas: canvas.id, name: canvas.name, items: (canvas.nodes || []).map(nodeBrief) };
  }
  if (sub !== 'get' && sub !== 'set') throw new Error('用法: innate canvas node <get|set|list> ...');
  if (!nodeId) throw new Error(`用法: innate canvas node ${sub} <画布id> <节点id>${sub === 'set' ? ' [--prompt "…"]' : ''}`);

  if (sub === 'get') {
    // inputs：这个节点这次生成会用到哪些素材，顺带把 /media/... 换成本机绝对路径，读图不用先下载。
    if (view === 'inputs') {
      const data = await api('GET', `/api/canvases/${canvasId}/nodes/${encodeURIComponent(nodeId)}/inputs`);
      return { _cmd: 'canvas', action: 'node', nodeAction: 'inputs', canvas: canvasId, ...data };
    }
    const node = await api('GET', `/api/canvases/${canvasId}/nodes/${encodeURIComponent(nodeId)}`);
    return { _cmd: 'canvas', action: 'node', nodeAction: 'get', canvas: canvasId, node };
  }

  // set：只把传进来的字段放进请求。文本节点 content 是 --text，写作要求是 --prompt，别搞混。
  const editing = has(flags, 'edit');
  // 跟 --edit 一起用时，--prompt / --text 只是「改哪个字段」的开关，不带值。
  const editTarget = editing ? (has(flags, 'prompt') ? 'prompt' : has(flags, 'text') ? 'text' : null) : null;
  const data = {};
  if (!editing && has(flags, 'prompt')) data.prompt = String(flags.prompt);
  if (!editing && has(flags, 'text')) data.text = String(flags.text);
  let editResult = null;
  if (editing) {
    const ops = readEditSpec(flags.edit);
    if (!editTarget) {
      throw new Error(`--edit 要跟着 --prompt 或 --text 用：innate canvas node set <画布id> <节点id> --prompt --edit '{"ori_text":"原文","new_text":"改成"}'`);
    }
    if (typeof flags[editTarget] === 'string') {
      throw new Error(`--edit 直接改节点里现有的 ${editTarget}，别同时给 --${editTarget} 的值；要整段换掉就去掉 --edit`);
    }
    // 先读这一个节点，拿到现有的内容再在本地改：不用把整段重发一遍，也看得见改了哪几处。
    const node = await api('GET', `/api/canvases/${canvasId}/nodes/${encodeURIComponent(nodeId)}`);
    const before = String(node.data?.[editTarget] ?? '');
    editResult = applyEdits(before, ops, has(flags, 'all'));
    data[editTarget] = editResult.text;
  }
  if (flags.data !== undefined) {
    let extra;
    try { extra = JSON.parse(flags.data); } catch { throw new Error('--data 不是合法 JSON'); }
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error(`--data 要是一个 JSON 对象，例如 '{"model":"…"}'`);
    Object.assign(data, extra);
  }
  const body = {};
  if (Object.keys(data).length) body.data = data;
  if (has(flags, 'pos')) {
    const [x, y] = String(flags.pos).split(',').map((v) => Number(v.trim()));
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('--pos 要写成 x,y，例如 --pos 0,420');
    body.position = { x, y };
  }
  if (has(flags, 'hide')) body.hidden = true;
  if (has(flags, 'show')) body.hidden = false;
  if (!Object.keys(body).length) {
    throw new Error(`要改点什么：--prompt "…" / --prompt --edit '{"ori_text":"…","new_text":"…"}' / --text "…" / --data '{"model":"…"}' / --pos x,y / --hide / --show`);
  }
  const result = await api('PATCH', `/api/canvases/${canvasId}/nodes/${encodeURIComponent(nodeId)}`, { body });
  return {
    _cmd: 'canvas',
    action: 'node',
    nodeAction: 'set',
    canvas: result.canvas,
    changed: Object.keys(body),
    node: result.node,
    ...(editResult ? { target: editTarget, edits: editResult.applied } : {}),
  };
}

// ---------- 画布工作流：把画布上的一整套节点和连线存下来，之后原样放回任何一张画布 ----------
// 和下面 AutoDL 的「平台工作流」不是一回事：这里的节点指向生成记录，摆好就等于复刻一套分镜结构。
async function cmdWorkflow(args) {
  const sub = args.positionals[0];
  switch (sub) {
    case 'list': {
      const data = await api('GET', '/api/workflows');
      return { _cmd: 'workflow', action: 'list', items: data.items || [] };
    }
    case 'get': {
      const id = args.positionals[1];
      if (!id) throw new Error('用法: innate workflow get <工作流id>');
      return { _cmd: 'workflow', action: 'get', ...(await api('GET', `/api/workflows/${id}`)) };
    }
    case 'create': {
      // 直接从节点/连线文件建：agents 自己算好坐标时走这条。
      const file = args.flags.nodes;
      if (!file) throw new Error('用法: innate workflow create --name <名> --nodes nodes.json [--edges edges.json]');
      const nodes = readJsonFile(file, 'nodes');
      if (!Array.isArray(nodes) || !nodes.length) throw new Error('--nodes 里要有一组节点');
      const edges = args.flags.edges ? readJsonFile(args.flags.edges, 'edges') : [];
      const meta = await api('POST', '/api/workflows', { body: { name: str(args.flags.name) || '工作流', nodes, edges } });
      return { _cmd: 'workflow', action: 'create', ...meta };
    }
    case 'save': {
      // 把现有画布（例如 canvas grid 摆好的九宫格）整套存成工作流。
      const canvasId = str(args.flags.canvas) || args.positionals[1];
      if (!canvasId) throw new Error('用法: innate workflow save --canvas <画布id> [--name <名>]');
      const canvas = await api('GET', `/api/canvases/${canvasId}`);
      if (!Array.isArray(canvas.nodes) || !canvas.nodes.length) throw new Error(`画布 ${canvasId} 上没有节点`);
      const meta = await api('POST', '/api/workflows', {
        body: { name: str(args.flags.name) || canvas.name || '工作流', nodes: canvas.nodes, edges: canvas.edges || [] },
      });
      return { _cmd: 'workflow', action: 'save', ...meta };
    }
    case 'apply': {
      // 放回画布：节点和连线都换成新 id，位置整体平移到 --x/--y（不写就接在已有内容下面）。
      const id = args.positionals[1];
      if (!id) throw new Error('用法: innate workflow apply <工作流id> [--canvas <画布id>] [--x 0 --y 0] [--name <新画布名>]');
      const flow = await api('GET', `/api/workflows/${id}`);
      const canvasId = str(args.flags.canvas);
      const canvas = canvasId ? await api('GET', `/api/canvases/${canvasId}`) : await api('POST', '/api/canvases', { body: { name: str(args.flags.name) || flow.name || '画布' } });
      const old = Array.isArray(canvas.nodes) ? canvas.nodes : [];
      const map = new Map((flow.nodes || []).map((node) => [node.id, freshId('n')]));
      const solid = old.filter((node) => node.type !== 'group' && !node.hidden);
      const base = has(args.flags, 'x') || has(args.flags, 'y')
        ? { x: Number(args.flags.x) || 0, y: Number(args.flags.y) || 0 }
        : solid.length
          ? { x: Math.min(...solid.map((node) => Number(node.position?.x) || 0)), y: Math.max(...solid.map((node) => Number(node.position?.y) || 0)) + 400 }
          : { x: 0, y: 0 };
      const nodes = (flow.nodes || []).map((node) => ({
        ...node,
        id: map.get(node.id),
        position: { x: base.x + (Number(node.position?.x) || 0), y: base.y + (Number(node.position?.y) || 0) },
      }));
      // 连线只留两端都在这份工作流里的（跨出工作流的连线在存的时候就已经没了）。
      const edges = (flow.edges || [])
        .filter((edge) => map.has(edge.source) && map.has(edge.target))
        .map((edge) => ({ ...edge, id: freshId('e'), source: map.get(edge.source), target: map.get(edge.target) }));
      const updated = await api('PUT', `/api/canvases/${canvas.id}`, { body: { nodes: [...old, ...nodes], edges: [...(canvas.edges || []), ...edges] } });
      return { _cmd: 'workflow', action: 'apply', canvas: updated.id, name: updated.name, workflow: flow.name, nodes: nodes.length, edges: edges.length };
    }
    case 'delete': {
      const id = args.positionals[1];
      if (!id) throw new Error('用法: innate workflow delete <工作流id>');
      await api('DELETE', `/api/workflows/${id}`);
      return { _cmd: 'workflow', action: 'delete', id };
    }
    default:
      throw new Error('用法: innate workflow <list|get|create|save|apply|delete> ...');
  }
}

// ---------- AutoDL.art 的平台工作流：第三方跑图跑视频的流程，参数由平台给规则 ----------
// 只做「看目录 / 看规则 / 提交任务」三件事，和网页里选「工作流」生成是同一条通道。
async function cmdFlow(args) {
  const sub = args.positionals[0];
  switch (sub) {
    case 'list': {
      const data = await api('GET', '/api/autodl/workflows');
      return { _cmd: 'flow', action: 'list', hasKey: data.hasKey !== false, total: data.total || 0, items: data.items || [] };
    }
    case 'get': {
      const uuid = args.positionals[1];
      if (!uuid) throw new Error('用法: innate flow get <uuid>');
      return { _cmd: 'flow', action: 'get', ...(await api('GET', `/api/autodl/workflows/${encodeURIComponent(uuid)}`)) };
    }
    case 'run': {
      const uuid = args.positionals[1];
      if (!uuid) throw new Error("用法: innate flow run <uuid> [--input k=v ...] [--inputs <文件.json>] [--wait]");
      let inputs = args.flags.inputs ? readJsonFile(args.flags.inputs, 'inputs') : {};
      // --input prompt="一只猫" --input duration=5，可以重复；值一律按字符串传，服务端按平台规则校验。
      for (const pair of toArr(args.flags.input ?? [])) {
        if (pair === true) continue;
        const eq = String(pair).indexOf('=');
        if (eq === -1) throw new Error(`--input 要写成 k=v：${pair}`);
        inputs[String(pair).slice(0, eq)] = String(pair).slice(eq + 1);
      }
      const item = await api('POST', '/api/autodl/submit', { body: { workflow: uuid, inputs } });
      if (has(args.flags, 'wait') && item?.id) Object.assign(item, await awaitJob(item.id, args.flags.timeout));
      return { _cmd: 'flow', action: 'run', item };
    }
    default:
      throw new Error('用法: innate flow <list|get|run> ...');
  }
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
// 一条生成记录：状态、本机路径（或链接）、积分、失败原因。generate / wait / status / flow run 共用。
function printItem(it, fallbackType) {
  const icon = it.status === 'completed' ? '✓' : it.status === 'failed' ? '✗' : '…';
  console.log(`${icon} ${it.kind || fallbackType || 'task'}  ${it.id}  ${it.status || '?'}`);
  if (it.localPath) console.log(`   文件: ${it.localPath}`);
  else if (it.mediaUrl) console.log(`   链接: ${it.mediaUrl}`);
  if (it.credits != null) console.log(`   积分: ${it.credits}`);
  if (it.error) console.log(`   失败: ${it.error.message || it.error}${it.error.code ? ` (${it.error.code})` : ''}`);
}

function printHuman(out) {
  switch (out._cmd) {
    case 'models': {
      if (out.kind === 'audio') console.log('音频没有模型清单：音色用 innate voices，音效/配乐直接用 generate sfx|music。');
      if (out.videoModels) {
        console.log('视频模型:');
        const specs = out.videoSpecs || {};
        for (const model of out.videoModels) {
          const spec = specs[model] || {};
          const bits = [];
          if (spec.durations?.length) bits.push(`时长 ${Math.min(...spec.durations)}-${Math.max(...spec.durations)}s`);
          if (spec.ratios?.length) bits.push(`比例 ${spec.ratios.join('/')}`);
          if (spec.resolutions?.length) bits.push(`分辨率 ${spec.resolutions.join('/')}`);
          if (spec.frames?.length) bits.push(`帧 ${spec.frames.map((f) => (f === 'first_frame' ? '首' : '尾')).join('+')}`);
          if (spec.seed) bits.push('可给 seed');
          console.log(`  ${model}${bits.length ? `  ${bits.join('  ')}` : ''}`);
        }
      }
      if (out.imageModels) {
        console.log('图片模型:');
        const spec = out.imageSpecs || {};
        for (const model of out.imageModels) {
          const bits = [];
          const ratios = (spec.ratios || {})[model];
          if (ratios?.length) bits.push(`比例 ${ratios.join('/')}`);
          const size = (spec.sizes || {})[model];
          if (size?.options?.length) bits.push(`档位 ${size.options.join('/')}（默认 ${size.default}）`);
          const quality = (spec.qualities || {})[model];
          if (quality?.options?.length) bits.push(`画质 ${quality.options.join('/')}`);
          const refs = (spec.refs || {})[model];
          if (refs != null) bits.push(`参考图≤${refs}`);
          console.log(`  ${model}${bits.length ? `  ${bits.join('  ')}` : ''}`);
        }
      }
      console.log(`不可用(缺Key): ${(out.unavailable || []).join(', ') || '无'}`);
      if (out.source) console.log(`来源: ${out.source}`);
      break;
    }
    case 'generate':
    case 'wait':
    case 'status': {
      const items = out.items || (out.item ? [out.item] : []);
      for (const it of items) printItem(it, out.type);
      break;
    }
    case 'history':
      if (out.action === 'delete') { console.log(`已删除记录: ${out.id}`); break; }
      if (out.credits != null) console.log(`积分余额: ${out.credits}`);
      console.log(`记录数: ${out.items.length}`);
      for (const it of out.items.slice(0, 10)) console.log(`  ${it.status || '?'}  ${it.id}  ${it.model || ''}  ${it.localPath || ''}`);
      break;
    case 'upload':
      console.log(`已上传: ${out.url}  (${out.size} 字节)`);
      break;
    case 'media': {
      // 第一行就是路径：脚本里可以 path=$(innate media img_xxx) 直接用。
      console.log(out.path);
      const bits = [out.kind, out.bytes ? humanSize(out.bytes) : null, out.copied ? '已复制' : '本机原文件'].filter(Boolean);
      if (bits.length) console.log(`  ${bits.join('  ')}`);
      if (out.note) console.log(`  ${out.note}`);
      break;
    }
    case 'canvas':
      if (out.action === 'node') {
        if (out.nodeAction === 'list') {
          console.log(`画布 ${out.canvas}（${out.name || '未命名'}）共 ${out.items.length} 个节点`);
          for (const n of out.items) {
            const head = String(n.prompt || n.text || n.content || '').replace(/\s+/g, ' ').slice(0, 40);
            const bits = [n.hidden ? '隐藏' : '', n.members != null ? `${n.members} 个成员` : ''].filter(Boolean);
            console.log(`  ${n.id}  ${n.type}${n.no ? ` ${n.no}` : ''}${bits.length ? `  [${bits.join('，')}]` : ''}  ${head}`);
          }
        } else if (out.nodeAction === 'inputs') {
          const n = out.node;
          console.log(`${n.type}${n.no ? ` ${n.no}` : ''}  ${n.id}  输入 ${out.inputs.length} 项${n.model ? `（${n.model}）` : ''}`);
          const c = out.content;
          if (c?.via === 'text') {
            console.log(`  自身内容: 文本「${String(c.text || '').replace(/\s+/g, ' ').slice(0, 40)}」`);
          } else if (c?.localPath) {
            console.log(`  自身内容: ${c.localPath}${c.bytes ? `  ${humanSize(c.bytes)}` : ''}`);
          } else if (c) {
            console.log(`  自身内容: ${c.mediaUrl || c.url || c.note || '（没有文件）'}`);
          }
          for (const item of out.inputs) {
            const who = item.from === n.id ? '自身' : item.type ? `${item.type}${item.no ? ` ${item.no}` : ''}` : '连线';
            const where = item.text != null
              ? `「${String(item.text).replace(/\s+/g, ' ').slice(0, 32)}」${item.role === 'text' ? '（拼在提示词前）' : ''}`
              : item.localPath || item.mediaUrl || item.url || '（没有文件）';
            const size = item.bytes ? `  ${humanSize(item.bytes)}` : '';
            const bad = item.ready === false ? '  ⚠ 这次用不上' : '';
            console.log(`  [${item.roleLabel || item.role}]  ${who}  ${String(item.from).slice(0, 8)}  ${where}${size}${bad}`);
            if (item.ready === false && item.note) console.log(`      ${item.note}`);
          }
        } else if (out.nodeAction === 'set') {
          const n = out.node;
          console.log(`✓ 已改节点: ${n.id}（${n.type}${n.data?.no ? ` ${n.data.no}` : ''}）  字段: ${out.changed.join(', ')}`);
          // 按原文替换的，一处一行写清换了什么；改的是哪一段，看这行比看全文快。
          for (const e of out.edits || []) {
            const from = e.ori_text ? JSON.stringify(e.ori_text) : '（末尾）';
            console.log(`   替换 ${e.count} 处: ${from} → ${JSON.stringify(e.new_text)}`);
          }
          const shown = String(n.data?.prompt || n.data?.text || '').replace(/\s+/g, ' ');
          if (shown) console.log(`   ${shown.length > 80 ? `${shown.slice(0, 80)}…` : shown}`);
        } else {
          console.log(JSON.stringify(out.node, null, 2));
        }
        break;
      }
      if (out.action === 'grid') {
        console.log(`画布已创建: ${out.id}  (${out.name})`);
        console.log(`  节点: ${out.nodes}  连线: ${out.edges}  布局: ${out.cols}列 × 间距${out.gap}`);
      } else if (out.action === 'list') {
        for (const c of out.items) console.log(`  ${c.id}  ${c.name}`);
      } else if (out.action === 'update') {
        console.log(`画布已更新: ${out.id}  (${out.name})${out.count != null ? `  节点: ${out.count}` : ''}`);
      } else if (out.action === 'delete') {
        console.log(`画布已删除: ${out.id}`);
      } else {
        console.log(`画布: ${out.id}  (${out.name})  节点 ${(out.nodes || []).length}  连线 ${(out.edges || []).length}`);
      }
      break;
    case 'workflow':
      if (out.action === 'list') {
        if (!out.items.length) console.log('还没有工作流。');
        for (const w of out.items) console.log(`  ${w.id}  ${w.name}  ${w.count} 个节点`);
      } else if (out.action === 'get') {
        console.log(`工作流: ${out.id}  (${out.name})  节点 ${(out.nodes || []).length}  连线 ${(out.edges || []).length}`);
        for (const node of out.nodes || []) {
          const at = node.position ? `(${node.position.x},${node.position.y})` : '';
          const content = node.data?.recordId || node.data?.upload?.url || node.data?.text?.slice(0, 20) || '';
          console.log(`  ${node.id}  ${node.type}  ${at}  ${content}`);
        }
      } else if (out.action === 'apply') {
        console.log(`已放上画布: ${out.canvas}  (${out.name})  节点 +${out.nodes}  连线 +${out.edges}  来源: ${out.workflow}`);
      } else if (out.action === 'delete') {
        console.log(`工作流已删除: ${out.id}`);
      } else {
        console.log(`工作流: ${out.id}  (${out.name})  ${out.count} 个节点`);
      }
      break;
    case 'flow':
      if (out.action === 'list') {
        if (!out.hasKey) { console.log('AutoDL.art 还没配令牌，工作流目录不可用。'); break; }
        console.log(`平台工作流: ${out.items.length} 个（共 ${out.total}）`);
        for (const item of out.items.slice(0, 20)) {
          const cost = item.fromCredits != null ? `  ${item.fromCredits} 积分起` : '';
          const media = item.media?.length ? `  必填素材 ${item.media.join('/')}` : '';
          console.log(`  ${item.uuid}  ${item.name}  [${item.output}]${cost}${media}`);
        }
      } else if (out.action === 'get') {
        const flow = out.workflow || {};
        console.log(`工作流: ${flow.uuid || ''}  (${flow.name || ''})`);
        if (flow.description) console.log(`  说明: ${flow.description}`);
        for (const [key, rule] of Object.entries(flow.input_rules || {})) {
          const required = rule.required ? '必填' : '可选';
          const options = rule.options?.length ? `  可选 ${rule.options.join('/')}` : '';
          console.log(`  ${key}  ${rule.type}  ${required}${options}`);
        }
      } else {
        printItem(out.item, 'flow');
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
  history: cmdHistory, upload: cmdUpload, media: cmdMedia, canvas: cmdCanvas, workflow: cmdWorkflow, flow: cmdFlow,
  voices: cmdVoices, cost: cmdCost, state: cmdState, config: cmdConfig, doctor: cmdDoctor,
};

const USAGE = `Innate Studio Agent CLI

用法: innate <命令> [选项]
全局: --api-url <url> 覆盖 INNATE_API_URL
      --api-key <key> 覆盖 INNATE_API_KEY
      --json          打印服务器原始 JSON

命令:
  doctor                                 开工先跑：服务地址、连通性、身份、下一步建议
  state                                  服务状态（本机/多人、平台 Key）
  models [--kind image|video|audio]      可用模型 + 时长/比例/分辨率/档位等枚举
  voices                                 可用音色（语音的 --voice-id 从这里取）
  generate <image|video|speech|sfx|music> [--model --prompt --ratio --resolution --quality --count
           --duration --seed --ref <url> --first-frame <url> --last-frame <url> --wait --timeout 60 --data '{...}']
  wait <记录id> [--timeout 60]           阻塞等结果（服务端长轮询）
  status <记录id>                        查一次状态
  history [--limit N]                    生成记录与余额
  history delete <记录id>                删一条记录（含磁盘上的结果文件）
  upload <本地文件>                      上传参考素材，返回 /media/uploads/... 地址
  media <记录id|/media/…|https://…> [--out 目录]
                                         换成能直接打开的本机文件路径；本机有就不复制，
                                         没有（多机、公网链接）才下到 --out 或临时目录
  canvas create --name <名> | get <id> | list | delete <id>
  canvas update <id> [--nodes <文件.json>]   整份替换节点（不是追加）
  canvas node list <画布id>                  列出节点：id、类型、编号、提示词开头
  canvas node get  <画布id> <节点id>         读一个节点的完整数据
  canvas node get  <画布id> <节点id> inputs  这个节点这次生成会用到什么：连进来的参考图/首尾帧/
                                         参考视频/音频、上游文本、自身内容当底图——都给本机路径
  canvas node set  <画布id> <节点id> [--prompt "…"] [--text "…"] [--data '{"model":"…"}']
                   [--pos x,y] [--hide|--show]
                                         只改传进来的字段（改提示词用它，别整份 update）；
                                         --data 里写 null 是删掉这个键
  canvas node set  <画布id> <节点id> --prompt --edit '[{"ori_text":"原文","new_text":"改成"}, …]'
                   [--edit …] [--all]    在现有内容上按原文替换，不用重发整段；改动可以是一组
                                         （重复给 --edit / 一个数组 / 一个 .json 文件），
                                         每项也可以简写成 ["原文","新文"]；
                                         ori_text 留空是追加到结尾；找不到或出现多处都报错
                                         （--all 才全改）
  canvas grid --ids a,b,c [--cols 3] [--gap 360] [--type image] [--chain] [--start-x 0 --start-y 0]
                                         新建画布并按网格精确摆放
  workflow list | get <id> | delete <id>
  workflow create --name <名> --nodes nodes.json [--edges edges.json]
  workflow save --canvas <画布id> [--name <名>]      整张画布存成可复用的工作流
  workflow apply <id> [--canvas <画布id>] [--x 0 --y 0] [--name <名>]
                                         把工作流放回画布（不给 --canvas 就新建一张）
  flow list | get <uuid>                 AutoDL.art 平台工作流目录与参数规则
  flow run <uuid> [--input k=v ...] [--inputs inputs.json] [--wait]
                                         提交平台工作流任务
  cost                                   积分与记录数
  config show|set --url <地址> --key <isk_…>|clear   记住服务地址与令牌（写 ~/.innate/config.json，权限 600）
  config path                            配置文件路径

安装成全局命令（只需一次）：node <项目>/cli/install.mjs
环境变量（优先级高于配置文件）: INNATE_API_KEY  INNATE_API_URL
`;

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
