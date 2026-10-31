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

test('canvas update --nodes: 文件是节点数组（文档写法）也照原样写进 nodes', async () => {
  const file = path.join(os.tmpdir(), `innate-nodes-${process.pid}.json`);
  const nodes = [{ id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { prompt: '猫' } }];
  fs.writeFileSync(file, JSON.stringify(nodes));
  const calls = [];
  try {
    const r = await runMain(['canvas', 'update', 'cv1', '--nodes', file, '--json'], async (u, init) => {
      calls.push({ u, init });
      return makeRes(200, { id: 'cv1', name: '分镜' });
    });
    assert.equal(r.code, 0);
    // 以前数组被当成整个请求体原样发出去，服务端找不到 nodes 字段，画布一点没变。
    assert.deepEqual(JSON.parse(calls[0].init.body), { nodes });
    assert.equal(JSON.parse(r.out).count, 1);
  } finally {
    fs.unlinkSync(file);
  }
});

test('canvas node get: 只请求这一个节点', async () => {
  const calls = [];
  const r = await runMain(['canvas', 'node', 'get', 'cv1', 'n-3', '--json'], async (u, init) => {
    calls.push({ u, init });
    return makeRes(200, { id: 'n-3', type: 'image', data: { no: 3, prompt: '雨夜街道', kept: [{ recordId: 'r0', at: 1 }] } });
  });
  assert.equal(r.code, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0].u, /\/api\/canvases\/cv1\/nodes\/n-3$/);
  assert.equal(calls[0].init.method, 'GET');
  // 整份节点原样给出来：历史版本这些也得看到，改的时候才不会漏。
  assert.ok(r.out.includes('kept'));
});

test('canvas node set --prompt: 只 PATCH data.prompt，不动别的字段', async () => {
  const calls = [];
  const r = await runMain(['canvas', 'node', 'set', 'cv1', 'n-3', '--prompt', '雪夜街道', '--json'], async (u, init) => {
    calls.push({ u, init });
    return makeRes(200, { canvas: 'cv1', updatedAt: 1, node: { id: 'n-3', type: 'image', position: { x: 0, y: 0 }, data: { no: 3, prompt: '雪夜街道', kept: [{ recordId: 'r0', at: 1 }] } } });
  });
  assert.equal(r.code, 0);
  assert.equal(calls.length, 1, '一次请求搞定，不需要先 GET 再写回整份');
  assert.match(calls[0].u, /\/api\/canvases\/cv1\/nodes\/n-3$/);
  assert.equal(calls[0].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].init.body), { data: { prompt: '雪夜街道' } });
  assert.ok(r.out.includes('雪夜街道'));
});

test('canvas node set: --text / --data / --pos / --hide 合进一个请求', async () => {
  const calls = [];
  await runMain(['canvas', 'node', 'set', 'cv1', 'n-1', '--text', '第一镜：雨夜', '--data', '{"model":"doubao-seedance-2-5","flowValues":null}', '--pos', '0,420', '--hide', '--json'], async (u, init) => {
    calls.push({ u, init });
    return makeRes(200, { canvas: 'cv1', updatedAt: 1, node: { id: 'n-1', type: 'text', data: { text: '第一镜：雨夜' } } });
  });
  assert.equal(calls[0].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    data: { text: '第一镜：雨夜', model: 'doubao-seedance-2-5', flowValues: null },
    position: { x: 0, y: 420 },
    hidden: true,
  });
});

test('canvas node set 什么都不给就报用法，不发请求', async () => {
  let called = 0;
  const r = await runMain(['canvas', 'node', 'set', 'cv1', 'n-3'], async () => { called += 1; return makeRes(200, {}); });
  assert.equal(r.code, 1);
  assert.equal(called, 0);
  assert.ok(r.err.includes('--prompt'));
});

test('canvas node list: 一个请求列出整个画布的节点摘要', async () => {
  const calls = [];
  const r = await runMain(['canvas', 'node', 'list', 'cv1', '--json'], async (u, init) => {
    calls.push({ u, init });
    return makeRes(200, { id: 'cv1', name: '分镜', nodes: [
      { id: 'n-1', type: 'image', position: { x: 0, y: 0 }, data: { no: 1, prompt: '雨夜街道', recordId: 'r1' } },
      { id: 'n-2', type: 'group', position: { x: 0, y: 0 }, data: { members: ['n-1'] } },
    ] });
  });
  assert.equal(r.code, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0].u, /\/api\/canvases\/cv1$/);
  const out = JSON.parse(r.out);
  assert.equal(out.items[0].prompt, '雨夜街道');
  assert.equal(out.items[0].content, 'r1');
  assert.equal(out.items[1].members, 1);
});

// --prompt --edit：先读这一个节点，在本地按原文替换，再把结果 PATCH 回去。
function editRun(ops, { current = '', args = [] } = {}) {
  const calls = [];
  const run = runMain(['canvas', 'node', 'set', 'cv1', 'n-3', '--prompt', ...ops.flatMap((op) => ['--edit', op]), ...args, '--json'], async (u, init) => {
    calls.push({ u, init });
    if (init.method === 'GET') return makeRes(200, { id: 'n-3', type: 'image', data: { no: 3, prompt: current, kept: [{ recordId: 'r0', at: 1 }] } });
    return makeRes(200, { canvas: 'cv1', updatedAt: 1, node: { id: 'n-3', type: 'image', data: { no: 3, prompt: JSON.parse(init.body).data.prompt } } });
  });
  return { calls, run };
}
const patchPrompt = (calls) => JSON.parse(calls[1].init.body).data.prompt;

test('canvas node set --prompt --edit: 按 ori_text 替换，只 PATCH 改后的完整内容', async () => {
  const { calls, run } = editRun(['{"ori_text":"雨夜","new_text":"雪夜"}'], { current: '雨夜的街道，一只猫' });
  const r = await run;
  assert.equal(r.code, 0);
  assert.equal(calls.length, 2, '读一个节点 + 写一个字段');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[1].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[1].init.body), { data: { prompt: '雪夜的街道，一只猫' } });
  assert.deepEqual(JSON.parse(r.out).edits, [{ ori_text: '雨夜', new_text: '雪夜', count: 1 }]);
});

test('canvas node set --prompt --edit: 一组改动按顺序叠加，重复 --edit 或给数组都行', async () => {
  const ops = '{"ori_text":"雨夜","new_text":"雪夜"}';
  const ops2 = '{"ori_text":"一只猫","new_text":"一个女孩"}';
  const repeated = editRun([ops, ops2], { current: '雨夜的街道，一只猫' });
  assert.equal((await repeated.run).code, 0);
  assert.equal(patchPrompt(repeated.calls), '雪夜的街道，一个女孩');

  const asArray = editRun([JSON.stringify([JSON.parse(ops), JSON.parse(ops2)])], { current: '雨夜的街道，一只猫' });
  assert.equal((await asArray.run).code, 0);
  assert.equal(patchPrompt(asArray.calls), '雪夜的街道，一个女孩');

  // 一对的短写法：["原文","新文"]，单独给和一串给都认。
  const pair = editRun(['["雨夜","雪夜"]'], { current: '雨夜的猫' });
  assert.equal((await pair.run).code, 0);
  assert.equal(patchPrompt(pair.calls), '雪夜的猫');

  const pairs = editRun(['[["雨夜","雪夜"],["猫","女孩"]]'], { current: '雨夜的猫' });
  assert.equal((await pairs.run).code, 0);
  assert.equal(patchPrompt(pairs.calls), '雪夜的女孩');

  const mixed = editRun(['[{"ori_text":"雨夜","new_text":"雪夜"},["猫","女孩"]]'], { current: '雨夜的猫' });
  assert.equal((await mixed.run).code, 0);
  assert.equal(patchPrompt(mixed.calls), '雪夜的女孩');

  const empty = editRun(['[]'], { current: '雨夜的猫' });
  assert.equal((await empty.run).code, 1);
  assert.ok(empty.calls.length === 0, '空数组在本地就报错');
});

test('canvas node set --prompt --edit: ori_text 留空追加到结尾', async () => {
  const { calls, run } = editRun(['{"new_text":"，电影感光影"}'], { current: '一只猫' });
  const r = await run;
  assert.equal(r.code, 0);
  assert.equal(patchPrompt(calls), '一只猫，电影感光影');
  assert.deepEqual(JSON.parse(r.out).edits[0], { ori_text: '', new_text: '，电影感光影', count: 1 });
});

test('canvas node set --prompt --edit: 原文找不到就报错，不写', async () => {
  const { calls, run } = editRun(['{"ori_text":"雨夜","new_text":"雪夜"}'], { current: '一只猫' });
  const r = await run;
  assert.equal(r.code, 1);
  assert.equal(calls.length, 1, '只有读，没有写');
  assert.ok(r.err.includes('没找到要改的原文'));
  assert.ok(r.err.includes('一只猫'), '要顺手把节点里现在的内容给出来，好改 ori_text');
});

test('canvas node set --prompt --edit: 出现多处要先加 --all', async () => {
  const dup = '雨夜，雨夜的街道';
  const ambiguous = await editRun(['{"ori_text":"雨夜","new_text":"雪夜"}'], { current: dup }).run;
  assert.equal(ambiguous.code, 1);
  assert.ok(ambiguous.err.includes('出现了 2 次'));
  assert.ok(ambiguous.err.includes('--all'));

  const { calls, run } = editRun(['{"ori_text":"雨夜","new_text":"雪夜"}'], { current: dup, args: ['--all'] });
  const all = await run;
  assert.equal(all.code, 0);
  assert.equal(patchPrompt(calls), '雪夜，雪夜的街道');
  assert.deepEqual(JSON.parse(all.out).edits[0], { ori_text: '雨夜', new_text: '雪夜', count: 2 });
});

test('canvas node set --prompt --edit: 改动清单可以放在 json 文件里', async () => {
  const file = path.join(os.tmpdir(), `innate-edit-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify([{ ori_text: '雨夜', new_text: '雪夜' }, { ori_text: '猫', new_text: '女孩' }]));
  try {
    const { calls, run } = editRun([file], { current: '雨夜的猫' });
    const r = await run;
    assert.equal(r.code, 0);
    assert.equal(patchPrompt(calls), '雪夜的女孩');
  } finally {
    fs.unlinkSync(file);
  }
});

test('canvas node set --prompt --edit 的参数不对：缺目标字段、同时给值、JSON 不合法都报错且不发请求', async () => {
  let called = 0;
  const fetchOnce = async () => { called += 1; return makeRes(200, {}); };

  const noTarget = await runMain(['canvas', 'node', 'set', 'cv1', 'n-3', '--edit', '{"ori_text":"a","new_text":"b"}'], fetchOnce);
  assert.equal(noTarget.code, 1);
  assert.ok(noTarget.err.includes('--prompt 或 --text'));

  const withValue = await runMain(['canvas', 'node', 'set', 'cv1', 'n-3', '--prompt', '整段新提示词', '--edit', '{"ori_text":"a","new_text":"b"}'], fetchOnce);
  assert.equal(withValue.code, 1);
  assert.ok(withValue.err.includes('别同时给'));

  const badJson = await runMain(['canvas', 'node', 'set', 'cv1', 'n-3', '--prompt', '--edit', '{ori_text:'], fetchOnce);
  assert.equal(badJson.code, 1);
  assert.ok(badJson.err.includes('不是合法 JSON'));

  const noNew = await runMain(['canvas', 'node', 'set', 'cv1', 'n-3', '--prompt', '--edit', '{"ori_text":"a"}'], fetchOnce);
  assert.equal(noNew.code, 1);
  assert.ok(noNew.err.includes('new_text'));

  assert.equal(called, 0, '参数不对就在本地报错，别去撞服务');
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

// ---------- 节点输入 / 取文件 ----------
const INPUTS = {
  canvas: 'cv1',
  node: { id: 'v1', type: 'video', no: 1, model: 'doubao-seedance-2-5-260628', prompt: '动起来', text: null },
  content: null,
  inputs: [
    { role: 'text', roleLabel: '文本', from: 't1', type: 'text', no: 1, text: '镜头推进', ready: true, note: '会拼在提示词前面' },
    { role: 'first', roleLabel: '首帧', from: 'i1', type: 'image', no: 1, via: 'upload', localPath: '/abs/uploads/up_1.png', exists: true, bytes: 2048, ready: true },
  ],
};

// 三种写法都要打到同一个接口：get <cv> <n> inputs、get inputs <cv> <n>、--inputs。
async function inputsRun(args) {
  const calls = [];
  const r = await runMain(args, async (u, init) => {
    calls.push({ u, init });
    return makeRes(200, INPUTS);
  });
  return { calls, r };
}

for (const [label, args] of [
  ['get <画布> <节点> inputs', ['canvas', 'node', 'get', 'cv1', 'v1', 'inputs']],
  ['get inputs <画布> <节点>', ['canvas', 'node', 'get', 'inputs', 'cv1', 'v1']],
  ['--inputs', ['canvas', 'node', 'get', 'cv1', 'v1', '--inputs']],
]) {
  test(`canvas node get 的输入视角（${label}）：只读一次 /inputs`, async () => {
    const { calls, r } = await inputsRun(args);
    assert.equal(r.code, 0);
    assert.equal(calls.length, 1);
    assert.match(calls[0].u, /\/api\/canvases\/cv1\/nodes\/v1\/inputs$/);
    // 人读的输出里要有路径，这是这个命令存在的理由。
    assert.ok(r.out.includes('/abs/uploads/up_1.png'), r.out);
    assert.ok(r.out.includes('首帧'));
    assert.ok(r.out.includes('镜头推进'));
  });
}

test('canvas node get 不带 inputs 时还是读整个节点', async () => {
  const calls = [];
  const r = await runMain(['canvas', 'node', 'get', 'cv1', 'v1'], async (u, init) => {
    calls.push({ u, init });
    return makeRes(200, { id: 'v1', type: 'video', data: { prompt: '动起来' } });
  });
  assert.equal(r.code, 0);
  assert.match(calls[0].u, /\/api\/canvases\/cv1\/nodes\/v1$/);
  assert.ok(!calls[0].u.includes('/inputs'));
});

test('canvas node get ... inputs --json: 原始数据带 role/roleLabel/localPath', async () => {
  const { r } = await inputsRun(['canvas', 'node', 'get', 'cv1', 'v1', 'inputs', '--json']);
  const out = JSON.parse(r.out);
  assert.equal(out.nodeAction, 'inputs');
  assert.equal(out.inputs.length, 2);
  assert.equal(out.inputs[1].localPath, '/abs/uploads/up_1.png');
});

test('media: 记录 id 换成路径，本机有文件就不复制', async () => {
  const calls = [];
  const r = await runMain(['media', 'img1'], async (u, init) => {
    calls.push({ u, init });
    return makeRes(200, { record: 'img1', kind: 'image', recordId: 'img1', localPath: '/abs/images/img1.jpg', exists: true, bytes: 1024, mediaUrl: '/media/images/img1.jpg' });
  });
  assert.equal(r.code, 0);
  assert.match(calls[0].u, /\/api\/media\?record=img1$/);
  // 第一行就是路径，脚本里可以直接取。
  assert.equal(r.out.split('\n')[0], '/abs/images/img1.jpg');
  assert.ok(r.out.includes('本机原文件'));
});

test('media: /media 地址也能问，--out 时复制到指定目录', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innate-media-'));
  const src = path.join(dir, 'src.png');
  fs.writeFileSync(src, 'png-bytes');
  try {
    const out = path.join(dir, 'out');
    const calls = [];
    const r = await runMain(['media', '/media/uploads/up_1.png', '--out', out], async (u, init) => {
      calls.push({ u, init });
      return makeRes(200, { url: '/media/uploads/up_1.png', name: 'up_1.png', kind: 'image', localPath: src, exists: true, bytes: 9 });
    });
    assert.equal(r.code, 0);
    assert.match(calls[0].u, /\/api\/media\?url=%2Fmedia%2Fuploads%2Fup_1.png$/);
    const copied = path.join(out, 'up_1.png');
    assert.equal(fs.readFileSync(copied, 'utf8'), 'png-bytes');
    assert.equal(r.out.split('\n')[0], copied);
    assert.ok(r.out.includes('已复制'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('media: 拿不到文件时报错，不给一个假的路径', async () => {
  const r = await runMain(['media', 'img_nope'], async () => makeRes(200, { record: 'img_nope', localPath: null, exists: false, note: '生成记录已不存在（可能被删掉了）' }));
  assert.equal(r.code, 1);
  assert.ok(r.err.includes('生成记录已不存在'));
});

test('media: 服务端给的本机路径在别的机器上不存在时，改走下载', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innate-media-'));
  try {
    const fetched = [];
    const r = await runMain(['media', 'img1', '--out', dir], async (u, init) => {
      const p = new URL(u);
      if (p.pathname === '/api/media') return makeRes(200, { recordId: 'img1', kind: 'image', localPath: '/nowhere/on/this/machine/img1.jpg', exists: true, mediaUrl: '/media/images/img1.jpg' });
      fetched.push(u);
      return { ok: true, status: 200, statusText: '200', text: async () => '', arrayBuffer: async () => Buffer.from('downloaded') };
    });
    assert.equal(r.code, 0);
    assert.equal(fetched.length, 1, '复制失败要退回下载');
    assert.match(fetched[0], /\/media\/images\/img1.jpg$/);
    assert.equal(fs.readFileSync(path.join(dir, 'img1.jpg'), 'utf8'), 'downloaded');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
