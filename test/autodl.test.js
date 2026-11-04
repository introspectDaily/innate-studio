// AutoDL.art 的工作流：规则变表单、参数校验、按计费配置算价格。都是纯函数，不碰网络。
// 规则的样子按 2026-10-31 线上核对到的写（MiniMax H3 的几个、声纹克隆、动作迁移）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleDefault, requiredMedia, resolutionTier, stepPrice, workflowCost, cleanInputs, formValues, ruleKind, ruleLabel, durationOf, mediaAccepts, flowModelId, flowUuidOf, flowTextKey, flowMediaKeys, flowVideoSpec, isFlowModel, flowInputs, flowDisplayParams, isLongParam, paramIsLong } from '../shared/autodl.ts';
import { estimateCost, quoteCost, toCredits } from '../shared/models.ts';
import { rhRules, rhWorkflow } from '../shared/runninghub.ts';

const MINIMAX = {
  price_type: 'minimax_h3',
  billing_config: { minimax_h3: [{ resolution: '480p', price: 50, off_peak_price: 40 }, { resolution: '768p', price: 60, off_peak_price: 50 }, { resolution: '1088p', price: 70, off_peak_price: 60 }] },
  input_rules: {
    prompt: { type: 'string', required: true, min_length: 1, max_length: 20000 },
    duration: { type: 'integer', default: 5, min: 1, max: 15 },
    mode: { type: 'enum', default: '高质模式', options: [{ label: '高速模式', values: { '706.inputs.value': 1 } }, { label: '高质模式', values: { '706.inputs.value': 2 } }] },
    resolution: { type: 'enum', default: '768p竖(768*1376)', options: [{ label: '480p竖(480*864)' }, { label: '768p竖(768*1376)' }, { label: '1088p竖(1088*1920)' }] },
    seed: { type: 'integer', default: 803729153365684, min: 1, max: 999999999999999 },
    ref_image_0: { type: 'image', required: true, default: 'default_local_path:/blank.png;https://example.com/blank.png', accept_types: ['image/jpeg', 'image/png', 'image/webp'] },
    ref_image_1: { type: 'image', default: 'default_local_path:/blank.png;https://example.com/blank.png', accept_types: ['image/jpeg', 'image/png', 'image/webp'] },
  },
};

const TTS = {
  price_type: 'audio_sec_cost',
  billing_config: { audio_sec_cost: { price: 1, off_peak_price: 1, minimum_price: 10 } },
  input_rules: {
    prompt_text: { type: 'string', required: true, min_length: 1, max_length: 2048 },
    prompt_simple: { type: 'audio', required: true, accept_types: ['audio/mpeg', 'audio/wav'] },
    emo_control_method: { type: 'enum', required: true, default: '与音色参考音频相同', options: [{ label: '与音色参考音频相同' }, { label: '使用情感参考音频' }, { label: '使用情感向量控制' }] },
    emo_happy: { type: 'number', default: 0, min: 0, max: 1.4 },
    emo_random: { type: 'boolean', default: false },
    emo_ref_audio: { type: 'audio', accept_types: ['audio/mpeg', 'audio/wav'] },
  },
};

const RETARGET = {
  price_type: 'video_sec_cost',
  billing_config: { video_sec_cost: { price: 40, off_peak_price: 30 } },
  input_rules: {
    ref_image: { type: 'image', required: true, accept_types: ['image/jpeg', 'image/png', 'image/webp'] },
    ref_video: { type: 'video', required: true, accept_types: ['video/mp4', 'video/webm'] },
    resolution: { type: 'enum', default: '464*832px(竖版)', options: [{ label: '464*832px(竖版)' }, { label: '832*464px(横版)' }] },
    seed: { type: 'integer', default: 485581468409274, min: 1, max: 999999999999999 },
  },
};

test('默认值：占位的 media 默认值不填，enum 取第一项，开关是关，媒体空着', () => {
  assert.equal(ruleDefault(MINIMAX.input_rules.ref_image_0), undefined);
  assert.equal(ruleDefault(MINIMAX.input_rules.seed), 803729153365684);
  assert.equal(ruleDefault({ type: 'string', default: '  ' }), undefined);

  const values = formValues(MINIMAX);
  assert.equal(values.prompt, '');
  assert.equal(values.duration, 5);
  assert.equal(values.mode, '高质模式');
  assert.equal(values.ref_image_0, null);

  // 没有默认值的 enum 取第一项。
  assert.equal(formValues({ input_rules: { style: { type: 'enum', options: [{ label: '文戏' }, { label: '武戏' }] } } }).style, '文戏');
  assert.equal(formValues(TTS).emo_random, false);
});

test('素材规则：必填的媒体类型、能收的格式、界面用什么控件', () => {
  assert.deepEqual(requiredMedia(MINIMAX.input_rules), ['image']);
  assert.deepEqual(requiredMedia(TTS.input_rules), ['audio']);
  assert.deepEqual(requiredMedia(RETARGET.input_rules), ['image', 'video']);
  assert.deepEqual(requiredMedia({}), []);
  assert.deepEqual(mediaAccepts(TTS.input_rules.prompt_simple), ['audio/mpeg', 'audio/wav']);
  assert.deepEqual(mediaAccepts({ type: 'image' }), []);

  assert.equal(ruleKind(MINIMAX.input_rules.prompt), 'textarea');
  assert.equal(ruleKind({ type: 'string' }), 'text');
  assert.equal(ruleKind({ type: 'string', max_length: 400 }), 'textarea');
  assert.equal(ruleKind({ type: 'integer' }), 'number');
  assert.equal(ruleKind({ type: 'boolean' }), 'toggle');
  assert.equal(ruleKind({ type: 'enum' }), 'select');
  assert.equal(ruleKind({ type: 'image' }), 'media');
});

test('字段名写成人话：认识的有对照，带序号的按序号，其余原样', () => {
  assert.equal(ruleLabel({ type: 'string' }, 'prompt'), '提示词');
  assert.equal(ruleLabel({ type: 'string' }, 'prompt_text'), '朗读文本');
  assert.equal(ruleLabel({ type: 'image' }, 'ref_image_0'), '参考图1');
  assert.equal(ruleLabel({ type: 'image' }, 'ref_image_8'), '参考图9');
  assert.equal(ruleLabel({ type: 'audio' }, 'ref_audio_2'), '参考音频3');
  assert.equal(ruleLabel({ type: 'image' }, 'first_frame'), '首帧');
  assert.equal(ruleLabel({ type: 'string' }, 'something_new'), 'something_new');
  assert.equal(ruleLabel({ type: 'string', label: '平台的叫法' }, 'prompt'), '平台的叫法');
});

test('分辨率按开头的档位对：768p竖(768*1376) 是 768p，736p横 是 736p，认不出来是空', () => {
  assert.equal(resolutionTier('768p竖(768*1376)'), '768p');
  assert.equal(resolutionTier('736p横'), '736p');
  assert.equal(resolutionTier(' 480P '), '480p');
  assert.equal(resolutionTier('464*832px(竖版)'), '');
  assert.equal(resolutionTier(undefined), '');
});

test('计费：按分辨率、按秒、按秒带最低价，以及一口价', () => {
  assert.deepEqual(stepPrice(MINIMAX).tiers, [
    { tier: '480p', yuan: 0.5 },
    { tier: '768p', yuan: 0.6 },
    { tier: '1088p', yuan: 0.7 },
  ]);
  assert.deepEqual(stepPrice(RETARGET), { type: 'video_sec_cost', perSecond: 0.4 });
  assert.deepEqual(stepPrice(TTS), { type: 'audio_sec_cost', perSecond: 0.01, minimum: 0.1 });
  assert.deepEqual(stepPrice({ price: 40 }), { type: '', fixed: 0.4 });
  // 没写 price_type 时从 billing_config 的键看出来。
  assert.equal(stepPrice({ billing_config: { video_sec_cost: { price: 40 } } }).type, 'video_sec_cost');

  // MiniMax：按选的档位一口价，和时长无关。
  assert.equal(workflowCost(MINIMAX, { resolution: '768p竖(768*1376)', duration: 10 }), 0.6);
  assert.equal(workflowCost(MINIMAX, { resolution: '736p竖' }), null);
  // 动作迁移：每秒 0.4 元，时长看输入的视频。
  assert.equal(workflowCost(RETARGET, { duration: 8 }), 3.2);
  assert.equal(workflowCost(RETARGET, {}), null);
  // 声纹克隆：每秒 0.01 元，最低 0.1 元；没有给时长时按文字估（每秒 4.5 个字）。
  assert.equal(workflowCost(TTS, { prompt_text: '你好' }, 0), 0.1);
  assert.equal(workflowCost(TTS, { prompt_text: '你好' }, 30), 0.3);
  assert.equal(workflowCost(TTS, { prompt_text: '一'.repeat(450) }, 0), 1);
  // 一口价。
  assert.equal(workflowCost({ price: 40 }, {}), 0.4);
  assert.equal(workflowCost({ price: 0, price_type: '' }, {}), null);

  assert.equal(durationOf({ audio_duration: 6 }), 6);
  assert.equal(durationOf({ duration: 0, seconds: 3 }), 3);
  assert.equal(durationOf({}), 0);
});

test('校验：必填补默认、空项删掉、数字夹在范围里、枚举只能选给定的、不认识的参数拒掉', () => {
  const ok = cleanInputs(MINIMAX.input_rules, { prompt: '一只猫', ref_image_0: 'https://example.com/a.png' });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.inputs.prompt, '一只猫');
  assert.equal(ok.inputs.duration, 5);
  assert.equal(ok.inputs.mode, '高质模式');
  assert.equal(ok.inputs.seed, 803729153365684);
  // 没填的可选媒体删掉，不把占位当值发出去。
  assert.equal('ref_image_1' in ok.inputs, false);

  const missing = cleanInputs(MINIMAX.input_rules, {});
  assert.equal(missing.problems[0], '请填写提示词');
  assert.ok(missing.problems.some((p) => p === '请填写图片参考图1'));
  assert.ok(cleanInputs(TTS.input_rules, { prompt_text: '你好' }).problems.includes('请填写音频音色参考音频'));

  assert.deepEqual(cleanInputs(MINIMAX.input_rules, { prompt: '猫', ref_image_0: 'x', extra: 1 }).problems, ['多出的参数：extra']);
  assert.ok(cleanInputs(MINIMAX.input_rules, { prompt: '猫', ref_image_0: 'x', duration: 20 }).problems.includes('时长不能大于 15'));
  assert.ok(cleanInputs(MINIMAX.input_rules, { prompt: '猫', ref_image_0: 'x', mode: '快速模式' }).problems.includes('模式须从可选值里选'));
  assert.ok(cleanInputs(MINIMAX.input_rules, { prompt: '猫', ref_image_0: 'x', duration: 'abc' }).problems.includes('时长须为数字'));
  assert.ok(cleanInputs(TTS.input_rules, { prompt_text: '一'.repeat(2050), prompt_simple: 'x' }).problems.some((p) => p.startsWith('朗读文本不能超过 2048')));
  // 媒体只能是能发出去的字符串。
  assert.ok(cleanInputs(MINIMAX.input_rules, { prompt: '猫', ref_image_0: 42 }).problems.includes('参考图1须为文件或链接'));

  // 默认值补进来时也按规则收尾：布尔给真假，数字给数。
  const tts = cleanInputs(TTS.input_rules, { prompt_text: '你好', prompt_simple: 'data:audio/wav;base64,AAAA', emo_control_method: '使用情感参考音频', emo_happy: '0.8', emo_random: true });
  assert.deepEqual(tts.problems, []);
  assert.equal(tts.inputs.emo_happy, 0.8);
  assert.equal(tts.inputs.emo_random, true);
  assert.equal(tts.inputs.prompt_simple, 'data:audio/wav;base64,AAAA');
});

test('记录上的价格换算：AutoDL 的积分按当时的工作流快照算，1 分对 1 分', () => {
  const snapshot = { price_type: MINIMAX.price_type, billing_config: MINIMAX.billing_config, price: 0 };
  const video = { provider: 'autodl', kind: 'video', model: 'MiniMax H3', payload: { resolution: '768p竖(768*1376)' }, workflow: { billing: snapshot } };
  assert.equal(estimateCost(video), 0.6);
  assert.equal(quoteCost(video), 0.6);
  assert.equal(toCredits(quoteCost(video)), 60);

  // 按秒计费的，完成时按平台返回的时长结算。
  const audio = { provider: 'autodl', kind: 'audio', model: '声纹克隆', payload: { prompt_text: '你好' }, workflow: { billing: { price_type: TTS.price_type, billing_config: TTS.billing_config, price: 0 } } };
  assert.equal(quoteCost(audio), 0.1);
  assert.equal(estimateCost(audio, { seconds: 30 }), 0.3);
  assert.equal(toCredits(estimateCost(audio, { seconds: 30 })), 30);

  // 没有快照就不估。
  assert.equal(estimateCost({ provider: 'autodl', kind: 'video', payload: {} }), null);
});

test('工作流当成一种模型：id 带前缀、文字和素材参数按规则找、节点上的参数范围从规则推出来', () => {
  const id = flowModelId('minimax_h3_801');
  assert.equal(id, 'flow:minimax_h3_801');
  assert.equal(isFlowModel(id), true);
  assert.equal(isFlowModel('MiniMax-H3'), false);
  assert.equal(isFlowModel(undefined), false);
  assert.equal(flowUuidOf(id), 'minimax_h3_801');

  // 文字参数：prompt 优先，其次 prompt_text；一个文字规则都没有就是 null。
  assert.equal(flowTextKey(MINIMAX.input_rules), 'prompt');
  assert.equal(flowTextKey(TTS.input_rules), 'prompt_text');
  assert.equal(flowTextKey({}), null);

  // 素材参数按规则里的顺序，首尾帧和 ref_video 这种也叫得出名字。
  assert.deepEqual(flowMediaKeys(MINIMAX.input_rules, 'image'), ['ref_image_0', 'ref_image_1']);
  assert.deepEqual(flowMediaKeys(TTS.input_rules, 'audio'), ['prompt_simple', 'emo_ref_audio']);
  assert.deepEqual(flowMediaKeys(RETARGET.input_rules, 'video'), ['ref_video']);
  assert.deepEqual(flowMediaKeys(MINIMAX.input_rules, 'video'), []);

  // 视频节点要的分辨率、时长、首尾帧：分辨率取选项的 label（提交的就是它），时长是规则的范围。
  const spec = flowVideoSpec(MINIMAX.input_rules);
  assert.deepEqual(spec.resolutions, ['480p竖(480*864)', '768p竖(768*1376)', '1088p竖(1088*1920)']);
  assert.deepEqual(spec.durations, Array.from({ length: 15 }, (_, i) => i + 1));
  assert.deepEqual(spec.frames, []);
  assert.equal(spec.seed, true);
  assert.equal(spec.audio, false);
  assert.equal(spec.promptRequired, true);

  // 首尾帧的工作流、没有时长规则的（TTS）都要照实反映。
  assert.deepEqual(flowVideoSpec({ first_frame: { type: 'image', required: true }, last_frame: { type: 'image', required: true } }).frames, ['first_frame', 'last_frame']);
  assert.deepEqual(flowVideoSpec(TTS.input_rules).durations, []);
});

test('画布节点到工作流入参：提示词、首尾帧、参考素材、分辨率、时长各归各位', () => {
  // 文字 + 一张参考图（必填的 ref_image_0）：提示词进 prompt，图片进 ref_image_0，别的参数按默认值。
  const first = flowInputs(MINIMAX.input_rules, {
    prompt: '一只猫在云上跑',
    media: [{ kind: 'image', url: '/media/uploads/a.png', name: 'a.png' }],
    resolution: '1088p竖(1088*1920)',
    duration: 9,
  });
  assert.deepEqual(first.problems, []);
  assert.equal(first.inputs.prompt, '一只猫在云上跑');
  assert.equal(first.inputs.ref_image_0, '/media/uploads/a.png');
  assert.equal(first.inputs.resolution, '1088p竖(1088*1920)');
  assert.equal(first.inputs.duration, 9);
  assert.equal('ref_image_1' in first.inputs, false, '没连第二张就不发');
  assert.deepEqual(first.placed.map((entry) => entry.key), ['ref_image_0']);

  // 分辨率给的值不在选项里：换成规则里的默认值，而不是原样发出去。
  assert.equal(flowInputs(MINIMAX.input_rules, { prompt: '猫', media: [{ kind: 'image', url: 'u' }], resolution: '720p' }).inputs.resolution, '768p竖(768*1376)');

  // 首尾帧的工作流：连线标了用途的进 first_frame / last_frame。
  const frames = flowInputs(
    { prompt: { type: 'string', required: true }, first_frame: { type: 'image', required: true }, last_frame: { type: 'image', required: true } },
    { prompt: '接上', media: [{ kind: 'image', url: 'last.png', role: 'last' }, { kind: 'image', url: 'first.png', role: 'first' }] },
  );
  assert.deepEqual(frames.problems, []);
  assert.equal(frames.inputs.first_frame, 'first.png');
  assert.equal(frames.inputs.last_frame, 'last.png');

  // 动作迁移：一张图 + 一段视频。
  const retarget = flowInputs(RETARGET.input_rules, { media: [{ kind: 'image', url: 'p.png' }, { kind: 'video', url: '/media/uploads/v.mp4' }] });
  assert.deepEqual(retarget.problems, []);
  assert.equal(retarget.inputs.ref_image, 'p.png');
  assert.equal(retarget.inputs.ref_video, '/media/uploads/v.mp4');

  // 声纹克隆：文字进 prompt_text，参考音频进 prompt_simple；情感控制方式补默认值。
  const tts = flowInputs(TTS.input_rules, { prompt: '你好', media: [{ kind: 'audio', url: '/media/uploads/a.wav' }] });
  assert.deepEqual(tts.problems, []);
  assert.equal(tts.inputs.prompt_text, '你好');
  assert.equal(tts.inputs.prompt_simple, '/media/uploads/a.wav');
  assert.equal(tts.inputs.emo_control_method, '与音色参考音频相同');

  // 必填素材没连到：报错文案说得出缺哪一份，而不是把请求发出去。
  const missing = flowInputs(MINIMAX.input_rules, { prompt: '猫' });
  assert.match(missing.problems[0], /请填写图片参考图1/);

  // 时长参数叫 audio_duration 的工作流，写进它自己的键。
  const lipSync = flowInputs(
    { ref_image_0: { type: 'image', required: true }, ref_audio_0: { type: 'audio', required: true }, audio_duration: { type: 'integer', default: 5, min: 1, max: 15 }, resolution: { type: 'enum', default: '768p竖', options: [{ label: '480p竖' }, { label: '768p竖' }] } },
    { media: [{ kind: 'image', url: 'p.png' }, { kind: 'audio', url: 'a.wav' }], duration: 7 },
  );
  assert.deepEqual(lipSync.problems, []);
  assert.equal(lipSync.inputs.audio_duration, 7);
  assert.equal('duration' in lipSync.inputs, false);
  assert.equal(lipSync.inputs.resolution, '768p竖');
});

test('画布节点里的其余参数：枚举、开关跟着提交，不认识的键丢掉', () => {
  const base = { prompt: '猫', media: [{ kind: 'image', url: 'u' }] };
  const picked = flowInputs(MINIMAX.input_rules, { ...base, extra: { mode: '高速模式', bogus: 1, seed: 42 } });
  assert.deepEqual(picked.problems, []);
  assert.equal(picked.inputs.mode, '高速模式');
  assert.equal(picked.inputs.seed, 42, '数字参数也认');
  assert.equal('bogus' in picked.inputs, false, '规则里没有的键不跟着发');

  // 开关按布尔发出去。
  const toggled = flowInputs(TTS.input_rules, { prompt: '你好', media: [{ kind: 'audio', url: 'a.wav' }], extra: { emo_random: true, emo_happy: 0.8 } });
  assert.deepEqual(toggled.problems, []);
  assert.equal(toggled.inputs.emo_random, true);
  assert.equal(toggled.inputs.emo_happy, 0.8);

  // 枚举给了不在选项里的 label：拦下来，不提交。
  const bad = flowInputs(MINIMAX.input_rules, { ...base, extra: { mode: '极速模式' } });
  assert.match(bad.problems[0], /须从可选值里选/);
});

// ---------- 生成详情：参数怎么摆 ----------
test('长文本判定：超过 60 字或带换行就限高，短的不动', () => {
  assert.equal(isLongParam('猫'), false);
  assert.equal(isLongParam('一'.repeat(60)), false);
  assert.equal(isLongParam('一'.repeat(61)), true);
  assert.equal(isLongParam('第一行\n第二行'), true);
  assert.equal(paramIsLong(true, '一'.repeat(61)), true);
  assert.equal(paramIsLong(true, '猫'), false, '短文本独占一行也不用限高');
  assert.equal(paramIsLong(false, '一'.repeat(61)), false, '没独占一行的不该限高');
});

test('生成详情：文生图记录的提示词不塞进三列小格，也不和上方「提示词」重复', () => {
  const rules = rhRules(rhWorkflow('text-to-image'));
  const prompt = '一只坐在芥末黄丝绒扶手椅上的猫，暖色自然光，写实摄影，浅景深，柔和胶片颗粒，细节丰富，构图完整。';
  const entries = flowDisplayParams({ prompt, width: 1080, height: 1920, batch_size: 1, seed: 527633149753192 }, rules, prompt);
  assert.equal(entries.some(([name]) => name === '画面描述'), false, '和上方提示词一字不差的那份不再列');
  assert.deepEqual(entries.find(([name]) => name === '宽度'), ['宽度', '1080', false]);
  assert.deepEqual(entries.find(([name]) => name === '高度'), ['高度', '1920', false]);
  assert.deepEqual(entries.find(([name]) => name === '每次出图张数'), ['每次出图张数', '1', false]);
  assert.equal(entries.some(([, , wide]) => wide), false, '数值参数仍然并排');
});

test('生成详情：和上方提示词不同时保留，并独占整行', () => {
  const rules = rhRules(rhWorkflow('text-to-image'));
  const polished = 'A beautiful cat in a vintage armchair, warm daylight, photorealistic, '.repeat(3);
  const entries = flowDisplayParams({ prompt: polished, width: 1080 }, rules, '一只猫');
  const shown = entries.find(([name]) => name === '画面描述');
  assert.ok(shown, '润色后的提示词要单独列出来');
  assert.equal(shown[2], true, '提示词独占一行');
  assert.equal(isLongParam(shown[1]), true, '长文本会限高滚动');
  assert.equal(entries.find(([name]) => name === '宽度')[2], false);
  // 文本域即使只填两个字，也不该被塞进小格。
  assert.equal(flowDisplayParams({ prompt: '猫' }, rules, '狗')[0][2], true);
});

test('生成详情：素材不重复列，开关写成人话，普通长文本也独占一行', () => {
  const rules = {
    prompt: { type: 'prompt', label: '画面描述' },
    ref_image_0: { type: 'image', label: '参考图' },
    watermark: { type: 'boolean', label: '水印' },
    note: { type: 'string', label: '备注', max_length: 50 },
  };
  const entries = flowDisplayParams(
    { prompt: '猫', ref_image_0: '/media/a.png', watermark: true, note: '很长'.repeat(40) },
    rules,
    '猫',
  );
  assert.equal(entries.some(([name]) => name === '参考图'), false);
  assert.equal(entries.some(([name]) => name === '画面描述'), false);
  assert.deepEqual(entries.find(([name]) => name === '水印'), ['水印', '开', false]);
  assert.equal(entries.find(([name]) => name === '备注')[2], true);
});
