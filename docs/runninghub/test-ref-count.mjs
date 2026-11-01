#!/usr/bin/env node
// 测试：海螺H3 人物替换流 v1.7 的「参考图 1~9 张可选」。
//
// 工作流里把张数收敛成了一个参数：节点 736 的 value（PrimitiveInt）。
// 这个脚本按张数提交任务、轮询、下载结果，用来验证：
//   1. 张数传对了，任务能正常跑完（不报“参考图槽位缺失”之类）
//   2. 1 张 / 3 张 / 9 张 的产出确实不一样（说明真的换了参考图数量）
//
// 用法：
//   export RH_API_KEY=xxx
//   node docs/runninghub/test-ref-count.mjs <workflowId> --count 1,3 --images ./refs
//   node docs/runninghub/test-ref-count.mjs <workflowId> --count 9 --images ./refs --dry
//
// 参数：
//   --count 1,3,9     要测的张数（逗号分隔，默认 3）
//   --images <dir>    参考图目录，按文件名排序取前 N 张（或 --img1..--img9 单独指定）
//   --prompt "..."    顺便改提示词（节点 248）
//   --dry             只打印 nodeInfoList，不提交
//   --keep            跑完不取消（默认也不取消，只是记录 taskId）
//
// 注意：每提交一次都会真跑一次任务，会计费。建议先跑 --count 3 确认链路通，
// 再跑 1 / 9 对比。

import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.RH_BASE || 'https://www.runninghub.cn').replace(/\/$/, '');
const HOST = BASE.split('//')[1];
const OUT_DIR = path.resolve(process.env.RH_OUT_DIR || 'rh-out');
const POLL_MS = Number(process.env.RH_POLL_MS || 6000);

// v1.7 的节点编号（从工作流 JSON 里读不到就用这套默认值）
const COUNT_NODE = 736;         // PrimitiveInt：参考图张数 1~9
const PROMPT_NODE = 248;        // PrimitiveStringMultiline：提示词
const LOADERS = [215, 218, 221, 614, 615, 618, 730, 731, 732];  // 参考图 1~9

const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(['count', 'images', 'prompt', 'out', 'img1', 'img2', 'img3', 'img4', 'img5', 'img6', 'img7', 'img8', 'img9']);
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a.startsWith('--')) {
    if (VALUE_FLAGS.has(a.slice(2))) i += 1;
    continue;
  }
  positional.push(a);
}
const workflowId = positional[0];
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const counts = String(flag('count', '3')).split(',').map((s) => Number(s.trim())).filter((n) => n >= 1 && n <= 9);
const imagesDir = flag('images', '');
const promptText = flag('prompt', '');
const dry = argv.includes('--dry');

// ---------- Key：单个环境变量，或项目用的 keys 文件 ----------
function loadKey() {
  if (process.env.RH_API_KEY) return process.env.RH_API_KEY;
  const file = process.env.RUNNINGHUB_KEYS_FILE;
  if (file && fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.keys || [];
    const first = list.find((k) => (typeof k === 'string' ? true : k.enabled !== false));
    if (typeof first === 'string') return first;
    if (first?.key) return first.key;
  }
  if (process.env.RUNNINGHUB_API_KEY) return process.env.RUNNINGHUB_API_KEY;
  return '';
}

const KEY = loadKey();
if (!KEY) { console.error('缺少 Key：export RH_API_KEY=xxx，或设置 RUNNINGHUB_KEYS_FILE'); process.exit(1); }
if (!workflowId) { console.error('用法: node test-ref-count.mjs <workflowId> --count 1,3 --images ./refs'); process.exit(1); }
if (!counts.length) { console.error('--count 只能是 1~9'); process.exit(1); }

async function post(pathname, json) {
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { Host: HOST, 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(json),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function uploadImage(filePath) {
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'image/png' }), path.basename(filePath));
  const res = await fetch(BASE + '/openapi/v2/media/upload/binary', {
    method: 'POST',
    headers: { Host: HOST, Authorization: `Bearer ${KEY}` },
    body: form,
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  const data = body?.data || body;
  const fileName = data?.fileName;
  if (!fileName) throw new Error(`上传失败 ${path.basename(filePath)}: ${text.slice(0, 300)}`);
  return String(fileName);
}

function collectImages() {
  const explicit = [];
  for (let i = 1; i <= 9; i += 1) {
    const p = flag(`img${i}`, '');
    if (p) explicit.push(p);
  }
  if (explicit.length) return explicit;
  if (!imagesDir) return [];
  return fs.readdirSync(imagesDir)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .sort()
    .slice(0, 9)
    .map((f) => path.join(imagesDir, f));
}

function buildNodeInfoList(count, uploaded) {
  const list = [];
  // 张数只需要这一个参数
  list.push({ nodeId: String(COUNT_NODE), fieldName: 'value', fieldValue: count });
  if (promptText) list.push({ nodeId: String(PROMPT_NODE), fieldName: 'value', fieldValue: promptText });
  // 9 个 image 字段全填：未启用的填第 1 张，避免惰性执行失效时 LoadImage 报文件不存在
  for (let i = 0; i < LOADERS.length; i += 1) {
    const name = uploaded[i] || uploaded[0];
    if (name) list.push({ nodeId: String(LOADERS[i]), fieldName: 'image', fieldValue: name });
  }
  return list;
}

async function submit(nodeInfoList) {
  for (const asString of [false, true]) {
    const payload = asString
      ? nodeInfoList.map((n) => (n.fieldName === 'value' ? { ...n, fieldValue: String(n.fieldValue) } : n))
      : nodeInfoList;
    let r = await post(`/openapi/v2/run/workflow/${encodeURIComponent(workflowId)}`, { nodeInfoList: payload, instanceType: 'default' });
    if (r.status === 404 || r.status === 500) {
      r = await post('/task/openapi/create', { apiKey: KEY, workflowId, nodeInfoList: payload, addMetadata: false, instanceType: 'default' });
    }
    const body = r.body || {};
    const data = body.data || body;
    const taskId = data?.taskId;
    const errCode = body.errorCode || (body.code !== undefined && Number(body.code) !== 0 ? body.code : '');
    if (taskId) return { taskId: String(taskId), asString, raw: body };
    if (!asString) {
      console.log(`  提交被拒（${errCode || r.status}），改用字符串形式重试一次…`);
      continue;
    }
    throw new Error(`提交失败: ${JSON.stringify(body).slice(0, 600)}`);
  }
  throw new Error('提交失败');
}

async function poll(taskId, label) {
  const started = Date.now();
  let last = '';
  for (;;) {
    const r = await post('/openapi/v2/query', { taskId });
    const body = r.body || {};
    const data = body.data || body;
    const status = String(data?.status || '').toUpperCase();
    if (status !== last) {
      const sec = ((Date.now() - started) / 1000).toFixed(0);
      console.log(`  [${label}] ${status || '?'}  (${sec}s)`);
      last = status;
    }
    if (['SUCCESS', 'SUCCEEDED', 'COMPLETED', 'DONE'].includes(status)) return data;
    if (['FAILED', 'FAILURE', 'ERROR', 'CANCELED', 'CANCELLED'].includes(status)) {
      throw new Error(`任务失败: ${JSON.stringify(body).slice(0, 800)}`);
    }
    if (data?.errorCode) throw new Error(`查询报错: ${JSON.stringify(body).slice(0, 800)}`);
    if (Date.now() - started > 40 * 60 * 1000) throw new Error('超时（40 分钟）');
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
}

async function downloadAll(data, label) {
  const urls = [];
  const walk = (v) => {
    if (!v) return;
    if (typeof v === 'string' && /^https?:\/\//.test(v) && /\.(mp4|webm|png|jpe?g|webp|gif)(\?|$)/i.test(v)) urls.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(data?.results);
  const saved = [];
  for (const url of urls) {
    const ext = (url.match(/\.(mp4|webm|png|jpe?g|webp|gif)(\?|$)/i) || [, 'bin'])[1];
    const file = path.join(OUT_DIR, `${label}.${ext}`);
    const res = await fetch(url);
    if (!res.ok) { console.log(`  下载失败 ${res.status}: ${url}`); continue; }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    saved.push(file);
    console.log(`  存盘 ${file}`);
  }
  return saved;
}

// ---------- 主流程 ----------
const files = collectImages();
console.log(`工作流 ${workflowId}｜张数 ${counts.join(', ')}｜本地图片 ${files.length} 张`);
if (!files.length) console.log('提示：没给图片，将只改张数、沿用工作流里已上传的图');

const uploaded = [];
for (const f of files) {
  const name = await uploadImage(f);
  uploaded.push(name);
  console.log(`  上传 ${path.basename(f)} -> ${name}`);
}

const results = [];
for (const count of counts) {
  console.log(`\n=== 张数 ${count} ===`);
  const nodeInfoList = buildNodeInfoList(count, uploaded);
  if (dry) {
    console.log(JSON.stringify(nodeInfoList, null, 1));
    continue;
  }
  const { taskId, asString } = await submit(nodeInfoList);
  console.log(`  taskId ${taskId}${asString ? '（fieldValue 用字符串）' : ''}`);
  const data = await poll(taskId, `${count} 张`);
  console.log(`  usage: ${JSON.stringify(data?.usage ?? {}).slice(0, 200)}`);
  const saved = await downloadAll(data, `ref${count}`);
  results.push({ count, taskId, saved });
}

if (!dry) {
  console.log('\n=== 汇总 ===');
  for (const r of results) {
    console.log(`${r.count} 张 | ${r.taskId} | ${r.saved.length ? r.saved.join(', ') : '未解析到结果文件'}`);
  }
  if (results.length > 1) console.log('\n对比：不同张数应产出不同视频（相同则说明张数参数没生效）');
}
