// RunningHub：Key 文件的几种写法、登记表编译成规则、槽位和参数拼成 nodeInfoList。都是纯函数，不碰网络。

import test from 'node:test';
import assert from 'node:assert/strict';
import { drop, parseKeys, pick, resolveWorkflowId, resolveWorkflowIds, rhBaseUrl } from '../server/runninghub.js';
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
