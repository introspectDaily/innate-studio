// 打印「这一组参数会发给 RunningHub 的 nodeInfoList」——不提交、不花钱、不会跑任务。
// 用来在真跑之前核对：画质档套对没有、分辨率和帧数是多少、分块改到哪了。
//
// 用法：
//   node docs/runninghub/plan-params.mjs                          # 默认参数
//   node docs/runninghub/plan-params.mjs --preset "省显存（24G 保底）"
//   node docs/runninghub/plan-params.mjs --video-seconds 8 --ff-chunks 8 --attn-head-chunks 16
//   node docs/runninghub/plan-params.mjs --workflow hailuo-h3-swap-9 --dry
//
// --dry 只打印上面这张表；不给 --dry 时会把 nodeInfoList 整个打出来（带素材位和提示词），
// 那份就是 POST /api/runninghub/submit 的 api.json 里 nodeInfoList 的内容。

import { rhPlan, rhRules, rhWorkflow } from '../../shared/runninghub.ts';

const args = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const next = args[at + 1];
  return next && !next.startsWith('--') ? next : true;
};
const has = (name) => args.includes(`--${name}`);

const workflowKey = String(flag('workflow', 'hailuo-h3-swap-9'));
const workflow = rhWorkflow(workflowKey);
if (!workflow) {
  console.error(`没有登记这个工作流：${workflowKey}`);
  process.exit(1);
}

// 参数键 → 命令行开关名。和 shared/runninghub.ts 的 HAILUO_PARAMS 对得上。
const PARAMS = ['megapixels', 'upscale_megapixels', 'video_seconds', 'ff_chunks', 'ff_seq_threshold', 'attn_head_chunks', 'shorter_edge', 'steps', 'seed'];
const inputs = { prompt: '（提示词）', ref_image_0: '/media/uploads/ref1.png', ref_video_0: '/media/uploads/source.mp4' };
for (const key of PARAMS) {
  const value = flag(key.replace(/_/g, '-'));
  if (value !== undefined) inputs[key] = Number(value);
}
for (const [flagName, key] of [['upscaler-chunking', 'upscaler_chunking'], ['upscaler-force-unload', 'upscaler_force_unload'], ['save-first-pass', 'save_first_pass']]) {
  const value = flag(flagName);
  if (value !== undefined) inputs[key] = value !== 'false' && value !== '0';
}
const preset = flag('preset');
if (preset !== undefined) inputs.preset = preset;
const machine = flag('machine');
if (machine !== undefined) inputs.machine = machine;

// --source-duration 模拟「服务端量到了原视频时长」：不传 video_seconds 时默认与它一致。
const sourceDuration = Number(flag('source-duration', 0)) || 0;
const plan = rhPlan(workflow, inputs, sourceDuration > 0 ? { videoDuration: sourceDuration } : {});
if (plan.problems.length) {
  console.log('提交会被拦下：');
  for (const problem of plan.problems) console.log('  -', problem);
}

// 节点 → 这个节点上我们会改的字段。
const NODES = {
  '209': '一采分辨率选择',
  '247': '二采放大像素',
  '286': '加载视频（frame_load_cap）',
  '201': '分块前馈（二采）',
  '277': '分块前馈（一采）',
  '202': '低显存注意力（二采）',
  '206': '二采潜空间放大',
  '271': '一次采样输出',
  '212': '采样步数',
  '205': '随机种子',
  '246': '参考图短边',
};
const value = (nodeId, field) => plan.nodeInfoList.find((item) => item.nodeId === nodeId && item.fieldName === field)?.fieldValue;

console.log('\n这次会跑成什么样');
console.log('  画质档        ', plan.inputs.preset ?? '自定义');
console.log('  机器          ', plan.machine);
console.log('  一采分辨率    ', value('209', 'megapixels'), '百万像素');
console.log('  二采分辨率    ', value('247', 'value'), '百万像素');
console.log('  输出时长      ', plan.inputs.video_seconds, '秒（', value('286', 'frame_load_cap'), '帧，24fps ）');
console.log('  FFN 分块/阈值 ', value('201', 'chunks'), '/', value('201', 'seq_threshold'), '（二采）　', value('277', 'chunks'), '/', value('277', 'seq_threshold'), '（一采）');
console.log('  注意力分组    ', value('202', 'head_chunks'));
console.log('  放大分块/卸载 ', value('206', 'enable_chunking'), '/', value('206', 'force_unload'));
console.log('  采样步数/种子 ', value('212', 'steps'), '/', value('205', 'noise_seed'));

if (has('dry')) {
  console.log('\n（--dry：到这儿为止，不提交）');
} else {
  console.log('\nnodeInfoList：');
  console.log(JSON.stringify(plan.nodeInfoList, null, 2));
}

// 粗略的显存提示：token 数 ∝ 帧数 × 面积（海螺 H3 是音视频一体模型）。
const mp = Number(value('209', 'megapixels') ?? 0.5);
const frames = Number(value('286', 'frame_load_cap') ?? 0);
console.log('\n粗算：一采', mp, 'MP', frames ? `× ${frames} 帧（约 ${Math.round((frames / 24) * 10) / 10} 秒）` : '× 整段视频', '→ 24G 机器上帧数建议 ≤ 120');
