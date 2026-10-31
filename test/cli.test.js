// CLI 集成测试：用 mock 的 global.fetch 验证请求构造、鉴权头、--wait 长轮询、上传 Content-Type、
// 以及 canvas grid 的网格坐标计算。不依赖真实服务器，也不走网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

process.env.INNATE_API_URL = 'http://127.0.0.1:5199';
process.env.INNATE_API_KEY = 'isk_testkey';

const { main } = await import(pathToFileURL(path.resolve('cli/innate.mjs')).href);

const makeRes = (status, data) => ({ ok: status < 400, status, statusText: String(status), text: async () => JSON.stringify(data) });

async function runMain(args, fetchImpl) {
  const orig = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const logs = [];
  const errs = [];
  const ol = console.log;
  const oe = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errs.push(a.join(' '));
  let code = 0;
  try { code = await main(args); } catch (e) { errs.push('THROW: ' + e.message); code = 1; }
  console.log = ol;
  console.error = oe;
  globalThis.fetch = orig;
  return { code, out: logs.join('\n'), err: errs.join('\n') };
}

test('models: GET /api/models 且带鉴权头', async () => {
  const calls = [];
  const r = await runMain(['models', '--json'], async (u, init) => {
    calls.push({ u, init });
    return makeRes(200, { models: ['seedance-2.5'], imageModels: ['seedream-5.0-pro'], unavailable: ['minimax-h3'], source: 'default' });
  });
  assert.equal(r.code, 0);
  assert.match(calls[0].u, /\/api\/models$/);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer isk_testkey');
  assert.ok(r.out.includes('seedream-5.0-pro'));
});

test('generate image --wait: 提交后服务端长轮询拿 localPath', async () => {
  const calls = [];
  const r = await runMain(['generate', 'image', '--model', 'seedream-5.0-pro', '--prompt', '猫', '--ratio', '1:1', '--wait', '--json'], async (u, init) => {
    calls.push({ u, init });
    const p = new URL(u);
    if (init.method === 'POST' && p.pathname === '/api/images') return makeRes(200, { items: [{ id: 'img1', kind: 'image', status: 'queued' }] });
    if (init.method === 'POST' && /^\/api\/history\/img1\/refresh/.test(p.pathname)) {
      assert.match(p.searchParams.get('wait'), /^[0-9]+$/);
      return makeRes(200, { id: 'img1', kind: 'image', status: 'completed', localPath: '/abs/img1.png', credits: 5 });
    }
    return makeRes(404, { error: { code: 'not_found', message: 'no' } });
  });
  assert.equal(r.code, 0);
  assert.equal(calls.length, 2, '应提交一次 + 长轮询一次');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'seedream-5.0-pro');
  assert.equal(body.prompt, '猫');
  assert.equal(body.aspect_ratio, '1:1');
  assert.ok(r.out.includes('localPath') && r.out.includes('/abs/img1.png'));
  assert.ok(r.out.includes('"status": "completed"') || r.out.includes('"status":"completed"'));
});

test('generate video: 首帧与参考图 shape 正确', async () => {
  const calls = [];
  await runMain(['generate', 'video', '--model', 'seedance-2.5', '--prompt', '雨', '--first-frame', '/media/uploads/f.png', '--ref', '/media/uploads/r.png'], async (u, init) => {
    calls.push({ u, init });
    return makeRes(200, { id: 'v1', kind: 'video', status: 'queued' });
  });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.frame_images[0].image_url, '/media/uploads/f.png');
  assert.equal(body.frame_images[0].frame_type, 'first_frame');
  // 视频参考图：input_references 里 image_url 是字符串（和图片不同）
  assert.equal(body.input_references[0].image_url, '/media/uploads/r.png');
});

test('upload: 设对 Content-Type 并返回 url', async () => {
  const tmp = path.join(os.tmpdir(), `cli-up-${Date.now()}.png`);
  fs.writeFileSync(tmp, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG 头，内容无所谓
  const calls = [];
  const r = await runMain(['upload', tmp], async (u, init) => {
    calls.push({ u, init });
    return makeRes(200, { url: '/media/uploads/up1.png', size: 4 });
  });
  fs.unlinkSync(tmp);
  assert.equal(r.code, 0);
  assert.equal(calls[0].init.headers['Content-Type'], 'image/png');
  assert.ok(calls[0].init.body instanceof Uint8Array || Buffer.isBuffer(calls[0].init.body));
  assert.ok(r.out.includes('已上传: /media/uploads/up1.png'));
});

test('canvas grid: 建画布 + 网格坐标 + 摆节点 一次完成', async () => {
  const calls = [];
  const r = await runMain(['canvas', 'grid', '--name', '分镜', '--ids', 'r1,r2,r3,r4,r5,r6,r7,r8,r9', '--cols', '3', '--gap', '360', '--json'], async (u, init) => {
    calls.push({ u, init });
    const p = new URL(u);
    if (init.method === 'POST' && p.pathname === '/api/canvases') return makeRes(200, { id: 'cv1', name: '分镜' });
    if (init.method === 'PUT' && p.pathname === '/api/canvases/cv1') return makeRes(200, { id: 'cv1', name: '分镜', count: 9 });
    return makeRes(404, { error: { code: 'not_found', message: 'no' } });
  });
  assert.equal(r.code, 0);
  assert.equal(calls.length, 2, '建 + 更新');
  const putBody = JSON.parse(calls[1].init.body);
  assert.equal(putBody.nodes.length, 9);
  // 3×3 网格：第1个(0,0)、第2个(360,0)、第4个(0,360)
  assert.deepEqual(putBody.nodes[0].position, { x: 0, y: 0 });
  assert.deepEqual(putBody.nodes[1].position, { x: 360, y: 0 });
  assert.deepEqual(putBody.nodes[3].position, { x: 0, y: 360 });
  assert.equal(putBody.nodes[0].data.recordId, 'r1');
  assert.equal(putBody.edges.length, 0);
  assert.ok(r.out.includes('"nodes": 9'));
});

test('canvas grid --chain: 生成顺序连线', async () => {
  const calls = [];
  await runMain(['canvas', 'grid', '--ids', 'a,b,c', '--chain'], async (u, init) => {
    calls.push({ u, init });
    const p = new URL(u);
    if (init.method === 'POST' && p.pathname === '/api/canvases') return makeRes(200, { id: 'cv2', name: 'x' });
    if (init.method === 'PUT') return makeRes(200, { id: 'cv2', name: 'x', count: 3 });
    return makeRes(404, { error: { code: 'not_found', message: 'no' } });
  });
  const putBody = JSON.parse(calls[1].init.body);
  assert.equal(putBody.edges.length, 2);
  assert.equal(putBody.edges[0].source, 'n-1');
  assert.equal(putBody.edges[0].target, 'n-2');
});

test('错误路径: 上游 401 时把 message+code 透传到 stderr 并退出 1', async () => {
  const r = await runMain(['generate', 'image', '--model', 'x', '--prompt', 'y'], async () => makeRes(401, { error: { code: 'no_api_key', message: '请先在「管理」中配置 Key' } }));
  assert.equal(r.code, 1);
  assert.ok(r.err.includes('请先在「管理」中配置 Key'));
  assert.ok(r.err.includes('no_api_key'));
});

test('只读令牌撞墙时给出换 write 令牌的出路', async () => {
  const r = await runMain(['generate', 'image', '--model', 'x', '--prompt', 'y'], async () => makeRes(403, { error: { code: 'read_only_key', message: '该令牌为只读，不能执行写操作' } }));
  assert.equal(r.code, 1);
  assert.ok(r.err.includes('read_only_key'));
  assert.ok(r.err.includes('pnpm user token add --scope write'), '要告诉 agent 怎么拿到能写令牌');
});

test('未知命令返回退出码 2', async () => {
  const r = await runMain(['frobnicate'], async () => makeRes(200, {}));
  assert.equal(r.code, 2);
});

test('--data 合并原始字段绕过 flag 限制', async () => {
  const calls = [];
  await runMain(['generate', 'image', '--model', 'm', '--prompt', 'p', '--data', '{"n":4}'], async (u, init) => {
    calls.push({ u, init });
    return makeRes(200, { items: [{ id: 'i', kind: 'image', status: 'queued' }] });
  });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.n, 4);
});

test('models --kind image: 只给图片模型和图片规格', async () => {
  const r = await runMain(['models', '--kind', 'image', '--json'], async () =>
    makeRes(200, {
      models: ['v-model'], videoSpecs: {}, imageModels: ['i-model'],
      imageRatios: { 'i-model': ['1:1'] }, imageSizes: { 'i-model': { options: ['1K'], default: '1K' } },
      imageQualities: {}, imageRefs: { 'i-model': 4 }, unavailable: ['v-model', 'i-model'], source: 'remote',
    }));
  assert.equal(r.code, 0);
  const out = JSON.parse(r.out).data;
  assert.equal(out.models, undefined, '--kind image 不该报视频模型');
  assert.deepEqual(out.imageModels, ['i-model']);
  assert.deepEqual(out.imageRatios['i-model'], ['1:1']);
  assert.deepEqual(out.unavailable, ['i-model'], '缺 Key 名单也只留这一类');
});

test('workflow save: 读画布再整套存成工作流', async () => {
  const calls = [];
  const r = await runMain(['workflow', 'save', '--canvas', 'cv1', '--name', '分镜模板', '--json'], async (u, init) => {
    calls.push({ u, init });
    const p = new URL(u);
    if (init.method === 'GET' && p.pathname === '/api/canvases/cv1') {
      return makeRes(200, { id: 'cv1', name: '分镜', nodes: [{ id: 'a', type: 'image', position: { x: 0, y: 0 }, data: {} }], edges: [{ id: 'e', source: 'a', target: 'a' }] });
    }
    if (init.method === 'POST' && p.pathname === '/api/workflows') return makeRes(200, { id: 'wf1', name: '分镜模板', count: 1 });
    return makeRes(404, { error: { code: 'not_found', message: 'no' } });
  });
  assert.equal(r.code, 0);
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.name, '分镜模板');
  assert.equal(body.nodes.length, 1);
  assert.equal(body.edges.length, 1);
  assert.ok(r.out.includes('wf1'));
});

test('workflow apply: 换新 id、连线跟着改、接在已有节点下方', async () => {
  const calls = [];
  const r = await runMain(['workflow', 'apply', 'wf1', '--canvas', 'cv1', '--json'], async (u, init) => {
    calls.push({ u, init });
    const p = new URL(u);
    if (init.method === 'GET' && p.pathname === '/api/workflows/wf1') {
      return makeRes(200, {
        id: 'wf1', name: '模板',
        nodes: [
          { id: 'a', type: 'image', position: { x: 0, y: 0 }, data: { recordId: 'r1' } },
          { id: 'b', type: 'video', position: { x: 360, y: 0 }, data: { recordId: 'r2' } },
        ],
        edges: [{ id: 'e1', source: 'a', target: 'b' }],
      });
    }
    if (init.method === 'GET' && p.pathname === '/api/canvases/cv1') {
      return makeRes(200, { id: 'cv1', name: '已有画布', nodes: [{ id: 'old', type: 'image', position: { x: 0, y: 0 }, data: {} }], edges: [] });
    }
    if (init.method === 'PUT' && p.pathname === '/api/canvases/cv1') return makeRes(200, { id: 'cv1', name: '已有画布' });
    return makeRes(404, { error: { code: 'not_found', message: 'no' } });
  });
  assert.equal(r.code, 0);
  const body = JSON.parse(calls[2].init.body);
  assert.equal(body.nodes.length, 3, '原有节点 + 工作流的两个');
  const added = body.nodes.slice(1);
  assert.ok(added.every((node) => node.id !== 'a' && node.id !== 'b'), 'id 要重新分配');
  assert.deepEqual(added[0].position, { x: 0, y: 400 }, '已有内容时接在下方 400px');
  assert.deepEqual(added[1].position, { x: 360, y: 400 });
  assert.equal(body.edges.length, 1);
  assert.equal(body.edges[0].source, added[0].id);
  assert.equal(body.edges[0].target, added[1].id);
});

test('flow run: 把 --input 拼成平台的 inputs', async () => {
  const calls = [];
  const r = await runMain(['flow', 'run', 'abc123', '--input', 'prompt=雨夜', '--input', 'duration=5', '--json'], async (u, init) => {
    calls.push({ u, init });
    return makeRes(200, { id: 't1', kind: 'video', status: 'queued' });
  });
  assert.equal(r.code, 0);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.workflow, 'abc123');
  assert.deepEqual(body.inputs, { prompt: '雨夜', duration: '5' });
});

test('history delete: DELETE /api/history/<id>', async () => {
  const calls = [];
  const r = await runMain(['history', 'delete', 'img1'], async (u, init) => {
    calls.push({ u, init });
    return makeRes(200, null);
  });
  assert.equal(r.code, 0);
  assert.equal(calls[0].init.method, 'DELETE');
  assert.match(calls[0].u, /\/api\/history\/img1$/);
  assert.ok(r.out.includes('已删除记录: img1'));
});
