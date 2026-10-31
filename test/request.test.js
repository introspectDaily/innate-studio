// 表单 → 发给本地服务的请求。

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVideoRequest, refsInUse, carryRefs, buildImageRequest, buildSpeechRequest, buildSfxRequest, buildMusicRequest } from '../web/src/request.ts';

const baseForm = (patch = {}) => ({
  mode: 'text',
  prompt: '清晨的厨房',
  model: 'doubao-seedance-2-0-260128',
  resolution: '720p',
  ratio: '16:9',
  duration: 5,
  durationAuto: false,
  generateAudio: true,
  seed: '',
  frames: { first: null, last: null },
  refs: { image: [], video: [], audio: [] },
  ...patch,
});

const ref = (kind, url) => ({ uid: url, kind, source: 'url', url });
const local = (url) => ({ uid: url, kind: 'image', source: 'local', url });
// 一个视频模型支持什么。
const spec = (patch = {}) => ({ resolutions: ['480p', '720p'], ratios: ['16:9', '9:16'], durations: [4, 5], autoDuration: false, frames: ['first_frame', 'last_frame'], audio: true, seed: true, ...patch });

// ---------- 视频 ----------

test('文生视频：提示词是 prompt 字符串，带比例、分辨率、时长', () => {
  const { payload, problems } = buildVideoRequest(baseForm({ seed: '42' }), spec());
  assert.deepEqual(problems, []);
  assert.deepEqual(payload, { model: 'doubao-seedance-2-0-260128', duration: 5, resolution: '720p', prompt: '清晨的厨房', aspect_ratio: '16:9', generate_audio: true, seed: 42 });
  assert.deepEqual(buildVideoRequest(baseForm({ prompt: ' ' }), spec()).problems, ['请输入提示词']);
});

test('模型不支持的选项不发：声音开关、随机种子', () => {
  const { payload } = buildVideoRequest(baseForm({ seed: '42' }), spec({ audio: false, seed: false }));
  assert.equal('generate_audio' in payload, false);
  assert.equal('seed' in payload, false);
});

test('首尾帧：放在 frame_images 里，比例跟着图片走；模型只收首帧时不发尾帧', () => {
  const frames = { first: local('/media/images/a.jpg'), last: local('/media/images/b.jpg') };
  const both = buildVideoRequest(baseForm({ mode: 'frames', frames }), spec());
  assert.deepEqual(both.problems, []);
  assert.deepEqual(both.payload.frame_images, [
    { type: 'image_url', image_url: { url: '/media/images/a.jpg' }, frame_type: 'first_frame' },
    { type: 'image_url', image_url: { url: '/media/images/b.jpg' }, frame_type: 'last_frame' },
  ]);
  assert.equal('aspect_ratio' in both.payload, false);
  assert.equal(buildVideoRequest(baseForm({ mode: 'frames', frames }), spec({ frames: ['first_frame'] })).payload.frame_images.length, 1);
  assert.deepEqual(buildVideoRequest(baseForm({ mode: 'frames' }), spec()).problems, ['请添加首帧图片']);
});

test('参考生成：素材放在 input_references 里；本机视频交给服务端按需发布', () => {
  const refs = { image: [local('/media/images/a.jpg')], video: [ref('video', 'https://example.com/a.mp4')], audio: [] };
  const { payload, problems } = buildVideoRequest(baseForm({ mode: 'reference', refs }), spec());
  assert.deepEqual(problems, []);
  assert.deepEqual(payload.input_references, [
    { type: 'image_url', image_url: { url: '/media/images/a.jpg' } },
    { type: 'video_url', video_url: { url: 'https://example.com/a.mp4' } },
  ]);
  assert.equal(payload.aspect_ratio, '16:9');

  const localVideo = { image: [], video: [{ uid: 'v', kind: 'video', source: 'local', url: '/media/videos/a.mp4' }], audio: [] };
  // 前端不再拦截本机视频：提交时由服务端按需发布并替换成公网直链。
  const localVideoRequest = buildVideoRequest(baseForm({ mode: 'reference', refs: localVideo }), spec());
  assert.deepEqual(localVideoRequest.problems, []);
  assert.deepEqual(localVideoRequest.payload.input_references, [{ type: 'video_url', video_url: { url: '/media/videos/a.mp4' } }]);
  // 本机的参考音频可以用：由本地服务内嵌进请求
  const localAudio = { image: [], video: [], audio: [{ uid: 'a', kind: 'audio', source: 'local', url: '/media/uploads/a.mp3' }] };
  const withAudio = buildVideoRequest(baseForm({ mode: 'reference', refs: localAudio }), spec());
  assert.deepEqual(withAudio.problems, []);
  assert.deepEqual(withAudio.payload.input_references, [{ type: 'audio_url', audio_url: { url: '/media/uploads/a.mp3' } }]);
  assert.deepEqual(buildVideoRequest(baseForm({ mode: 'reference', prompt: '', refs: localAudio }), spec()).problems, ['仅有音频无法生成，请添加提示词、图片或视频']);
  // 换回文生视频时，之前选的参考素材不会被带上。
  assert.deepEqual(refsInUse(baseForm({ mode: 'text', refs })), []);
});
test('随机种子必须是整数', () => {
  assert.deepEqual(buildVideoRequest(baseForm({ seed: '1.5' }), spec()).problems, ['随机种子须为整数']);
  assert.equal(buildVideoRequest(baseForm({ seed: ' -7 ' }), spec()).payload.seed, -7);
});

test('换生成方式：图片跟着走，不用重新添加', () => {
  const [a, b, c] = ['a', 'b', 'c'].map((n) => ref('image', `https://a/${n}.jpg`));
  const refs = { image: [a, b], video: [], audio: [] };

  // 参考生成 → 首尾帧：第一张当首帧，其余留着
  const toFrames = carryRefs(baseForm({ mode: 'reference', refs }), 'frames', 9);
  assert.deepEqual(toFrames.frames, { first: a, last: null });
  assert.deepEqual(toFrames.refs.image, [b]);
  // 首帧已经有图就不动
  const kept = carryRefs(baseForm({ mode: 'reference', refs, frames: { first: c, last: null } }), 'frames', 9);
  assert.deepEqual(kept.frames, { first: c, last: null });
  assert.deepEqual(kept.refs.image, [a, b]);

  // 首尾帧 → 参考生成：首帧、尾帧排到最前面；只有尾帧也带回去
  const back = carryRefs(baseForm({ mode: 'frames', frames: { first: a, last: c }, refs: { ...refs, image: [b] } }), 'reference', 9);
  assert.deepEqual(back.frames, { first: null, last: null });
  assert.deepEqual(back.refs.image, [a, c, b]);
  assert.deepEqual(carryRefs(baseForm({ mode: 'frames', frames: { first: null, last: a } }), 'reference', 9).refs.image, [a]);
  // 参考图里已经有同一张就不重复；放不下的留在首尾帧里
  assert.deepEqual(carryRefs(baseForm({ frames: { first: a, last: null }, refs }), 'reference', 9).refs.image, [a, b]);
  const full = carryRefs(baseForm({ frames: { first: c, last: null }, refs }), 'reference', 2);
  assert.deepEqual(full.frames, { first: c, last: null });
  assert.deepEqual(full.refs.image, [a, b]);

  // 换成文生视频什么都不动
  const text = carryRefs(baseForm({ mode: 'reference', refs }), 'text', 9);
  assert.deepEqual([text.frames, text.refs.image], [{ first: null, last: null }, [a, b]]);
});


// ---------- 图片、语音、音效、配乐 ----------

test('生图：模型、提示词、张数、比例', () => {
  assert.deepEqual(buildImageRequest({ prompt: ' 红色纸船 ', model: 'doubao-seedream-5-0-pro-260628', ratio: '16:9', count: 2 }), {
    payload: { model: 'doubao-seedream-5-0-pro-260628', prompt: '红色纸船', n: 2, aspect_ratio: '16:9' },
    problems: [],
  });
  assert.deepEqual(buildImageRequest({ prompt: '', model: 'm', ratio: '1:1', count: 1 }).problems, ['请输入提示词']);

  // 图生图：参考图放进 input_references；模型不收、超了张数都说明原因。
  const local = { uid: 'a', kind: 'image', source: 'local', url: '/media/images/a.png', name: 'a', thumb: null };
  const edit = buildImageRequest({ prompt: '改成水彩', model: 'm', ratio: '1:1', count: 1, refs: [local] }, 3);
  assert.deepEqual(edit.problems, []);
  assert.deepEqual(edit.payload.input_references, [{ type: 'image_url', image_url: { url: '/media/images/a.png' } }]);
  assert.match(buildImageRequest({ prompt: '改', model: 'm', ratio: '1:1', count: 1, refs: [local] }).problems[0], /不支持参考图/);
  assert.match(buildImageRequest({ prompt: '改', model: 'm', ratio: '1:1', count: 1, refs: [local, local] }, 1).problems[0], /最多支持 1 张/);
  assert.match(buildImageRequest({ prompt: '', model: 'm', ratio: '1:1', count: 1, refs: [local] }, 3).problems[0], /修改要求/);
});

test('语音：要有文字和音色', () => {
  assert.deepEqual(buildSpeechRequest({ prompt: '你好', voiceId: 'v1', voiceName: 'Anson' }), { body: { text: '你好', voiceId: 'v1', voiceName: 'Anson' }, problems: [] });
  assert.deepEqual(buildSpeechRequest({ prompt: '', voiceId: 'v1' }).problems, ['请输入朗读文本']);
  assert.deepEqual(buildSpeechRequest({ prompt: '你好', voiceId: '' }).problems, ['请选择音色']);
});

test('音效：时长选自动时不传', () => {
  assert.deepEqual(buildSfxRequest({ prompt: '关门声', duration: 'auto' }).body, { text: '关门声' });
  assert.deepEqual(buildSfxRequest({ prompt: '关门声', duration: '5' }).body, { text: '关门声', duration: 5 });
  assert.deepEqual(buildSfxRequest({ prompt: ' ', duration: 'auto' }).problems, ['请输入音效描述']);
});

test('配乐：要有描述；给了视频就和视频一样长，最长 120 秒，没给就用选的时长', () => {
  assert.deepEqual(buildMusicRequest({ prompt: ' 轻快的钢琴 ', video: null, duration: 30 }), { body: { text: '轻快的钢琴', duration: 30 }, problems: [] });
  assert.deepEqual(buildMusicRequest({ prompt: '轻快的钢琴', video: { url: '/media/videos/a.mp4', duration: 5.04 }, duration: 30 }).body, { text: '轻快的钢琴', duration: 5, video: '/media/videos/a.mp4' });
  assert.equal(buildMusicRequest({ prompt: '轻快的钢琴', video: { url: '/media/videos/a.mp4', duration: 300 }, duration: 30 }).body.duration, 120);
  assert.deepEqual(buildMusicRequest({ prompt: '', video: null, duration: 30 }).problems, ['请输入配乐描述']);
  assert.deepEqual(buildMusicRequest({ prompt: '轻快的钢琴', video: { url: '/media/videos/a.mp4', duration: 0 }, duration: 30 }).problems, ['无法获取视频时长，请重新选择']);
});

test('必须写提示词的模型（MiniMax H3）：只给素材不行，首尾帧、参考生成都一样', () => {
  const h3 = spec({ audio: false, seed: false, promptRequired: true });
  const framed = buildVideoRequest(baseForm({ mode: 'frames', prompt: '', frames: { first: local('/media/uploads/a.png'), last: null } }), h3);
  assert.deepEqual(framed.problems, ['请输入提示词']);
  assert.equal('generate_audio' in framed.payload, false);
  assert.deepEqual(buildVideoRequest(baseForm({ mode: 'reference', prompt: '', refs: { image: [local('/media/uploads/a.png')], video: [], audio: [] } }), h3).problems, ['请输入提示词']);
  assert.deepEqual(buildVideoRequest(baseForm({ mode: 'reference', prompt: '跳舞', refs: { image: [local('/media/uploads/a.png')], video: [], audio: [] } }), h3).problems, []);
});
