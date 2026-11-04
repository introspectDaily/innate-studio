// RunningHub：Key 文件的几种写法、登记表编译成规则、槽位和参数拼成 nodeInfoList。都是纯函数，不碰网络。

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { drop, parseAccountStatus, parseKeys, pick, rankKeys, resolveWorkflowId, resolveWorkflowIds, rhBaseUrl, rhKeyState } from '../server/runninghub.js';
import { RH_WORKFLOWS, rhCost, rhMachines, rhMedia, rhPlan, rhRules, rhSiteOf, rhWorkflow, rhUuid } from '../shared/runninghub.ts';
import { flowInputs, flowVideoSpec, formValues } from '../shared/autodl.ts';

const SWAP = rhWorkflow('hailuo-h3-swap');

test('Key 文件：字符串数组', () => {
  const { keys, error } = parseKeys(JSON.stringify(['rh-a', 'rh-b']));
  assert.equal(error, '');
  assert.deepEqual(keys.map((key) => key.title), ['Key 1', 'Key 2']);
  // 没写并发就是 1。
  assert.deepEqual(keys.map((key) => key.concurrency), [1, 1]);
  // 完整 Key 不出现在返回里，只给头尾。
  assert.equal(keys[0].key, 'rh-a');
  assert.equal(keys[0].hint, '…');
});

test('Key 文件：带标题和并发、混着字符串', () => {
  const { keys } = parseKeys(JSON.stringify([{ title: '主账号', key: 'rh-aaaaaaaa', concurrency: 3 }, 'rh-bbbbbbbb', { key: 'rh-cccccccc' }]));
  assert.deepEqual(keys.map((key) => key.title), ['主账号', 'Key 2', 'Key 3']);
  assert.deepEqual(keys.map((key) => key.concurrency), [3, 1, 1]);
  assert.equal(keys[0].hint, 'rh-a…aaaa');
});

test('Key 文件：{keys: []}、去重、临时下线、坏 JSON', () => {
  const wrapped = parseKeys(JSON.stringify({ keys: [{ key: 'rh-a' }, { key: 'rh-a' }, { key: 'rh-b', enabled: false }] }));
  assert.deepEqual(wrapped.keys.map((key) => key.title), ['Key 1']);
  assert.equal(parseKeys('{').error, 'Key 文件不是合法的 JSON');
  assert.deepEqual(parseKeys('{"foo": 1}').keys, []);
});

test('Key 的 id 只跟 Key 本身有关：改了标题、换了顺序也不变', () => {
  const one = parseKeys(JSON.stringify([{ title: '旧名字', key: 'rh-same' }])).keys[0];
  const two = parseKeys(JSON.stringify(['rh-other', { title: '新名字', key: 'rh-same' }])).keys[1];
  assert.equal(one.id, two.id);
});

test('站点：只认 ai / cn，贴域名也认，写错的那条跳过并说明原因', () => {
  const { keys, error } = parseKeys(
    JSON.stringify([
      { key: 'rh-aaaaaaaa', site: 'cn' },
      { key: 'rh-bbbbbbbb', site: 'ai' },
      { key: 'rh-cccccccc' }, // 没写就用默认站点（RUNNINGHUB_SITE，默认 cn）
      { key: 'rh-dddddddd', site: 'https://www.runninghub.ai' }, // 直接贴地址也认
      { key: 'rh-eeeeeeee', site: 'us' }, // 枚举之外：这条不要
    ]),
  );
  assert.deepEqual(keys.map((key) => key.site), ['cn', 'ai', 'cn', 'ai']);
  assert.equal(error, '有 1 个 Key 没读进来：第 5 个 Key 的 site「us」不是 ai / cn');
  // 归一函数本身：大小写、空格、域名都收，其他一律空串。
  assert.equal(rhSiteOf(' AI '), 'ai');
  assert.equal(rhSiteOf('https://www.runninghub.cn/'), 'cn');
  assert.equal(rhSiteOf('us'), '');
  assert.equal(rhSiteOf(''), '');
});

test('请求地址按站点走：国内站 .cn、海外站 .ai', () => {
  assert.equal(rhBaseUrl('cn'), 'https://www.runninghub.cn');
  assert.equal(rhBaseUrl('ai'), 'https://www.runninghub.ai');
  // 没给站点（老记录、单 Key 模式）就按默认站点。
  assert.equal(rhBaseUrl(''), 'https://www.runninghub.cn');
});

test('工作流 ID 按站点取：分站变量 > 通用变量 > 登记表里按站点写的对象', () => {
  const workflow = { key: 'demo-flow', name: '演示', summary: '', kind: 'video', workflowId: { cn: '111', ai: '222' } };
  assert.equal(resolveWorkflowId(workflow, 'cn'), '111');
  assert.equal(resolveWorkflowId(workflow, 'ai'), '222');
  assert.deepEqual(resolveWorkflowIds(workflow), { cn: '111', ai: '222' });
  // 通用变量盖住两个站，分站变量再盖住自己那一站。
  process.env.RUNNINGHUB_WORKFLOW_DEMO_FLOW = '999';
  assert.equal(resolveWorkflowId(workflow, 'cn'), '999');
  assert.equal(resolveWorkflowId(workflow, 'ai'), '999');
  process.env.RUNNINGHUB_WORKFLOW_DEMO_FLOW_AI = '888';
  assert.equal(resolveWorkflowId(workflow, 'ai'), '888');
  assert.equal(resolveWorkflowId(workflow, 'cn'), '999');
  delete process.env.RUNNINGHUB_WORKFLOW_DEMO_FLOW;
  delete process.env.RUNNINGHUB_WORKFLOW_DEMO_FLOW_AI;
});

test('挑 Key 按站点过滤：只有配了该工作流 ID 的站点才接单', async () => {
  process.env.RUNNINGHUB_KEYS = JSON.stringify([
    { key: 'rh-cn-00000000', site: 'cn' },
    { key: 'rh-ai-00000000', site: 'ai' },
  ]);
  try {
    const cnOnly = { key: 'demo-route', name: '路由演示', summary: '', kind: 'video', workflowId: { cn: '111' } };
    const cnLease = await pick(cnOnly, 0);
    assert.equal(cnLease.site, 'cn');
    drop(cnLease);

    // 只在海外站配了 ID 的工作流，只会挑到海外的 Key。
    const aiOnly = { ...cnOnly, key: 'demo-route-ai', workflowId: { ai: '222' } };
    const aiLease = await pick(aiOnly, 0);
    assert.equal(aiLease.site, 'ai');
    drop(aiLease);

    // 一个站都没配：直接说清缺什么，而不是先提交再吃一个 380。
    await assert.rejects(
      () => pick({ ...cnOnly, key: 'demo-missing', workflowId: {} }, 0),
      (err) => err.status === 503 && /没有配置工作流 ID/.test(err.message),
    );
  } finally {
    delete process.env.RUNNINGHUB_KEYS;
  }
});

// ---------- 账户余额与「余额多的优先」路由 ----------
// 这几个 Key 只用来排顺序，不碰网络。
const rankItems = (...ids) => ids.map((id) => ({ id, title: id }));
const rankOrder = (list) => list.map((item) => item.id);

test('账户状态：认字符串数字，null 不能当成 0 币', () => {
  assert.deepEqual(parseAccountStatus({ remainCoins: '10351', currentTaskCounts: '0' }), { running: 0, coins: 10351 });
  assert.deepEqual(parseAccountStatus({ remainCoins: 12.5, currentTaskCounts: 3 }), { running: 3, coins: 12.5 });
  // remainMoney 就是 null；把 null 当 0 会把这个 Key 误判成「余额耗尽」。
  assert.deepEqual(parseAccountStatus({ remainCoins: null, currentTaskCounts: null, remainMoney: null }), { running: null, coins: null });
  assert.deepEqual(parseAccountStatus({ remainCoins: 'n/a', currentTaskCounts: '-1' }), { running: 0, coins: null });
  assert.deepEqual(parseAccountStatus(null), { running: null, coins: null });
});

test('按剩余积分排优先级：多的先用，同分按轮转', () => {
  const free = rankItems('a', 'b', 'c');
  const coins = new Map([['a', 10], ['b', 500], ['c', 80]]);
  assert.deepEqual(rankOrder(rankKeys(free, { coins })), ['b', 'c', 'a']);
  const even = new Map(free.map((item) => [item.id, 100]));
  assert.deepEqual(rankOrder(rankKeys(free, { coins: even, cursor: 0 })), ['a', 'b', 'c']);
  assert.deepEqual(rankOrder(rankKeys(free, { coins: even, cursor: 1 })), ['b', 'c', 'a']);
  assert.deepEqual(rankOrder(rankKeys([], { coins })), []);
});

test('查不到余额的按最低已知值参与，不会饿死；一个都没查到就退回轮转', () => {
  const free = rankItems('a', 'b', 'c', 'd');
  const coins = new Map([['a', 1000], ['b', 100], ['c', 900]]); // d 没问到
  // d 按 100 算，和 b 同分，按原顺序排在 b 后面。
  assert.deepEqual(rankOrder(rankKeys(free, { coins })), ['a', 'c', 'b', 'd']);
  assert.deepEqual(rankOrder(rankKeys(free, { coins: new Map(), cursor: 2 })), ['c', 'd', 'a', 'b']);
  // 关掉积分路由就是原来的轮转。
  assert.deepEqual(rankOrder(rankKeys(free, { coins, byCoins: false, cursor: 1 })), ['b', 'c', 'd', 'a']);
});

test('别的 Key 还有余额就不挑耗尽的；全都耗尽时照常轮转，让平台自己判 416', () => {
  const free = rankItems('a', 'b', 'c');
  assert.deepEqual(rankOrder(rankKeys(free, { coins: new Map([['a', 0], ['b', 50], ['c', 20]]) })), ['b', 'c']);
  assert.deepEqual(rankOrder(rankKeys(free, { coins: new Map([['a', 0], ['b', 0], ['c', 0]]) })), ['a', 'b', 'c']);
});

test('同一批并发请求靠虚拟消耗摊到不同 Key，不会全挤到余额最高的那个', () => {
  const free = rankItems('a', 'b');
  const coins = new Map([['a', 1000], ['b', 990]]);
  const spent = new Map();
  const picks = [];
  for (let i = 0; i < 4; i += 1) {
    const chosen = rankKeys(free, { coins, spent, cursor: i })[0].id;
    picks.push(chosen);
    spent.set(chosen, (spent.get(chosen) || 0) + 10);
  }
  assert.deepEqual(picks, ['a', 'b', 'a', 'b']);
});

test('提交时按余额挑 Key：积分多的优先，耗尽的先不派；站点过滤仍然生效', async () => {
  process.env.RUNNINGHUB_KEYS = JSON.stringify([
    { key: 'rh-low-0000000', site: 'cn' },
    { key: 'rh-high-000000', site: 'cn' },
    { key: 'rh-ai-00000000', site: 'ai' },
  ]);
  try {
    const [low, high, ai] = parseKeys(process.env.RUNNINGHUB_KEYS).keys;
    const both = { key: 'demo-coins', name: '余额路由', summary: '', kind: 'video', workflowId: { cn: '111', ai: '222' } };
    const coins = new Map([[low.id, 10], [high.id, 9999], [ai.id, 50000]]);

    // 海外 Key 余额最高，但这个工作流只在国内站配了 id：不能因为它钱多就跨站点派过去。
    const cnOnly = { ...both, key: 'demo-coins-cn', workflowId: { cn: '111' } };
    const lease = await pick(cnOnly, 0, { coins, spent: new Map() });
    assert.equal(lease.title, high.title);
    assert.equal(lease.site, 'cn');
    drop(lease);

    // 高余额那个耗光了，剩下的国内 Key 才接单。
    const drained = new Map([[low.id, 10], [high.id, 0], [ai.id, 50000]]);
    const second = await pick(cnOnly, 0, { coins: drained, spent: new Map() });
    assert.equal(second.title, low.title);
    drop(second);

    // 两个站点都配了 id 时，余额最高的海外 Key 就能接单了。
    const third = await pick(both, 0, { coins, spent: new Map() });
    assert.equal(third.site, 'ai');
    assert.equal(third.title, ai.title);
    drop(third);
  } finally {
    delete process.env.RUNNINGHUB_KEYS;
  }
});

test('端到端：平台返回的余额进快照，面板能看到，路由也照它挑 Key', async () => {
  process.env.RUNNINGHUB_KEYS = JSON.stringify([
    { key: 'rh-poor-00000', site: 'cn' },
    { key: 'rh-rich-00000', site: 'cn' },
    { key: 'rh-bad-000000', site: 'cn' },
  ]);
  // 只拦 accountStatus：富号 900 币、穷号 100 币、坏号直接回平台的 806，不真发网络请求。
  mock.method(globalThis, 'fetch', async (_url, init) => {
    const { apiKey } = JSON.parse(init.body);
    const payload = apiKey === 'rh-bad-000000'
      ? { code: 806, msg: 'API Key不存在' }
      : {
          code: 0,
          msg: 'success',
          data: {
            remainCoins: apiKey === 'rh-rich-00000' ? '900' : '100',
            currentTaskCounts: apiKey === 'rh-rich-00000' ? '1' : '0',
            remainMoney: null,
            currency: null,
            apiType: 'NORMAL',
          },
        };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    const state = await rhKeyState({ force: true });
    assert.deepEqual(state.keys.map((item) => item.coins), [100, 900, null]);
    assert.deepEqual(state.keys.map((item) => item.coinsMeasured), ['platform', 'platform', 'unknown']);
    assert.equal(state.keys[1].running, 1);
    assert.equal(state.keys[2].running, 0); // 平台没问到，回落本地计数
    assert.equal(state.coins.total, 1000);
    assert.equal(state.coins.spread, 800);
    assert.equal(state.coins.unknown, 1);
    assert.equal(state.live.ok, true);
    assert.match(state.live.error, /1 个 Key 没问到平台状态/);

    // 这份快照被路由直接用：不传 options.coins，也应该挑中余额多的那个。
    const workflow = { key: 'demo-live', name: '实时余额', summary: '', kind: 'video', workflowId: { cn: '111' } };
    const lease = await pick(workflow, 0);
    assert.equal(lease.title, 'Key 2');
    drop(lease);
  } finally {
    mock.restoreAll();
    delete process.env.RUNNINGHUB_KEYS;
  }
});

test('登记表：海螺 H3 的三个图片位、要两张、可选机器三档', () => {
  assert.ok(SWAP);
  assert.equal(SWAP.images.length, 3);
  assert.equal(SWAP.minImages, 2);
  assert.deepEqual(rhMachines(SWAP).map((machine) => machine.value), ['default', 'plus', 'ultra']);
  assert.deepEqual(rhMedia(SWAP), ['image', 'video']);
  assert.equal(rhUuid(SWAP.key), 'rh:hailuo-h3-swap');
});

test('登记表编译成规则：必填按 minImages 算，机器是一档下拉', () => {
  const rules = rhRules(SWAP);
  assert.equal(rules.ref_image_0.required, true);
  assert.equal(rules.ref_image_1.required, true);
  assert.equal(rules.ref_image_2.required, false);
  assert.equal(rules.ref_video_0.required, true);
  assert.equal(rules.prompt.type, 'prompt');
  assert.equal(rules.steps.type, 'integer');
  assert.equal(rules.megapixels.type, 'number');
  // 机器档位的默认值写的是标签，不是 instanceType 的值。
  assert.equal(rules.machine.default, '标准 24G');
  // 只有一个档位时不画这一项。
  assert.equal(rhRules({ ...SWAP, machines: ['default'] }).machine, undefined);
});

test('两张图也能提交：第三位复用第二张，不会把工作流里的测试图带进来', () => {
  const two = rhPlan(SWAP, { ref_image_0: '/media/uploads/a.png', ref_image_1: '/media/uploads/b.png', ref_video_0: '/media/uploads/v.mp4', prompt: '换成她' });
  assert.deepEqual(two.problems, []);
  const images = two.nodeInfoList.filter((item) => ['215', '218', '221'].includes(item.nodeId));
  assert.deepEqual(images.map((item) => item.fieldValue), ['/media/uploads/a.png', '/media/uploads/b.png', '/media/uploads/b.png']);
  assert.equal(two.machine, 'default');
  // 素材要在提交前换成平台的文件名，这里给出要传哪几个。
  assert.deepEqual(two.uploads.map((upload) => upload.key), ['ref_image_0', 'ref_image_1', 'ref_image_2', 'ref_video_0']);
});

test('只给一张图不提交；缺视频、缺提示词也不提交', () => {
  const one = rhPlan(SWAP, { ref_image_0: '/media/uploads/a.png', ref_video_0: '/media/uploads/v.mp4', prompt: 'x' });
  // 说法要落地到槽位本身（「请上传参考图 2」），不能是「请填写图片参考图 2」这种机器拼出来的。
  assert.deepEqual(one.problems, ['请上传参考图 2（至少 2 张）']);
  const noVideo = rhPlan(SWAP, { ref_image_0: 'a', ref_image_1: 'b', prompt: 'x' });
  assert.ok(noVideo.problems.some((problem) => problem.includes('原视频')));
  const noPrompt = rhPlan(SWAP, { ref_image_0: 'a', ref_image_1: 'b', ref_video_0: 'v' });
  assert.ok(noPrompt.problems.some((problem) => problem.includes('替换要求')));
});

test('参数：枚举发原值、数字发数字、机器档位换成 instanceType', () => {
  const plan = rhPlan(SWAP, {
    ref_image_0: 'a',
    ref_image_1: 'b',
    ref_video_0: 'v',
    prompt: '换成她',
    aspect_ratio: '9:16 竖屏',
    steps: '8',
    megapixels: '0.75',
    machine: '加强 48G',
  });
  assert.deepEqual(plan.problems, []);
  const value = (nodeId, field) => plan.nodeInfoList.find((item) => item.nodeId === nodeId && item.fieldName === field)?.fieldValue;
  assert.equal(value('209', 'aspect_ratio'), '9:16 (Portrait Widescreen)');
  assert.equal(value('212', 'steps'), 8);
  assert.equal(value('209', 'megapixels'), 0.75);
  assert.equal(value('248', 'value'), '换成她');
  assert.equal(plan.machine, 'plus');
  // 机器档位不是节点字段，不能出现在 nodeInfoList 里。
  assert.equal(plan.nodeInfoList.some((item) => item.fieldName === 'machine'), false);
});

test('价格跟着机器档位走', () => {
  assert.equal(rhCost(SWAP.key, {}), 0.5);
  assert.equal(rhCost(SWAP.key, { machine: '旗舰 84G' }), 2);
  assert.equal(rhCost('没有这个工作流'), null);
});

test('省显存的参数都在：一采/二采分辨率、时长、分块、注意力分组', () => {
  const plan = rhPlan(SWAP, {
    ref_image_0: 'a',
    ref_image_1: 'b',
    ref_video_0: 'v',
    prompt: '换成她',
    megapixels: 0.4,
    upscale_megapixels: 0.6,
    video_seconds: 3, // 3 秒 × 24fps = 72 帧
    ff_chunks: 8,
    ff_seq_threshold: 2048,
    attn_head_chunks: 16,
    upscaler_chunking: true,
    upscaler_force_unload: true,
  });
  const value = (nodeId, field) => plan.nodeInfoList.find((item) => item.nodeId === nodeId && item.fieldName === field)?.fieldValue;
  assert.equal(value('209', 'megapixels'), 0.4);
  assert.equal(value('247', 'value'), 0.6);
  assert.equal(value('286', 'frame_load_cap'), 72);
  assert.equal(value('202', 'head_chunks'), 16);
  assert.equal(value('206', 'enable_chunking'), true);
  assert.equal(value('206', 'force_unload'), true);
  // 分块前馈一采（277）和二采（201）各挂了一个，一个参数两个节点都要改到。
  assert.equal(value('201', 'chunks'), 8);
  assert.equal(value('277', 'chunks'), 8);
  assert.equal(value('201', 'seq_threshold'), 2048);
  assert.equal(value('277', 'seq_threshold'), 2048);
});

test('输出时长换算成帧数：按工作流的固定帧率（24）向上取整，记录里存秒数', () => {
  const plan = rhPlan(SWAP, { ref_image_0: 'a', ref_image_1: 'b', ref_video_0: 'v', prompt: 'x', video_seconds: 6.5 });
  const value = (nodeId, field) => plan.nodeInfoList.find((item) => item.nodeId === nodeId && item.fieldName === field)?.fieldValue;
  assert.equal(value('286', 'frame_load_cap'), 156); // 6.5 × 24 = 156
  assert.equal(plan.inputs.video_seconds, 6.5);
});

test('输出时长的默认值与原视频一致：没填时按量到的时长换算，超过滑块上限 13 秒的截掉', () => {
  const value = (plan) => plan.nodeInfoList.find((item) => item.nodeId === '286' && item.fieldName === 'frame_load_cap')?.fieldValue;
  // 8.2 秒的原视频：按 0.1 秒向上取整是 8.2 × 24fps = 196.8 → 197 帧，完整覆盖源片。
  const plan = rhPlan(SWAP, { ref_image_0: 'a', ref_image_1: 'b', ref_video_0: 'v', prompt: 'x' }, { videoDuration: 8.2 });
  assert.equal(value(plan), 197);
  assert.equal(plan.inputs.video_seconds, 8.2);
  // 8.04 秒：向上取整到 0.1 秒是 8.1（宁可多一帧也不丢结尾）。
  const odd = rhPlan(SWAP, { ref_image_0: 'a', ref_image_1: 'b', ref_video_0: 'v', prompt: 'x' }, { videoDuration: 8.04 });
  assert.equal(value(odd), 195); // 8.1 × 24 = 194.4 → 195
  assert.equal(odd.inputs.video_seconds, 8.1);
  // 45 秒的长片：夹到滑块上限 13 秒（312 帧），超出部分截掉。
  const long = rhPlan(SWAP, { ref_image_0: 'a', ref_image_1: 'b', ref_video_0: 'v', prompt: 'x' }, { videoDuration: 45 });
  assert.equal(value(long), 312);
  // 量不到时长（没有 ffmpeg / 远程链接）：落回登记表的默认值 5 秒。
  const fallback = rhPlan(SWAP, { ref_image_0: 'a', ref_image_1: 'b', ref_video_0: 'v', prompt: 'x' });
  assert.equal(value(fallback), 120);
});

test('显存防呆：帧数 × 二采分辨率超了机器预算只提醒不拦截，提示怎么调', () => {
  // 真实事故：13 秒源片 312 帧 × 1.0MP 在标准 24G 上 RuntimeError: VRAM grow failed（白扣一次钱）。
  const value = (plan) => plan.nodeInfoList.find((item) => item.nodeId === '286' && item.fieldName === 'frame_load_cap')?.fieldValue;
  const plan = rhPlan(SWAP, { ref_image_0: 'a', ref_image_1: 'b', ref_video_0: 'v', prompt: 'x', video_seconds: 13 });
  assert.equal(value(plan), 312);
  // 超预算只是提醒，不拦截：problems 为空，允许照常提交。
  assert.deepEqual(plan.problems, []);
  assert.ok(plan.warnings.some((warning) => warning.includes('显存溢出') && warning.includes('312 帧')), plan.warnings.join('；'));
  // 提示要能照着调：给出降时长、降分辨率、换机器三条路。
  assert.ok(plan.warnings[0].includes('加强 48G'));
  // 同样的参数换 48G 机器就放行。
  const plus = rhPlan(SWAP, { ref_image_0: 'a', ref_image_1: 'b', ref_video_0: 'v', prompt: 'x', video_seconds: 13, machine: '加强 48G' });
  assert.deepEqual(plus.problems, []);
  // 默认 5 秒（120 帧 × 1.0MP = 120）正好压线放行。
  const fit = rhPlan(SWAP, { ref_image_0: 'a', ref_image_1: 'b', ref_video_0: 'v', prompt: 'x' });
  assert.deepEqual(fit.problems, []);
  // 省显存档把二采压到 0.5MP，13 秒也能过预算（312 × 0.5 = 156）……不，超 120，同样要拦。
  const safe = rhPlan(SWAP, { ref_image_0: 'a', ref_image_1: 'b', ref_video_0: 'v', prompt: 'x', video_seconds: 13, upscale_megapixels: 0.5 });
  assert.ok(safe.warnings.some((warning) => warning.includes('显存溢出')));
});

test('画质档：一选就把一整套推荐值套上去', () => {
  const rules = rhRules(SWAP);
  // 画质档本身是规则里的一格（下拉），默认「自定义」。
  assert.equal(rules.preset.type, 'enum');
  assert.equal(rules.preset.default, '自定义');
  assert.ok(rules.preset.options.some((option) => option.label === '省显存（24G 保底）'));

  const plan = rhPlan(SWAP, { ref_image_0: 'a', ref_image_1: 'b', ref_video_0: 'v', prompt: 'x', preset: '省显存（24G 保底）' });
  const value = (nodeId, field) => plan.nodeInfoList.find((item) => item.nodeId === nodeId && item.fieldName === field)?.fieldValue;
  assert.equal(value('209', 'megapixels'), 0.3);
  assert.equal(value('247', 'value'), 0.5);
  assert.equal(value('286', 'frame_load_cap'), 96); // 档里 4 秒 × 24fps
  assert.equal(value('201', 'chunks'), 4);
  assert.equal(value('277', 'chunks'), 4);
  assert.equal(value('201', 'seq_threshold'), 2048);
  assert.equal(value('202', 'head_chunks'), 8);
  assert.equal(value('206', 'enable_chunking'), true);
});

test('画质档不覆盖用户自己改过的参数', () => {
  const plan = rhPlan(SWAP, {
    ref_image_0: 'a',
    ref_image_1: 'b',
    ref_video_0: 'v',
    prompt: 'x',
    preset: '省显存（24G 保底）',
    megapixels: 0.8, // 用户手动抬高一采分辨率
    ff_chunks: 16, // 用户手动把分块调大
  });
  const value = (nodeId, field) => plan.nodeInfoList.find((item) => item.nodeId === nodeId && item.fieldName === field)?.fieldValue;
  assert.equal(value('209', 'megapixels'), 0.8);
  assert.equal(value('201', 'chunks'), 16);
  assert.equal(value('277', 'chunks'), 16);
  // 没动过的还是按档走。
  assert.equal(value('202', 'head_chunks'), 8);
  // 记录里存的是实际跑的值。
  assert.equal(plan.inputs.megapixels, 0.8);
});

test('画质档在创作页也生效：那页每个参数都带着默认值上来', () => {
  const rules = rhRules(SWAP);
  const values = formValues({ input_rules: rules });
  assert.equal(values.preset, '自定义');
  const { inputs } = flowInputs(rules, {
    prompt: '换成她',
    media: [
      { kind: 'image', url: '/media/uploads/a.png' },
      { kind: 'image', url: '/media/uploads/b.png' },
      { kind: 'video', url: '/media/uploads/v.mp4' },
    ],
    extra: { ...values, preset: '省显存（24G 保底）' },
  });
  const plan = rhPlan(SWAP, inputs);
  const value = (nodeId, field) => plan.nodeInfoList.find((item) => item.nodeId === nodeId && item.fieldName === field)?.fieldValue;
  assert.equal(value('209', 'megapixels'), 0.3);
  assert.equal(value('202', 'head_chunks'), 8);
});

test('页面没带的参数，用登记表里的默认值补上', () => {
  // 画布那边只有用户动过的参数会带过来（没带的就落回平台保存的那份工作流，
  // 而那份的 286.frame_load_cap 是 0 = 整段视频，一漏传就又走回 OOM 那条路）。
  // 输出时长量不到原视频时是登记表的默认值 5 秒（120 帧）；量到了就走「与原视频一致」那条路（上面测过）。
  const plan = rhPlan(SWAP, { ref_image_0: 'a', ref_image_1: 'b', ref_video_0: 'v', prompt: 'x' });
  const value = (nodeId, field) => plan.nodeInfoList.find((item) => item.nodeId === nodeId && item.fieldName === field)?.fieldValue;
  assert.equal(value('286', 'frame_load_cap'), 120);
  assert.equal(value('247', 'value'), 1);
  assert.equal(value('209', 'megapixels'), 0.5);
  assert.equal(value('209', 'aspect_ratio'), '16:9 (Widescreen)');
  assert.equal(value('271', 'save_output'), true);
  assert.equal(value('201', 'chunks'), 2);
  // 记录里存的是实际跑的值。
  assert.equal(plan.inputs.video_seconds, 5);
});

test('每个登记的工作流都能编译出规则，键不重复', () => {
  const seen = new Set();
  for (const workflow of RH_WORKFLOWS) {
    assert.equal(seen.has(workflow.key), false, `重复的 key：${workflow.key}`);
    seen.add(workflow.key);
    const rules = rhRules(workflow);
    assert.ok(Object.keys(rules).length > 0, `${workflow.key} 没编译出规则`);
    // 素材位的 nodeId + 字段不能重复，否则后一个会盖掉前一个。
    const slots = [...(workflow.images || []), ...(workflow.videos || []), ...(workflow.audios || [])].map((slot) => `${slot.nodeId}:${slot.field}`);
    assert.equal(new Set(slots).size, slots.length, `${workflow.key} 有重复的素材位`);
  }
});

test('页面那套函数（表单初始值、拼入参、视频节点的参数范围）在 RunningHub 的规则上也能跑通', () => {
  const rules = rhRules(SWAP);
  // 创作页打开工作流时铺的初始值：枚举取默认的标签，素材留空。
  const values = formValues({ input_rules: rules });
  assert.equal(values.aspect_ratio, '16:9 横屏');
  assert.equal(values.steps, 6);
  assert.equal(values.machine, '标准 24G');
  assert.equal(values.ref_image_0, null);

  // 画布节点：连进来两张图和一段视频，再带上面板里选的参数。
  const { inputs, problems } = flowInputs(rules, {
    prompt: '把人物换成角色卡里的她',
    media: [
      { kind: 'image', url: '/media/uploads/a.png' },
      { kind: 'image', url: '/media/uploads/b.png' },
      { kind: 'video', url: '/media/uploads/v.mp4' },
    ],
    extra: { aspect_ratio: '9:16 竖屏', steps: 8, machine: '旗舰 84G' },
  });
  assert.deepEqual(problems, []);
  assert.equal(inputs.ref_image_1, '/media/uploads/b.png');
  assert.equal(inputs.machine, '旗舰 84G');

  // 同一组值交给服务端：第三张图复用第二张，机器档位换成 ultra。
  const plan = rhPlan(SWAP, inputs);
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.machine, 'ultra');
  assert.equal(plan.nodeInfoList.find((item) => item.nodeId === '221')?.fieldValue, '/media/uploads/b.png');

  // 视频节点的分辨率、时长下拉：这个流没有这两项，界面上就不出现（不会给出改了也没用的选项）。
  const spec = flowVideoSpec(rules);
  assert.deepEqual(spec.resolutions, []);
  assert.deepEqual(spec.durations, []);
  assert.deepEqual(spec.frames, []);
});
