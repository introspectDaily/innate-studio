// 把真实的 server.js 跑起来，火山引擎换成模拟接口，走一遍主要流程。

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateCost } from '../shared/models.ts';
import { startMock, MOCK_ARK_KEY, MOCK_AIHUBMIX_KEY, MOCK_AIHUBMIX_MANAGE_KEY, MOCK_MINIMAX_KEY, MOCK_SPEECH_KEY, MOCK_ACCESS_KEY } from './mock-ark.js';
import { startTosMock, MOCK_TOS_ACCESS_KEY_ID, MOCK_TOS_SECRET_ACCESS_KEY, MOCK_TOS_BUCKET } from './mock-tos.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let mock;
let mockTos;
let app;
let base;
let dataDir;

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

async function waitFor(check, what, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch {
      /* 还没准备好，继续等 */
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`等待超时：${what}`);
}

async function call(method, url, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + url, init);
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

const VIDEO = 'doubao-seedance-2-0-260128';
const IMAGE = 'doubao-seedream-5-0-pro-260628';
const TEXT = 'doubao-seed-2-1-lite-260915';
const NEXT_TEXT = 'doubao-seed-2-1-turbo-260628';
const videoPayload = (prompt, extra = {}) => ({ model: VIDEO, prompt, duration: 5, resolution: '720p', aspect_ratio: '16:9', ...extra });
// 模拟接口收到的请求体。since 是只看日志里这一条之后的。
const sent = (pathname, since = 0) => mock.log.slice(since).filter((entry) => entry.method === 'POST' && entry.pathname === pathname).map((entry) => JSON.parse(entry.body));

// 等服务自己把某条记录推进到满足条件（不手动刷新）。
const waitItem = (id, done, what) =>
  waitFor(async () => {
    const item = (await call('GET', '/api/history')).data.items.find((i) => i.id === id);
    return item && done(item) ? item : null;
  }, what);

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function upload(bytes = PNG, type = 'image/png') {
  const res = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { 'Content-Type': type }, body: bytes });
  return { status: res.status, data: await res.json() };
}

// 反复让服务去查平台，直到这条记录满足条件。
const refreshUntil = (id, done, what) =>
  waitFor(async () => {
    const { data } = await call('POST', `/api/history/${id}/refresh`);
    return done(data) ? data : null;
  }, what);

before(async () => {
  mock = await startMock({ taskSeconds: 0.5 });
  mockTos = await startTosMock();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'innate-test-'));
  // 以前别的平台留下的记录：一条没跑完的，一条跑完并存到本机的。
  fs.writeFileSync(path.join(dataDir, 'history.json'), JSON.stringify([
    { id: 'task_old_pending', kind: 'video', model: 'seedance-2.0', prompt: '旧平台没跑完的', status: 'in_progress', createdAt: Date.now() },
    { id: 'task_old_done', provider: 'flatkey', kind: 'video', model: 'seedance-2.0', prompt: '旧平台跑完的', status: 'completed', localFile: 'task_old_done.mp4', createdAt: Date.now() },
  ]));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['server.js'], {
    cwd: root,
    stdio: 'ignore',
    // Key 的环境变量都置空：即使本机设置了真实 Key，测试也绝不会用到它。
    env: { ...process.env, PORT: String(port), ARK_BASE_URL: mock.url, DOUBAO_SPEECH_BASE_URL: mock.url, VOLC_BILLING_BASE_URL: mock.url, MINIMAX_BASE_URL: mock.url, MINIMAX_CN_API_KEY: '', AIHUBMIX_BASE_URL: mock.url, AIHUBMIX_API_KEY: '', AIHUBMIX_MANAGE_KEY: '', ARK_API_KEY: '', DOUBAO_SPEECH_API_KEY: '', VOLC_ACCESS_KEY_ID: '', VOLC_SECRET_ACCESS_KEY: '', TOS_ACCESS_KEY_ID: MOCK_TOS_ACCESS_KEY_ID, TOS_SECRET_ACCESS_KEY: MOCK_TOS_SECRET_ACCESS_KEY, TOS_FORCE_PATH_STYLE: '1', INNATE_DATA_DIR: dataDir, INNATE_PENDING_LIMIT_MS: '1500' },
  });
  await waitFor(async () => (await fetch(`${base}/api/state`)).ok, '服务启动');
});

after(async () => {
  app?.kill();
  await mock?.close();
  await mockTos?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('没有 Key：状态为未设置，创建任务被拒绝', async () => {
  const state = await call('GET', '/api/state');
  assert.equal(state.data.hasKey, false);
  assert.equal(state.data.baseUrl, mock.url);

  const created = await call('POST', '/api/videos', { payload: videoPayload('一只猫') });
  assert.equal(created.status, 401);
  assert.equal(created.data.error.code, 'no_api_key');
});

test('以前别的平台留下的记录：没跑完的标成失败、不再查询，跑完的照常列出', async () => {
  const { items } = (await call('GET', '/api/history')).data;
  const pending = items.find((i) => i.id === 'task_old_pending');
  assert.equal(pending.status, 'failed');
  assert.equal(pending.error.code, 'provider_removed');
  assert.equal(items.find((i) => i.id === 'task_old_done').videoUrl, '/media/videos/task_old_done.mp4');
  assert.equal((await call('POST', '/api/history/task_old_pending/refresh')).data.status, 'failed');
  assert.equal(mock.log.some((entry) => entry.pathname.includes('task_old')), false);
});

test('保存 Key：拒绝不是 Key 的内容，接受正常的 Key，且不回显完整内容', async () => {
  for (const bad of ['行，帮我编译安装吧', 'has space', '']) {
    const res = await call('PUT', '/api/key', { apiKey: bad });
    assert.equal(res.status, 400, `应该拒绝：${bad}`);
    assert.equal(res.data.error.code, 'invalid_key');
  }
  assert.match((await call('PUT', '/api/key', { apiKey: '中文 key' })).data.error.message, /火山方舟 控制台重新复制/);
  const saved = await call('PUT', '/api/key', { apiKey: MOCK_ARK_KEY });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.hasKey, true);
  assert.equal(JSON.stringify(saved.data).includes(MOCK_ARK_KEY), false);
});

test('模型列表：型号和各自支持什么是登记好的，连一次接口只为确认 Key 能用', async () => {
  const { data } = await call('GET', '/api/models');
  assert.equal(data.source, 'remote');
  assert.deepEqual(data.models, ['doubao-seedance-2-5-260628', 'doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-mini-260615', 'MiniMax-H3', 'MiniMax-H3-Max']);
  assert.deepEqual(data.videoSpecs['MiniMax-H3'], { resolutions: ['768P', '2K'], ratios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'], durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], autoDuration: false, frames: ['first_frame', 'last_frame'], audio: false, seed: false, promptRequired: true });
  assert.deepEqual(data.videoSpecs['MiniMax-H3-Max'].resolutions, ['480P', '768P']);
  assert.equal(data.videoSpecs['MiniMax-H3-Max'].durations[0], 5);
  assert.deepEqual(data.videoSpecs[VIDEO].resolutions, ['480p', '720p', '1080p', '4k']);
  assert.equal(data.videoSpecs['doubao-seedance-2-5-260628'].durations.at(-1), 30);
  assert.deepEqual(data.videoSpecs['doubao-seedance-2-0-mini-260615'].frames, ['first_frame', 'last_frame']);
  assert.deepEqual(data.imageModels, ['doubao-seedream-5-0-pro-260628', 'doubao-seedream-5-0-flash-260915', 'doubao-seedream-5-0-260128', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gemini-nano-banana-2.1']);
  assert.deepEqual(data.imageQualities, { 'gpt-image-2.5-sunburst': { options: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' }, 'gpt-image-2.5-flare': { options: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' } });
  assert.equal(data.imageRefs['gpt-image-2.5-flare'], 16);
  assert.equal(data.imageRefs['gemini-nano-banana-2.1'], 14);
  assert.deepEqual(data.imageSizes['gemini-nano-banana-2.1'], { options: ['1K', '2K', '4K'], default: '2K' });
  assert.equal(data.imageRefs[IMAGE], 10);
  assert.equal(data.imageRatios[IMAGE].includes('16:9'), true);
  assert.deepEqual(data.imageSizes[IMAGE], { options: ['1K', '1.5K', '2K'], default: '1.5K' });
  assert.deepEqual(data.imageSizes['doubao-seedream-5-0-260128'], { options: ['2K', '3K', '4K'], default: '2K' });
  assert.deepEqual(data.polishModels, [TEXT, NEXT_TEXT, 'doubao-seed-2-1-pro-260915']);
  assert.equal(mock.log.some((entry) => entry.method === 'GET' && entry.pathname === '/contents/generations/tasks' && entry.authed), true);
});

test('余额：方舟的 API Key 查不了，配了账号的 Access Key 才到费用中心查', async () => {
  assert.deepEqual((await call('GET', '/api/credits')).data, { unavailable: true });
  // 一对里少一项、或者签名对不上的，都不存。
  assert.equal((await call('PUT', '/api/key', { service: 'billing', accessKeyId: MOCK_ACCESS_KEY.id })).status, 400);
  const wrong = await call('PUT', '/api/key', { service: 'billing', accessKeyId: 'AKLTsomeoneelse', secretAccessKey: MOCK_ACCESS_KEY.secret });
  assert.equal(wrong.status, 401);
  assert.match(wrong.data.error.message, /Access Key 无效/);
  assert.deepEqual((await call('GET', '/api/credits')).data, { unavailable: true });

  const saved = (await call('PUT', '/api/key', { service: 'billing', accessKeyId: MOCK_ACCESS_KEY.id, secretAccessKey: MOCK_ACCESS_KEY.secret })).data;
  assert.equal(saved.billing?.hasKey, true, JSON.stringify(saved));
  assert.equal(saved.billing.keyHint.includes(MOCK_ACCESS_KEY.secret), false);
  assert.deepEqual((await call('GET', '/api/credits')).data, { currency: 'CNY', remaining: 77.01, cash: 83.01, arrears: 0 });

  assert.equal((await call('DELETE', '/api/key?service=billing')).data.billing.hasKey, false);
  assert.deepEqual((await call('GET', '/api/credits')).data, { unavailable: true });
});

test('页面能打开，目录穿越和跨站请求被拦截', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal((await fetch(`${base}/%2e%2e/server.js`)).status, 404);

  const crossSite = await call('POST', '/api/videos', { payload: videoPayload('x') }, { Origin: 'https://evil.example' });
  assert.equal(crossSite.status, 403);

  const notJson = await fetch(`${base}/api/videos`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(notJson.status, 415);
});

test('TOS 素材库：只校验已有 Bucket，配置、上传、列表、重命名和删除都限制在 prefix 内', async () => {
  const initial = await call('GET', '/api/tos/config');
  assert.equal(initial.status, 200);
  assert.equal(initial.data.configured, false);
  assert.equal(initial.data.hasCredentials, true);

  // 不存在的 Bucket 直接拒绝，而且不能悄悄创建。
  const missing = await call('PUT', '/api/tos/config', { bucket: 'bucket-does-not-exist', prefix: 'studio', region: 'cn-beijing', endpoint: mockTos.url });
  assert.equal(missing.status, 400, JSON.stringify(missing.data));
  assert.equal(missing.data.error.code, 'tos_bucket_not_found');
  assert.equal(mockTos.buckets.has('bucket-does-not-exist'), false);

  const saved = await call('PUT', '/api/tos/config', { bucket: MOCK_TOS_BUCKET, prefix: 'studio-assets', region: 'cn-beijing', endpoint: mockTos.url, publicBaseUrl: 'https://media.example.com' });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.configured, true);
  assert.equal(saved.data.bucket, MOCK_TOS_BUCKET);
  assert.equal(saved.data.prefix, 'studio-assets');
  assert.equal(saved.data.hasCredentials, true);
  assert.equal(saved.data.publicBaseUrl, 'https://media.example.com');
  assert.equal(JSON.stringify(saved.data).includes(MOCK_TOS_SECRET_ACCESS_KEY), false);
  assert.equal(mockTos.buckets.get(MOCK_TOS_BUCKET).has('studio-assets/.keep'), true);

  const uploadedResponse = await fetch(`${base}/api/tos/objects?filename=clip.mp4`, { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: Buffer.from('mock video') });
  const uploaded = await uploadedResponse.json();
  assert.equal(uploadedResponse.status, 200, JSON.stringify(uploaded));
  assert.match(uploaded.key, /^studio-assets\/uploads\/\d{4}-\d{2}-\d{2}\/[0-9a-f]+-clip\.mp4$/);
  assert.match(uploaded.url, /^https:\/\/media\.example\.com\/studio-assets\/uploads\//);
  assert.equal(mockTos.buckets.get(MOCK_TOS_BUCKET).get(uploaded.key).acl, 'public-read');

  const listed = await call('GET', '/api/tos/objects');
  assert.equal(listed.status, 200);
  assert.equal(listed.data.items.some((item) => item.key === uploaded.key), true);
  assert.equal(listed.data.items.some((item) => item.key.endsWith('/.keep')), false);

  const renamed = await call('PUT', '/api/tos/objects', { key: uploaded.key, name: 'videos/final.mp4' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.data.key, 'studio-assets/videos/final.mp4');
  assert.equal(mockTos.buckets.get(MOCK_TOS_BUCKET).has('studio-assets/videos/final.mp4'), true);
  assert.equal(mockTos.buckets.get(MOCK_TOS_BUCKET).has(uploaded.key), false);

  const escaped = await call('DELETE', `/api/tos/objects?key=${encodeURIComponent('some-other-prefix/file.mp4')}`);
  assert.equal(escaped.status, 400);
  assert.equal(escaped.data.error.code, 'invalid_object_name');

  const removed = await call('DELETE', `/api/tos/objects?key=${encodeURIComponent(renamed.data.key)}`);
  assert.equal(removed.status, 204);
  assert.equal(mockTos.buckets.get(MOCK_TOS_BUCKET).has(renamed.data.key), false);
});

test('本地素材：默认存本机；发布到 TOS 并复用有效链接', async () => {
  // 先配好 TOS：分享和参考直链都走它。
  const configured = await call('PUT', '/api/tos/config', { bucket: MOCK_TOS_BUCKET, prefix: 'studio-assets', region: 'cn-beijing', endpoint: mockTos.url, publicBaseUrl: 'https://media.example.com' });
  assert.equal(configured.status, 200, JSON.stringify(configured.data));

  const uploadedResponse = await fetch(`${base}/api/uploads?filename=${encodeURIComponent('multipart-本地小猫.png')}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG });
  const uploaded = await uploadedResponse.json();
  assert.equal(uploadedResponse.status, 200);
  assert.equal(uploaded.material.name, 'multipart-本地小猫.png');
  const materialUrl = uploaded.url;

  const listed = await call('GET', '/api/materials');
  assert.equal(listed.status, 200);
  const material = listed.data.items.find((item) => item.url === materialUrl);
  assert.ok(material);
  assert.equal(material.kind, 'image');
  assert.deepEqual(material.publications, []);

  const renamed = await call('PUT', `/api/materials/${material.id}`, { name: '主视觉小猫' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.data.name, '主视觉小猫');

  const publishedPuts = () => mockTos.log.filter((entry) => entry.method === 'PUT' && decodeURIComponent(entry.pathname).includes('/published/')).length;
  const beforePut = publishedPuts();
  const published = await call('POST', '/api/materials/publish', { url: materialUrl, purpose: 'share' });
  assert.equal(published.status, 200, JSON.stringify(published.data));
  assert.equal(published.data.provider, 'tos');
  assert.match(published.data.url, /^https:\/\/media\.example\.com\/studio-assets\/published\/\d{4}-\d{2}-\d{2}\/[0-9a-f]+-up_[0-9a-f]+\.png$/);
  assert.equal(published.data.direct, true);
  assert.equal(publishedPuts(), beforePut + 1);

  // 有效期内再次发布直接复用，不会重新上传。
  const reused = await call('POST', '/api/materials/publish', { url: materialUrl, purpose: 'share' });
  assert.equal(reused.status, 200);
  assert.equal(reused.data.reused, true);
  assert.equal(reused.data.url, published.data.url);
  assert.equal(publishedPuts(), beforePut + 1);

  const removed = await call('DELETE', `/api/materials/${material.id}`);
  assert.equal(removed.status, 204);
  assert.equal(fs.existsSync(path.join(dataDir, 'uploads', path.basename(materialUrl))), false);
  assert.equal((await call('GET', '/api/materials')).data.items.some((item) => item.url === materialUrl), false);
});

test('提交视频：换成 content 数组，本机的首帧内嵌进去；完成后把结果存到本机，用量是 token', async () => {
  const { url } = (await upload()).data;
  assert.match(url, /^\/media\/uploads\/up_[0-9a-f]+\.png$/);
  const payload = videoPayload('猫转头', { aspect_ratio: undefined, generate_audio: false, seed: 7, frame_images: [{ type: 'image_url', image_url: { url }, frame_type: 'first_frame' }] });
  const created = await call('POST', '/api/videos', { payload, form: { mode: 'frames' } });
  assert.equal(created.status, 200);
  assert.equal(created.data.provider, 'ark');
  assert.equal(created.data.status, 'queued');
  assert.equal(created.data.prompt, '猫转头');
  // 记录里存的还是页面发来的样子。
  assert.equal(created.data.payload.frame_images[0].image_url.url, url);

  const request = sent('/contents/generations/tasks').at(-1);
  assert.deepEqual({ ...request, content: null }, { model: VIDEO, content: null, resolution: '720p', ratio: 'adaptive', duration: 5, watermark: false, generate_audio: false, seed: 7 });
  assert.deepEqual(request.content[0], { type: 'text', text: '猫转头' });
  assert.equal(request.content[1].role, 'first_frame');
  assert.equal(request.content[1].image_url.url, `data:image/png;base64,${PNG.toString('base64')}`);

  const done = await refreshUntil(created.data.id, (i) => i.status === 'completed' && i.savedLocally, '任务完成并保存到本机');
  assert.equal(done.progress, 100);
  assert.deepEqual(done.usage, { completion_tokens: 108900, total_tokens: 108900 });
  assert.match(done.videoUrl, /^\/media\/videos\/cgt-[\w-]+\.mp4$/);
  assert.ok(fs.existsSync(path.join(dataDir, 'videos', done.localFile)));
  // 结果是从 content.video_url 给的地址下载的。
  assert.equal(mock.log.some((entry) => entry.pathname === `/tos/${created.data.id}.mp4`), true);

  const ranged = await fetch(base + done.videoUrl, { headers: { Range: 'bytes=0-3' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-type'), 'video/mp4');
  assert.equal((await ranged.arrayBuffer()).byteLength, 4);

  const history = await call('GET', '/api/history');
  assert.equal(history.data.items[0].id, created.data.id);
  assert.deepEqual(history.data.items[0].form, { mode: 'frames' });
  assert.ok(JSON.parse(fs.readFileSync(path.join(dataDir, 'history.json'), 'utf8')).some((i) => i.id === created.data.id));

  // 指向不存在的本机文件：直接说明，不发给平台。
  const missing = await call('POST', '/api/videos', { payload: videoPayload('x', { frame_images: [{ type: 'image_url', image_url: { url: '/media/uploads/up_none.png' }, frame_type: 'first_frame' }] }) });
  assert.equal(missing.status, 400, JSON.stringify(missing.data));
  assert.equal(missing.data.error.code, 'file_not_found');
});

test('参考生成：图片、视频、音频各有各的 role；本机参考视频先上传 TOS', async () => {
  const { url } = (await upload()).data;
  const refs = [
    { type: 'image_url', image_url: { url } },
    { type: 'video_url', video_url: { url: 'https://example.com/a.mp4' } },
    { type: 'audio_url', audio_url: { url: 'https://example.com/a.mp3' } },
  ];
  const created = await call('POST', '/api/videos', { payload: videoPayload('参考图片1里的人走进视频1的场景', { input_references: refs }) });
  assert.equal(created.status, 200);
  const { content, ratio } = sent('/contents/generations/tasks').at(-1);
  assert.equal(ratio, '16:9');
  assert.deepEqual(content.slice(1).map((c) => [c.type, c.role]), [['image_url', 'reference_image'], ['video_url', 'reference_video'], ['audio_url', 'reference_audio']]);
  assert.equal(content[2].video_url.url, 'https://example.com/a.mp4');

  // 本机的参考音频内嵌进请求，类型写文件格式本身。
  const audio = (await upload(Buffer.from('ID3 fake'), 'audio/mpeg')).data.url;
  assert.match(audio, /\.mp3$/);
  const withAudio = await call('POST', '/api/videos', { payload: videoPayload('按音频1的节奏', { input_references: [{ type: 'image_url', image_url: { url } }, { type: 'audio_url', audio_url: { url: audio } }] }) });
  assert.equal(withAudio.status, 200);
  const inlined = sent('/contents/generations/tasks').at(-1).content.at(-1);
  assert.equal(inlined.role, 'reference_audio');
  assert.match(inlined.audio_url.url, /^data:audio\/mp3;base64,/);

  // 本机参考视频先上传到 TOS，Ark 请求里只出现公网 https/http 地址；记录里仍保留原来的 /media 短地址。
  const localVideo = (await upload(Buffer.from('mock local video'), 'video/mp4')).data.url;
  const local = await call('POST', '/api/videos', { payload: videoPayload('延长', { input_references: [{ type: 'video_url', video_url: { url: localVideo } }] }) });
  assert.equal(local.status, 200, JSON.stringify(local.data));
  const localRequest = sent('/contents/generations/tasks').at(-1);
  assert.match(localRequest.content.at(-1).video_url.url, /^https:\/\/media\.example\.com\/studio-assets\/references\/\d{4}-\d{2}-\d{2}\/[0-9a-f]+-up_[0-9a-f]+\.mp4$/);
  const afterFirst = mockTos.log.filter((entry) => entry.method === 'PUT' && entry.pathname.includes('/references/')).length;

  // 再次生成：TOS 链接仍有效，不重复上传。
  const again = await call('POST', '/api/videos', { payload: videoPayload('再延长一次', { input_references: [{ type: 'video_url', video_url: { url: localVideo } }] }) });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(mockTos.log.filter((entry) => entry.method === 'PUT' && entry.pathname.includes('/references/')).length, afterFirst);
  assert.equal(sent('/contents/generations/tasks').at(-1).content.at(-1).video_url.url, localRequest.content.at(-1).video_url.url);
  assert.equal(local.data.payload.input_references[0].video_url.url, localVideo);
});

test('登记之外的型号不发出去；平台拒绝、模型没开通、任务失败，都把原因带回来', async () => {
  const count = () => sent('/contents/generations/tasks').length;
  const before = count();
  const wrong = await call('POST', '/api/videos', { payload: videoPayload('猫', { model: 'seedance-2.0' }) });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error.message, /不支持视频模型 seedance-2\.0/);
  assert.equal(count(), before);

  const records = (await call('GET', '/api/history')).data.items.length;
  const rejected = await call('POST', '/api/videos', { payload: videoPayload('REJECT') });
  assert.equal(rejected.status, 400);
  // 卡片上只说中文的原因，平台的原话放在 detail 里。
  assert.match(rejected.data.error.message, /^火山方舟 拒绝了这次请求/);
  assert.match(rejected.data.error.detail, /^火山方舟（InvalidParameter）：the parameter `content`/);
  // 没创建成功的不留记录。
  assert.equal((await call('GET', '/api/history')).data.items.length, records);

  const notOpen = await call('POST', '/api/videos', { payload: videoPayload('NOTOPEN') });
  assert.equal(notOpen.status, 404);
  assert.match(notOpen.data.error.message, /未开通该模型.*余额大于 200 元/);

  const created = await call('POST', '/api/videos', { payload: videoPayload('FAIL') });
  const failed = await refreshUntil(created.data.id, (i) => i.status === 'failed', '任务失败');
  assert.equal(failed.error.code, 'OutputVideoSensitiveContentDetected');
  assert.equal(failed.error.message, '生成的视频未通过内容审核');
  assert.match(failed.error.detail, /^火山方舟（OutputVideoSensitiveContentDetected）：The request failed/);
  assert.equal(failed.videoUrl, null);
});

test('MiniMax H3：另一个平台、另一个 Key；请求换成它的格式，任务到它那边查，成片存到本机，费用按秒算', async () => {
  const h3 = (prompt, extra = {}) => ({ model: 'MiniMax-H3', prompt, duration: 5, resolution: '2K', aspect_ratio: '9:16', ...extra });
  const noKey = await call('POST', '/api/videos', { payload: h3('一只猫') });
  assert.equal(noKey.status, 401);
  assert.match(noKey.data.error.message, /MiniMax 的 API Key/);

  // 国际站的 Key 国内站不认：把原因说清楚。
  await call('PUT', '/api/key', { apiKey: 'international-site-key', service: 'minimax' });
  const wrongKey = await call('POST', '/api/videos', { payload: h3('一只猫') });
  assert.equal(wrongKey.status, 401);
  assert.match(wrongKey.data.error.message, /国内站/);
  const saved = (await call('PUT', '/api/key', { apiKey: MOCK_MINIMAX_KEY, service: 'minimax' })).data;
  assert.equal(saved.minimax.hasKey, true);
  assert.equal(JSON.stringify(saved).includes(MOCK_MINIMAX_KEY), false);

  // 文生视频：比例必须带上；没有声音开关、随机种子、水印这些参数。
  const mark = mock.log.length;
  const created = await call('POST', '/api/videos', { payload: h3('一只猫', { generate_audio: true, seed: 7 }) });
  assert.equal(created.status, 200);
  assert.equal(created.data.provider, 'minimax');
  assert.deepEqual(sent('/v2/video_generation', mark)[0], { model: 'MiniMax-H3', content: [{ type: 'text', text: '一只猫' }], resolution: '2K', duration: 5, ratio: '9:16' });
  const done = await waitItem(created.data.id, (i) => i.status === 'completed' && i.savedLocally, 'H3 任务完成并存到本机');
  assert.match(done.videoUrl, /^\/media\/videos\//);
  assert.equal(done.usage.output_seconds, 5);
  assert.equal(estimateCost(done), 4);

  // 首帧：比例跟着图片走，不传；本机的图内嵌进请求。
  const { data: file } = await upload();
  const framed = await call('POST', '/api/videos', { payload: h3('动起来', { aspect_ratio: undefined, frame_images: [{ type: 'image_url', image_url: { url: file.url }, frame_type: 'first_frame' }] }) });
  const framedBody = sent('/v2/video_generation', mark)[1];
  assert.equal(framed.status, 200);
  assert.equal('ratio' in framedBody, false);
  assert.equal(framedBody.content[1].role, 'first_frame');
  assert.match(framedBody.content[1].image_url.url, /^data:image\/png;base64,/);

  // 提示词必填；文生视频没有比例不发出去。
  const count = sent('/v2/video_generation').length;
  const noPrompt = await call('POST', '/api/videos', { payload: h3('', { input_references: [{ type: 'image_url', image_url: { url: file.url } }] }) });
  assert.equal(noPrompt.status, 400);
  assert.match(noPrompt.data.error.message, /须填写提示词/);
  assert.equal((await call('POST', '/api/videos', { payload: h3('猫', { aspect_ratio: undefined }) })).status, 400);
  assert.equal(sent('/v2/video_generation').length, count);

  const failed = await call('POST', '/api/videos', { payload: h3('FAIL') });
  const failedItem = await refreshUntil(failed.data.id, (i) => i.status === 'failed', 'H3 任务失败');
  assert.match(failedItem.error.message, /^内容未通过审核/);
  assert.match(failedItem.error.detail, /content moderation failed/);

  await call('DELETE', '/api/key?service=minimax');
  assert.equal((await call('GET', '/api/state')).data.minimax.hasKey, false);
});

test('AiHubMix 的图片模型：另一个 Key；GPT Image 发像素大小和画质，Nano Banana 发比例和档位；图片存到本机', async () => {
  const GPT = 'gpt-image-2.5-sunburst';
  const BANANA = 'gemini-nano-banana-2.1';
  const done = (id) => waitItem(id, (i) => i.status !== 'in_progress', '图片出结果');
  const noKey = await call('POST', '/api/images', { payload: { model: GPT, prompt: '一只猫' } });
  assert.equal(noKey.status, 401);
  assert.match(noKey.data.error.message, /AiHubMix 的 API Key/);
  const saved = (await call('PUT', '/api/key', { apiKey: MOCK_AIHUBMIX_KEY, service: 'aihubmix' })).data;
  assert.equal(saved.aihubmix.hasKey, true);

  // GPT Image：要两张发两次；大小按档位和比例查表；画质没选用默认的，放在 extra 里；本机的参考图内嵌进 images。
  const mark = mock.log.length;
  const { data: file } = await upload();
  const made = await call('POST', '/api/images', { payload: { model: GPT, prompt: '一只猫', n: 2, aspect_ratio: '16:9', resolution: '2K', input_references: [{ type: 'image_url', image_url: { url: file.url } }] } });
  assert.equal(made.status, 200);
  assert.equal(made.data.items.length, 2);
  assert.equal(made.data.items[0].provider, 'aihubmix');
  assert.equal(made.data.items[0].payload.quality, 'medium');
  const first = await done(made.data.items[0].id);
  assert.equal(first.status, 'completed');
  assert.match(first.mediaUrl, /^\/media\/images\/img_\w+\.png$/);
  assert.equal(estimateCost(first), null);
  const bodies = sent('/ai/v1/images/generations', mark);
  assert.equal(bodies.length, 2);
  assert.deepEqual({ ...bodies[0], images: bodies[0].images.length }, { model: GPT, prompt: '一只猫', n: 1, size: '2560x1440', extra: { quality: 'medium' }, images: 1 });
  assert.match(bodies[0].images[0], /^data:image\/png;base64,/);
  assert.equal((await call('POST', '/api/images', { payload: { model: GPT, prompt: '猫', quality: 'ultra' } })).status, 400);
  await done((await call('POST', '/api/images', { payload: { model: GPT, prompt: '猫', quality: 'high' } })).data.items[0].id);
  assert.deepEqual(sent('/ai/v1/images/generations', mark)[2], { model: GPT, prompt: '猫', n: 1, size: '1024x1024', extra: { quality: 'high' } });

  // Nano Banana：直接发比例和档位，没有画质；图片给的是下载地址时带着 Key 去取。
  const mark2 = mock.log.length;
  const banana = await call('POST', '/api/images', { payload: { model: BANANA, prompt: 'BYURL 一只猫', aspect_ratio: '9:16' } });
  assert.equal((await done(banana.data.items[0].id)).savedLocally, true);
  assert.deepEqual(sent('/ai/v1/images/generations', mark2)[0], { model: BANANA, prompt: 'BYURL 一只猫', n: 1, aspect_ratio: '9:16', resolution: '2K' });
  assert.equal(mock.log.slice(mark2).some((entry) => entry.method === 'GET' && /\/content\/0$/.test(entry.pathname)), true);
  assert.equal((await call('POST', '/api/images', { payload: { model: BANANA, prompt: '猫', quality: 'high' } })).data.items[0].payload.quality, undefined);

  // 模型方拦截、账号没开异步任务：把原因说成中文。
  const blocked = await done((await call('POST', '/api/images', { payload: { model: BANANA, prompt: 'FAIL' } })).data.items[0].id);
  assert.equal(blocked.status, 'failed');
  assert.match(blocked.error.message, /被模型方拦截/);
  const closed = await done((await call('POST', '/api/images', { payload: { model: GPT, prompt: 'NOASYNC' } })).data.items[0].id);
  assert.match(closed.error.message, /未开启「异步任务」/);
  await call('DELETE', '/api/key?service=aihubmix');
});

test('另外两个账户的余额：MiniMax 手动填、之后按估算的花费扣；AiHubMix 用 Manage Key 查，单位是美元', async () => {
  const credits = async () => (await call('GET', '/api/credits')).data;
  assert.equal('minimax' in (await credits()) || 'aihubmix' in (await credits()), false);

  // MiniMax：填 30 元，生成一条 5 秒 2K（0.80 元/秒）之后剩 26；填之前生成的不算。
  for (const bad of ['', 'abc', -1]) assert.equal((await call('PUT', '/api/balance/minimax', { amount: bad })).status, 400, String(bad));
  const filled = await call('PUT', '/api/balance/minimax', { amount: 30 });
  assert.equal(filled.data.remaining, 30);
  await call('PUT', '/api/key', { apiKey: MOCK_MINIMAX_KEY, service: 'minimax' });
  const made = await call('POST', '/api/videos', { payload: { model: 'MiniMax-H3', prompt: '一只猫', duration: 5, resolution: '2K', aspect_ratio: '16:9' } });
  await refreshUntil(made.data.id, (i) => i.status === 'completed', 'H3 任务完成');
  const { minimax } = await credits();
  assert.equal(minimax.remaining, 26);
  assert.equal(minimax.amount, 30);
  assert.equal(minimax.unit, 'cny');
  // 用订阅 Key 时扣的是积分：1000 积分 = 7 元，4 元折 571 积分。重新填之后，之前那条不再算。
  assert.equal((await call('PUT', '/api/balance/minimax', { amount: 4489, unit: 'credits' })).data.remaining, 4489);
  const again = await call('POST', '/api/videos', { payload: { model: 'MiniMax-H3', prompt: '一只狗', duration: 5, resolution: '2K', aspect_ratio: '16:9' } });
  await refreshUntil(again.data.id, (i) => i.status === 'completed', 'H3 任务完成');
  assert.deepEqual({ ...(await credits()).minimax, at: 0 }, { unit: 'credits', remaining: 3918, amount: 4489, at: 0, estimated: true });

  // AiHubMix：生图用的 API Key 查不了，存不进去；Manage Key 查得到才存，也不回显。
  const wrong = await call('PUT', '/api/key', { apiKey: MOCK_AIHUBMIX_KEY, service: 'aihubmix-manage' });
  assert.equal(wrong.status, 401);
  assert.match(wrong.data.error.message, /不是 API Key/);
  const saved = await call('PUT', '/api/key', { apiKey: MOCK_AIHUBMIX_MANAGE_KEY, service: 'aihubmix-manage' });
  assert.equal(saved.data.aihubmixManage.hasKey, true);
  assert.equal(JSON.stringify(saved.data).includes(MOCK_AIHUBMIX_MANAGE_KEY), false);
  assert.deepEqual((await credits()).aihubmix, { currency: 'USD', remaining: 4.52, used: 1.48 });

  await call('DELETE', '/api/key?service=aihubmix-manage');
  await call('DELETE', '/api/key?service=minimax');
  assert.equal((await call('DELETE', '/api/balance/minimax')).status, 204);
  const cleared = await credits();
  assert.equal('minimax' in cleared || 'aihubmix' in cleared, false);
});

test('任务一直没结果：超过时限后停止自动查询，手动再查能接上', async () => {
  const created = await call('POST', '/api/videos', { payload: videoPayload('STUCK 这条会一直卡住') });
  const { id } = created.data;
  const pollCount = () => mock.log.filter((l) => l.method === 'GET' && l.pathname === `/contents/generations/tasks/${id}`).length;

  // 不去手动刷新，只靠服务自己的轮询走到超时。
  const timedOut = await waitItem(id, (item) => item.status === 'failed', '任务被标为查询超时');
  assert.equal(timedOut.error.code, 'poll_timeout');

  // 超时之后服务不再自己去查。
  const before = pollCount();
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(pollCount(), before);

  // 手动再查：平台仍没结果就保持超时；平台完成了就照常完成并保存。
  const again = await call('POST', `/api/history/${id}/refresh`);
  assert.equal(pollCount(), before + 1);
  assert.equal(again.data.error.code, 'poll_timeout');

  mock.tasks.get(id).stuck = false;
  const done = await refreshUntil(id, (item) => item.savedLocally, '超时的任务再查后完成');
  assert.equal(done.status, 'completed');
  assert.equal(done.error, null);
});

test('生图：要几张发几次，各自一条记录；大小按画面比例换成像素值，不要水印；参考图放进 image 数组', async () => {
  const created = await call('POST', '/api/images', { payload: { model: IMAGE, prompt: '窗台上的猫', n: 2, aspect_ratio: '16:9' }, form: { prompt: '窗台上的猫' } });
  assert.equal(created.status, 200);
  assert.equal(created.data.items.length, 2);
  // 请求一发出就有记录，状态是生成中。
  for (const item of created.data.items) {
    assert.equal(item.kind, 'image');
    assert.equal(item.status, 'in_progress');
    assert.match(item.id, /^img_/);
  }
  const [first, second] = await Promise.all(created.data.items.map((i) => waitItem(i.id, (item) => item.status === 'completed', '图片生成完成')));
  assert.match(first.mediaUrl, /^\/media\/images\/img_[0-9a-f]+\.jpg$/);
  assert.equal(first.videoUrl, null);
  assert.notEqual(first.mediaUrl, second.mediaUrl);
  assert.deepEqual(first.usage, { generated_images: 1, total_tokens: 16384, size: '2048x1152' });
  assert.equal(first.payload.aspect_ratio, '16:9');
  assert.deepEqual(sent('/images/generations').slice(-2), Array(2).fill({ model: IMAGE, prompt: '窗台上的猫', size: '2048x1152', response_format: 'b64_json', watermark: false }));

  const file = await fetch(base + first.mediaUrl);
  assert.equal(file.status, 200);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);

  // 删除记录时图片文件一起删掉。
  assert.equal((await call('DELETE', `/api/history/${second.id}`)).status, 204);
  assert.equal(fs.existsSync(path.join(dataDir, 'images', second.localFile)), false);

  // 选了分辨率档位：按那一档的像素发。
  const large = await call('POST', '/api/images', { payload: { model: 'doubao-seedream-5-0-260128', prompt: '四K的猫', n: 1, aspect_ratio: '16:9', resolution: '4K' } });
  const largeItem = await waitItem(large.data.items[0].id, (i) => i.status === 'completed', '4K 的那张生成完');
  assert.equal(sent('/images/generations').at(-1).size, '5504x3040');
  assert.equal(largeItem.payload.resolution, '4K');

  const { url } = (await upload()).data;
  const ref = { type: 'image_url', image_url: { url } };
  const edited = await call('POST', '/api/images', { payload: { model: 'doubao-seedream-5-0-260128', prompt: '改成水彩', n: 1, aspect_ratio: '1:1', input_references: [ref] } });
  await waitItem(edited.data.items[0].id, (i) => i.status === 'completed', '图生图完成');
  const request = sent('/images/generations').at(-1);
  assert.equal(request.size, '2048x2048');
  assert.equal(request.image.length, 1);
  assert.match(request.image[0], /^data:image\/png;base64,/);
});

test('生图：这个模型没有的档位、太多参考图、登记之外的型号直接拒掉；平台出错的留下记录并写明原因', async () => {
  const before = sent('/images/generations').length;
  const wrongSize = await call('POST', '/api/images', { payload: { model: IMAGE, prompt: '没有这一档', n: 1, aspect_ratio: '16:9', resolution: '4K' } });
  assert.equal(wrongSize.status, 400);
  assert.match(wrongSize.data.error.message, /不支持 4K/);
  const ref = { type: 'image_url', image_url: { url: 'https://example.com/a.png' } };
  const tooMany = await call('POST', '/api/images', { payload: { model: IMAGE, prompt: '改', n: 1, input_references: Array(11).fill(ref) } });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.data.error.message, /最多支持 10 张/);
  const wrongModel = await call('POST', '/api/images', { payload: { model: 'openai/gpt-image-2', prompt: '猫', n: 1 } });
  assert.equal(wrongModel.status, 400);
  assert.match(wrongModel.data.error.message, /不支持图片模型 openai\/gpt-image-2/);
  assert.equal((await call('POST', '/api/images', { payload: { model: IMAGE, prompt: '  ' } })).status, 400);
  assert.equal(sent('/images/generations').length, before);

  const failed = await call('POST', '/api/images', { payload: { model: IMAGE, prompt: 'FAIL', n: 1 } });
  const item = await waitItem(failed.data.items[0].id, (i) => i.status === 'failed', '生图失败');
  assert.equal(item.error.message, '火山方舟 服务暂时异常，请稍后重试');
  assert.match(item.error.detail, /^火山方舟（InternalServiceError）：/);
  assert.equal(item.mediaUrl, null);
});

test('语音：用豆包语音，Key 另外存；音色是登记好的；音频分段返回，拼起来存成 MP3', async () => {
  const voices = (await call('GET', '/api/voices')).data.items;
  assert.equal(voices.length > 200, true);
  assert.deepEqual(voices[0], { id: 'zh_female_vv_uranus_bigtts', name: 'Vivi 2.0 - 通用场景', gender: 'female', language: 'zh', accent: '', previewUrl: '' });
  assert.equal(voices.some((v) => v.language === 'en' && v.gender === 'male'), true);
  // 墨西哥西语的音色 ID 以 mx 开头，语言记成 es。
  assert.equal(voices.some((v) => v.language === 'mx'), false);

  // 没填豆包语音的 Key：不发请求，提示去设置里填。方舟的 Key 不能代替它。
  const noKey = await call('POST', '/api/audio/speech', { text: '你好', voiceId: 'zh_female_vv_uranus_bigtts' });
  assert.equal(noKey.status, 401);
  assert.match(noKey.data.error.message, /豆包语音的 API Key/);

  const saved = (await call('PUT', '/api/key', { apiKey: MOCK_SPEECH_KEY, service: 'speech' })).data;
  assert.equal(saved.speech.hasKey, true);
  assert.equal(saved.hasKey, true);
  assert.equal(JSON.stringify(saved).includes(MOCK_SPEECH_KEY), false);

  assert.equal((await call('POST', '/api/audio/speech', { text: '没选音色' })).status, 400);
  const created = await call('POST', '/api/audio/speech', { text: '你好，世界', voiceId: 'zh_female_vv_uranus_bigtts', voiceName: 'Vivi 2.0' });
  assert.equal(created.status, 200);
  assert.equal(created.data.tool, 'speech');
  assert.equal(created.data.model, 'seed-tts-2.0');
  const done = await waitItem(created.data.id, (i) => i.status === 'completed', '语音生成完');
  assert.match(done.mediaUrl, /^\/media\/audio\/aud_\w+\.mp3$/);
  assert.deepEqual(done.usage, { text_words: 5 });
  const file = await fetch(base + done.mediaUrl);
  assert.equal(file.headers.get('content-type'), 'audio/mpeg');
  assert.equal(await file.text(), 'mock mp3 zh_female_vv_uranus_bigtts 你好，世界');
  assert.deepEqual(sent('/api/v3/tts/unidirectional').at(-1), { req_params: { text: '你好，世界', speaker: 'zh_female_vv_uranus_bigtts', audio_params: { format: 'mp3', sample_rate: 24000 } } });

  const failed = await call('POST', '/api/audio/speech', { text: 'FAIL', voiceId: 'zh_female_vv_uranus_bigtts' });
  const item = await waitItem(failed.data.id, (i) => i.status === 'failed', '语音失败');
  // 出错的 code 夹在 200 的流里：不提状态码，按服务出错说。
  assert.equal(item.error.message, '豆包语音 服务暂时异常，请稍后重试');
  assert.equal(item.error.detail, '豆包语音（55000000）：synthesis failed {internal}');
});

test('音效和配乐：用豆包语音的音频生成，时长写在描述里；配乐可以带上要配的那条视频', async () => {
  const sfx = await call('POST', '/api/audio/sfx', { text: '厚重的关门声', duration: 2 });
  assert.equal(sfx.status, 200);
  assert.deepEqual([sfx.data.tool, sfx.data.model, sfx.data.payload], ['sfx', 'seed-audio-1.0', { text: '厚重的关门声', duration_seconds: 2 }]);
  const made = await waitItem(sfx.data.id, (i) => i.status === 'completed', '音效生成完');
  assert.match(made.mediaUrl, /^\/media\/audio\/aud_\w+\.mp3$/);
  assert.deepEqual(made.usage, { audio_seconds: 2 });
  assert.deepEqual(sent('/api/v3/tts/create').at(-1), { model: 'seed-audio-1.0', text_prompt: '音效：厚重的关门声。只要音效，不要人声，不要音乐。时长 2 秒。', audio_config: { format: 'mp3' } });
  // 不带时长就不写进描述，交给模型决定。
  assert.deepEqual((await call('POST', '/api/audio/sfx', { text: '雨声' })).data.payload, { text: '雨声' });
  assert.equal((await call('POST', '/api/audio/sfx', { text: '太长', duration: 300 })).status, 400);
  assert.equal((await call('POST', '/api/audio/sfx', { text: ' ' })).status, 400);

  const video = (await upload(Buffer.from('fake mp4 bytes'), 'video/mp4')).data.url;
  const music = await call('POST', '/api/audio/music', { text: '轻快的钢琴', duration: 5, video, form: { video: { url: video } } });
  assert.equal(music.status, 200);
  assert.deepEqual(music.data.payload, { text: '轻快的钢琴', duration_seconds: 5, video });
  await waitItem(music.data.id, (i) => i.status === 'completed', '配乐生成完');
  assert.equal(sent('/api/v3/tts/create').at(-1).text_prompt, '纯音乐，没有人声：轻快的钢琴。时长 5 秒。');
  // 没有描述、没有时长、带的不是视频、文件不存在，都在本地拦下。
  assert.equal((await call('POST', '/api/audio/music', { text: '', duration: 5 })).status, 400);
  assert.equal((await call('POST', '/api/audio/music', { text: '钢琴' })).status, 400);
  assert.equal((await call('POST', '/api/audio/music', { text: '钢琴', duration: 5, video: (await upload()).data.url })).status, 400);
  assert.equal((await call('POST', '/api/audio/music', { text: '钢琴', duration: 5, video: '/media/videos/../config.json' })).status, 400);

  const failed = await call('POST', '/api/audio/sfx', { text: 'FAIL' });
  const item = await waitItem(failed.data.id, (i) => i.status === 'failed', '音效失败');
  assert.match(item.error.message, /^内容未通过审核/);
  assert.equal(item.error.detail, '豆包语音（45001125）：text audit failed');
});

test('缩略图：图片和视频存到本机后各做一张小图，删记录时一起删', { skip: !hasFfmpeg && '本机没有 ffmpeg' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innate-media-'));
  const ffmpeg = (...args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', ...args]);
  ffmpeg('-i', 'color=c=red:s=1280x720', '-frames:v', '1', path.join(dir, 'a.png'));
  ffmpeg('-i', 'testsrc=s=1280x720:d=1', '-pix_fmt', 'yuv420p', path.join(dir, 'a.mp4'));
  mock.files.picture = fs.readFileSync(path.join(dir, 'a.png'));
  mock.files.sample = fs.readFileSync(path.join(dir, 'a.mp4'));
  try {
    const image = await call('POST', '/api/images', { payload: { model: IMAGE, prompt: '红色', n: 1 } });
    const picture = await waitItem(image.data.items[0].id, (i) => i.thumbUrl, '图片的小图做好');
    assert.match(picture.thumbUrl, /^\/media\/thumbs\/img_\w+\.jpg$/);
    const small = await fetch(base + picture.thumbUrl);
    assert.equal(small.headers.get('content-type'), 'image/jpeg');
    assert.match(small.headers.get('cache-control'), /immutable/);
    assert.ok((await small.arrayBuffer()).byteLength > 100);

    const created = await call('POST', '/api/videos', { payload: videoPayload('测试画面') });
    const clip = await waitItem(created.data.id, (i) => i.thumbUrl, '视频的封面做好');
    assert.deepEqual([clip.media.width, clip.media.height, Math.round(clip.media.duration)], [1280, 720, 1]);

    const file = path.join(dataDir, 'thumbs', path.basename(clip.thumbUrl));
    assert.ok(fs.existsSync(file));
    await call('DELETE', `/api/history/${clip.id}`);
    assert.equal(fs.existsSync(file), false);
  } finally {
    mock.files.picture = PNG;
    mock.files.sample = null;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('本机上传：只收图片、视频和 MP3、WAV 音频；/media 只给出这几个目录里的文件', async () => {
  assert.equal((await upload(Buffer.from('x'), 'application/zip')).status, 415);
  assert.equal((await upload(Buffer.from('x'), 'audio/ogg')).status, 415);
  const sound = await upload(Buffer.from('ID3 fake'), 'audio/mpeg');
  assert.equal(sound.status, 200);
  assert.match(sound.data.url, /^\/media\/uploads\/[\w-]+\.mp3$/);
  assert.equal((await upload(Buffer.alloc(0), 'image/png')).status, 400);
  assert.equal((await fetch(`${base}/media/config.json`)).status, 404);
  assert.equal((await fetch(`${base}/media/uploads/..%2Fconfig.json`)).status, 404);
  // 超过大小上限：返回 413 和说明，而不是断开连接。
  const big = await upload(Buffer.alloc(65 * 1024 * 1024), 'video/mp4');
  assert.equal(big.status, 413);
  assert.match(big.data.error.message, /文件过大/);
});

test('提示词润色：用豆包的文本模型，关掉深度思考；选中的模型不行就换下一个', async () => {
  const res = await call('POST', '/api/polish', { text: '清晨的厨房', kind: 'video', model: TEXT, target: { model: VIDEO, mode: 'text' } });
  assert.equal(res.status, 200);
  assert.equal(res.data.text, '润色后的：清晨的厨房');
  assert.equal(res.data.model, TEXT);
  assert.deepEqual(sent('/chat/completions').at(-1).thinking, { type: 'disabled' });

  // 选中的模型被限流：自动换下一个，并说明这次用的是谁。
  const chats = () => sent('/chat/completions').length;
  const before = chats();
  const limited = await call('POST', '/api/polish', { text: 'LIMITED 清晨的厨房', kind: 'video', model: TEXT });
  assert.equal(limited.status, 200);
  assert.equal(limited.data.model, NEXT_TEXT);
  assert.equal(chats(), before + 2);
  // 刚失败过的模型先不再试，直接用能用的那个。
  const again = await call('POST', '/api/polish', { text: 'LIMITED 再来一次', kind: 'video', model: TEXT });
  assert.equal(again.data.model, NEXT_TEXT);
  assert.equal(chats(), before + 3);
  assert.equal((await call('POST', '/api/polish', { text: '清晨的厨房', kind: 'video', model: 'claude-haiku-5-5' })).status, 400);
  assert.equal((await call('POST', '/api/polish', { text: '一张表格', kind: 'table', model: TEXT })).status, 400);
  assert.equal((await call('POST', '/api/polish', { text: ' ', kind: 'video', model: TEXT })).status, 400);
});

test('提示词润色：按要用的生成模型选规则', async () => {
  // 发给文本模型的系统提示词。
  const guideFor = async (kind, target) => {
    const res = await call('POST', '/api/polish', { text: '清晨的厨房', kind, model: NEXT_TEXT, target });
    assert.equal(res.status, 200);
    return sent('/chat/completions').at(-1).messages[0].content;
  };
  const seedance = await guideFor('video', { model: VIDEO, mode: 'text' });
  assert.match(seedance, /Seedance 视频模型/);
  assert.match(seedance, /镜头1/);
  assert.doesNotMatch(seedance, /首尾帧生成|参考生成/);
  // 不说是哪个模型时，按 Seedance 2.0 来。
  assert.equal(await guideFor('video'), seedance);
  assert.match(await guideFor('video', { model: VIDEO, mode: 'frames' }), /首尾帧生成/);
  assert.match(await guideFor('video', { model: 'doubao-seedance-2-5-260628', mode: 'text', duration: 10 }), /Seedance 2\.5/);
  // 参考生成：告诉它带了几份素材、该怎么称呼。
  const reference = await guideFor('video', { model: VIDEO, mode: 'reference', refs: { image: 2, video: 0, audio: 1 } });
  assert.match(reference, /图片 2 张、音频 1 段/);
  assert.doesNotMatch(reference, /视频 \d+ 段/);

  assert.match(await guideFor('image', { model: IMAGE }), /Seedream/);
  assert.match(await guideFor('image', { model: IMAGE, refs: { image: 2 } }), /带了 2 张参考图/);
  assert.doesNotMatch(await guideFor('image', { model: 'some-other-image-model' }), /Seedream/);
  // 语音改的是要朗读的文稿，音效和配乐各有各的写法。
  assert.match(await guideFor('speech'), /适合朗读/);
  assert.match(await guideFor('sfx'), /生成一段音效/);
  assert.match(await guideFor('music'), /没有人声的配乐/);
});

test('删除记录：同时删掉本机的视频文件', async () => {
  const created = await call('POST', '/api/videos', { payload: videoPayload('用来删除的一条') });
  const done = await refreshUntil(created.data.id, (item) => item.savedLocally, '视频保存到本机');
  const file = path.join(dataDir, 'videos', done.localFile);
  assert.ok(fs.existsSync(file));

  assert.equal((await call('DELETE', `/api/history/${created.data.id}`)).status, 204);
  assert.equal(fs.existsSync(file), false);
  assert.equal((await call('GET', '/api/history')).data.items.some((i) => i.id === created.data.id), false);
});

test('文本节点：让文本模型写一段文字，参考内容和要求一起发过去', async () => {
  const before = mock.log.length;
  const res = await call('POST', '/api/text', { prompt: '写成三句分镜', context: '一只猫在窗台上', model: TEXT });
  assert.equal(res.status, 200);
  const request = sent('/chat/completions', before).at(-1);
  assert.equal(request.messages[1].content, '参考内容：\n一只猫在窗台上\n\n要求：\n写成三句分镜');
  assert.equal((await call('POST', '/api/text', { prompt: '', model: TEXT })).status, 400);
  assert.equal((await call('POST', '/api/text', { prompt: '写点什么', model: 'not-a-model' })).status, 400);
});

test('工作流：存一组节点和连线、列表只给概要、读回、改名、删除；空的不收', async () => {
  const nodes = [{ id: 'a', type: 'text', position: { x: 0, y: 0 }, data: { text: '设定' } }, { id: 'b', type: 'image', position: { x: 360, y: 0 }, data: { prompt: '', model: 'm', ratio: '1:1' } }];
  const edges = [{ id: 'e', source: 'a', target: 'b', data: { kind: 'text' } }];
  assert.equal((await call('POST', '/api/workflows', { name: 'x', nodes: [], edges: [] })).status, 400);
  const made = await call('POST', '/api/workflows', { name: '  角色出图  ', nodes, edges });
  assert.equal(made.status, 200);
  assert.match(made.data.id, /^wf_/);
  assert.deepEqual([made.data.name, made.data.count], ['角色出图', 2]);
  const list = await call('GET', '/api/workflows');
  assert.equal(list.data.items.find((w) => w.id === made.data.id).nodes, undefined);
  const read = await call('GET', `/api/workflows/${made.data.id}`);
  assert.deepEqual([read.data.nodes, read.data.edges], [nodes, edges]);
  assert.equal((await call('PUT', `/api/workflows/${made.data.id}`, { name: '新名字' })).data.name, '新名字');
  assert.equal((await call('DELETE', `/api/workflows/${made.data.id}`)).status, 204);
  assert.equal((await call('GET', `/api/workflows/${made.data.id}`)).status, 404);
});

test('画布：新建、保存、读回、改名、删除', async () => {
  const created = await call('POST', '/api/canvases', {});
  assert.equal(created.status, 200);
  assert.match(created.data.id, /^cv_/);
  assert.equal(created.data.name, '未命名画布');
  const { id } = created.data;
  // 没起名字的接着编号，不重名。
  const second = await call('POST', '/api/canvases', {});
  assert.equal(second.data.name, '未命名画布 2');
  assert.equal((await call('DELETE', `/api/canvases/${second.data.id}`)).status, 204);

  const nodes = [{ id: 'n1', type: 'text', position: { x: 10, y: 20 }, data: { text: '一只猫' } }, { id: 'n2', type: 'video', position: { x: 400, y: 20 }, data: { prompt: '', model: 'seedance-2.0' } }];
  const edges = [{ id: 'e1', source: 'n1', target: 'n2', type: 'link', data: { kind: 'text' } }];
  const saved = await call('PUT', `/api/canvases/${id}`, { name: '  分镜一  ', nodes, edges, viewport: { x: 1, y: 2, zoom: 0.5 }, cover: { url: '/media/images/a.png', kind: 'image', extra: 1 } });
  assert.deepEqual(saved.data.cover, { url: '/media/images/a.png', kind: 'image' });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.name, '分镜一');

  const read = await call('GET', `/api/canvases/${id}`);
  assert.deepEqual(read.data.nodes, nodes);
  assert.deepEqual(read.data.edges, edges);
  assert.deepEqual(read.data.viewport, { x: 1, y: 2, zoom: 0.5 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'canvases.json'), 'utf8')).find((c) => c.id === id).nodes, nodes);

  // 只改名字不动内容；节点不是数组的请求不收。
  await call('PUT', `/api/canvases/${id}`, { name: '' });
  assert.equal((await call('GET', `/api/canvases/${id}`)).data.nodes.length, 2);
  assert.equal((await call('PUT', `/api/canvases/${id}`, { nodes: 'x' })).status, 400);

  const list = await call('GET', '/api/canvases');
  assert.deepEqual(list.data.items.find((c) => c.id === id).name, '未命名画布');
  assert.equal(list.data.items.find((c) => c.id === id).nodes, undefined);
  assert.deepEqual(list.data.items.find((c) => c.id === id).cover, { url: '/media/images/a.png', kind: 'image' });
  assert.equal((await call('PUT', `/api/canvases/${id}`, { cover: null })).data.cover, null);

  assert.equal((await call('DELETE', `/api/canvases/${id}`)).status, 204);
  assert.equal((await call('GET', `/api/canvases/${id}`)).status, 404);
});

test('角色：新建、从生成记录选的图会复制一份、改、删', async () => {
  const shot = await upload(PNG, 'image/png');
  // 生成一张图，拿它当角色的参考图。
  const made = await call('POST', '/api/images', { payload: { model: IMAGE, prompt: '穿风衣的女人，正面全身', n: 1 } });
  const image = await waitItem(made.data.items[0].id, (item) => item.status === 'completed', '图片生成完成');

  const created = await call('POST', '/api/characters', { name: '  林晚  ', description: '二十多岁，黑色长发，米色风衣', images: [shot.data.url, image.mediaUrl] });
  assert.equal(created.status, 200);
  assert.match(created.data.id, /^ch_/);
  assert.equal(created.data.name, '林晚');
  // 上传来的图原样用；生成记录里的图复制到 uploads，记录删了角色的图还在。
  assert.equal(created.data.images[0], shot.data.url);
  assert.match(created.data.images[1], /^\/media\/uploads\/up_[0-9a-f]+\.\w+$/);
  await call('DELETE', `/api/history/${image.id}`);
  assert.equal((await fetch(base + image.mediaUrl)).status, 404);
  assert.equal((await fetch(base + created.data.images[1])).status, 200);

  const { id } = created.data;
  const renamed = await call('PUT', `/api/characters/${id}`, { name: '', images: [created.data.images[1]] });
  assert.equal(renamed.data.name, '未命名角色');
  assert.deepEqual(renamed.data.images, [created.data.images[1]]);
  assert.equal(renamed.data.description, '二十多岁，黑色长发，米色风衣');

  // 不在本机的图、不是图片的文件、太多张都不收。
  assert.equal((await call('PUT', `/api/characters/${id}`, { images: ['/media/uploads/up_none.png'] })).status, 400);
  assert.equal((await call('PUT', `/api/characters/${id}`, { images: ['https://example.com/a.png'] })).status, 400);
  const clip = await upload(Buffer.from('not really a video'), 'video/mp4');
  assert.equal((await call('PUT', `/api/characters/${id}`, { images: [clip.data.url] })).status, 400);
  assert.equal((await call('PUT', `/api/characters/${id}`, { images: Array(7).fill(shot.data.url) })).status, 400);

  assert.equal((await call('GET', '/api/characters')).data.items.find((c) => c.id === id).images.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'characters.json'), 'utf8')).length, 1);
  assert.equal((await call('DELETE', `/api/characters/${id}`)).status, 204);
  assert.equal((await call('DELETE', `/api/characters/${id}`)).status, 404);
});

test('技能：官方的只读，自己建的能改能删，扩写时把规则和这次的设置一起发给文本模型', async () => {
  const listed = await call('GET', '/api/skills');
  const official = listed.data.items.filter((s) => s.official);
  assert.deepEqual(official.map((s) => s.name), ['多镜头成片', '角色设定图', '分镜首帧']);
  assert.equal((await call('PUT', `/api/skills/${official[0].id}`, { name: 'x' })).status, 400);
  assert.equal((await call('DELETE', `/api/skills/${official[0].id}`)).status, 400);

  const rules = '把用户的一句话写成产品展示视频的提示词：干净的棚拍环境，缓慢环绕。';
  assert.equal((await call('POST', '/api/skills', { name: '', type: 'video', rules })).status, 400);
  assert.equal((await call('POST', '/api/skills', { name: '产品展示', type: 'speech', rules })).status, 400);
  assert.equal((await call('POST', '/api/skills', { name: '产品展示', type: 'video', rules: '短' })).status, 400);
  const created = await call('POST', '/api/skills', { name: ' 产品展示 ', description: '棚拍环绕', type: 'video', rules });
  assert.equal(created.status, 200);
  assert.match(created.data.id, /^sk_/);
  assert.equal(created.data.name, '产品展示');
  assert.deepEqual(created.data.tags, []);
  assert.ok(official.every((s) => s.tags.length));
  const { id } = created.data;
  // 只改说明，别的不动。
  const edited = await call('PUT', `/api/skills/${id}`, { description: '新的说明' });
  assert.equal(edited.data.description, '新的说明');
  assert.equal(edited.data.rules, rules);
  // 标签去掉空的和重复的，最多 3 个；不传就不动。
  assert.equal((await call('PUT', `/api/skills/${id}`, { tags: '产品' })).status, 400);
  assert.deepEqual((await call('PUT', `/api/skills/${id}`, { tags: [' 产品 ', '', '产品', '棚拍', '广告', '环绕'] })).data.tags, ['产品', '棚拍', '广告']);
  assert.deepEqual((await call('PUT', `/api/skills/${id}`, { name: '产品展示' })).data.tags, ['产品', '棚拍', '广告']);
  assert.equal((await call('GET', '/api/skills')).data.items.length, official.length + 1);

  const before = mock.log.length;
  const expanded = await call('POST', '/api/skills/expand', { id, text: '一只白色的陶瓷杯', context: '时长：5 秒', model: TEXT });
  assert.equal(expanded.status, 200);
  assert.ok(expanded.data.text.includes('一只白色的陶瓷杯'));
  const request = sent('/chat/completions', before).at(-1);
  assert.equal(request.messages[0].content, rules);
  assert.equal(request.messages[1].content, '时长：5 秒\n\n一只白色的陶瓷杯', '这次的设置应当放在用户那句话前面');
  assert.equal((await call('POST', '/api/skills/expand', { id, text: '', model: TEXT })).status, 400);
  assert.equal((await call('POST', '/api/skills/expand', { id: 'sk_none', text: 'x', model: TEXT })).status, 404);
  assert.equal((await call('POST', '/api/skills/expand', { id, text: 'x', model: 'not-a-model' })).status, 400);

  assert.equal((await call('DELETE', `/api/skills/${id}`)).status, 204);
  assert.equal((await call('GET', '/api/skills')).data.items.length, official.length);
});
