#!/usr/bin/env node
// 探测：能不能从 RunningHub 拿到 ComfyUI 的实时预览帧。
//
// 背景：工作流里的 ModelPreviewOverrideKJ（节点 337）会在每个采样步解码一帧，
// 编码成 mp4 / 动图 webp（base64），用 `kj_preview_override` 事件定向发给
// 「提交这个 prompt 的 client_id」。它不写盘、不进 history、不进 outputs，
// 所以 REST 查询永远拿不到 —— 只能自己当那个客户端连 WS。
//
// RunningHub 的 create 返回里有 netWssUrl + clientId（文档标注「不稳定，不推荐」，
// 示例里是 null）。这个脚本就试这条路：
//   1. 提交一个任务，把 netWssUrl / clientId 打出来
//   2. 连上去，把收到的事件类型、预览帧都记下来（帧存成文件）
//   3. 到时间自动取消任务（除非 --keep）
//
// 用法：
//   RH_API_KEY=xxx node docs/runninghub/probe-preview-ws.mjs <workflowId> [--seconds 60] [--keep]
//   RH_API_KEY=xxx node docs/runninghub/probe-preview-ws.mjs <workflowId> --nodes '[{"nodeId":"248","fieldName":"text","fieldValue":"hi"}]'
//
// 注意：这是真跑一次任务，会计费；默认 60 秒后取消。

import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.RH_BASE || 'https://www.runninghub.cn').replace(/\/$/, '');
const HOST = BASE.split('//')[1];
const KEY = process.env.RH_API_KEY || '';
const OUT_DIR = process.env.RH_PREVIEW_DIR || path.resolve('rh-previews');

const argv = process.argv.slice(2);
const workflowId = argv.find((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const seconds = Number(flag('seconds', 60));
const keep = argv.includes('--keep');
const nodesRaw = flag('nodes', '[]');

if (!KEY) { console.error('请先 export RH_API_KEY=你的key'); process.exit(1); }
if (!workflowId) { console.error('用法: node probe-preview-ws.mjs <workflowId> [--seconds 60] [--keep]'); process.exit(1); }

const nodeInfoList = JSON.parse(nodesRaw);

async function post(pathname, json) {
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: {
      Host: HOST,
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify(json),
  });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
}

// ---------- 1. 提交 ----------
console.log('提交任务…');
let submit = await post(`/openapi/v2/run/workflow/${encodeURIComponent(workflowId)}`, { nodeInfoList, instanceType: 'default' });
if (submit.status === 404 || submit.status === 500) {
  console.log('V2 提交失败，退回 V1:', submit.status);
  submit = await post('/task/openapi/create', { apiKey: KEY, workflowId, nodeInfoList, addMetadata: false, instanceType: 'default' });
}
console.log('提交返回:', JSON.stringify(submit.body).slice(0, 1200));

const body = submit.body || {};
const data = body.data || body;
const taskId = data.taskId || data.data?.taskId;
const netWssUrl = data.netWssUrl || data.data?.netWssUrl;
const clientId = data.clientId || data.data?.clientId;

if (!taskId) { console.error('没拿到 taskId，终止'); process.exit(1); }
console.log('taskId =', taskId);
console.log('netWssUrl =', netWssUrl ?? '(null)');
console.log('clientId  =', clientId ?? '(null)');

if (!netWssUrl) {
  console.log('\n>>> netWssUrl 是空的：平台没给 WS 地址，这条路走不通。');
  console.log('>>> 需要改走「草稿工作流」方案。');
  if (!keep) await post('/task/openapi/cancel', { apiKey: KEY, taskId });
  process.exit(0);
}

// ---------- 2. 连 WS ----------
const wsUrl = netWssUrl + (netWssUrl.includes('?') ? '&' : '?') + 'clientId=' + encodeURIComponent(clientId || '');
console.log('\n连接', wsUrl);

const ws = new WebSocket(wsUrl);
ws.binaryType = 'arraybuffer';

fs.mkdirSync(OUT_DIR, { recursive: true });
const seen = new Map();
let frames = 0;

const saveFrame = (buf, ext) => {
  frames += 1;
  const file = path.join(OUT_DIR, `frame-${String(frames).padStart(3, '0')}.${ext}`);
  fs.writeFileSync(file, buf);
  if (frames <= 5 || frames % 10 === 0) console.log('   已保存', file, `(${buf.length} B)`);
};

const onJson = (msg) => {
  const type = msg?.type || '(no type)';
  seen.set(type, (seen.get(type) || 0) + 1);

  // KJNodes 的自定义预览事件：base64 的 mp4 / webp / jpeg
  if (type === 'kj_preview_override' && msg.data?.image) {
    const buf = Buffer.from(msg.data.image, 'base64');
    const mime = msg.data.mime || 'image/jpeg';
    const ext = mime.includes('mp4') ? 'mp4' : mime.includes('webp') ? 'webp' : 'jpg';
    console.log(`[kj_preview_override] step ${msg.data.step}/${msg.data.total} ${mime} ${msg.data.w}×${msg.data.h} ${Math.round((msg.data.step_ms || 0))}ms`);
    console.log('   字段:', Object.keys(msg.data).join(', '));
    saveFrame(buf, ext);
    return;
  }
  if (type === 'progress') { console.log('[progress]', JSON.stringify(msg.data)); return; }
  if (type === 'executing' || type === 'executed' || type === 'execution_start' || type === 'execution_error') {
    console.log(`[${type}]`, JSON.stringify(msg.data).slice(0, 200));
    return;
  }
  if (type === 'status') return;
  console.log(`[${type}]`, JSON.stringify(msg.data ?? msg).slice(0, 200));
};

ws.addEventListener('open', () => console.log('WS 已连上，等待事件…'));
ws.addEventListener('error', (e) => console.log('WS 错误:', e?.message || e?.error || '(no detail)'));
ws.addEventListener('close', (e) => console.log('WS 关闭:', e.code, e.reason));

ws.addEventListener('message', async (event) => {
  const d = event.data;
  if (typeof d === 'string') {
    try { onJson(JSON.parse(d)); } catch { console.log('[text]', d.slice(0, 200)); }
    return;
  }
  // ComfyUI 二进制帧：4B 事件类型 + 4B JSON 长度 + JSON + 图像
  const buf = Buffer.from(await (d.arrayBuffer ? d.arrayBuffer() : d));
  if (buf.length > 8) {
    const type = buf.readUInt32BE(0);
    const len = buf.readUInt32BE(4);
    const meta = len > 0 && 8 + len <= buf.length ? JSON.parse(buf.subarray(8, 8 + len).toString('utf8')) : {};
    console.log(`[binary:${type}]`, JSON.stringify(meta).slice(0, 160), `${buf.length} B`);
    saveFrame(buf.subarray(8 + len), 'jpg');
  }
});

// ---------- 3. 收尾 ----------
const finish = async () => {
  console.log('\n=== 汇总 ===');
  for (const [type, n] of [...seen].sort((a, b) => b[1] - a[1])) console.log(`  ${type} × ${n}`);
  console.log('预览帧数量:', frames, frames ? `→ ${OUT_DIR}` : '');
  console.log(frames ? '\n>>> 有预览帧：这条路可行，可以做「低频实时预览」+ 真进度条。'
                     : '\n>>> 连上了但没有任何预览帧：可能平台没转发 kj_preview_override，或帧被过滤。');
  try { ws.close(); } catch {}
  if (!keep) {
    const r = await post('/task/openapi/cancel', { apiKey: KEY, taskId });
    console.log('已取消任务:', JSON.stringify(r.body).slice(0, 300));
  }
  process.exit(0);
};

setTimeout(finish, seconds * 1000);
