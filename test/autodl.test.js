// AutoDL.art 的工作流：规则变表单、参数校验、按计费配置算价格。都是纯函数，不碰网络。
// 规则的样子按 2026-10-31 线上核对到的写（MiniMax H3 的几个、声纹克隆、动作迁移）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleDefault, requiredMedia, resolutionTier, stepPrice, workflowCost, cleanInputs, formValues, ruleKind, ruleLabel, durationOf, mediaAccepts } from '../shared/autodl.ts';
import { estimateCost, quoteCost, toCredits } from '../shared/models.ts';

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
