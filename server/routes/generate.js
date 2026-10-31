// 生成这一组接口：视频、图片、语音、音效、配乐，生成记录的查看和删除，从本机上传输入文件。

import fs from 'node:fs';
import path from 'node:path';
import { AIHUBMIX, ARK, DOUBAO_SPEECH, MINIMAX, MAX_IMAGES, MAX_UPLOAD_BYTES } from '../config.js';
import { HttpError, readBody, readJsonBody, route } from '../http.js';
import { aihubmixKey, speechKey } from '../keys.js';
import { callAihubmix, upstreamError, callArk, callMinimax, listOf, requireKey } from '../ark.js';
import { doubaoSpeech, doubaoAudio } from '../speech.js';
import { UPLOAD_TYPES, localMediaFile, withLocalFiles } from '../media.js';
import { withPublicVideos } from '../publishing.js';
import { MINIMAX_VIDEO_PATH, VIDEO_TASKS_PATH, applyTaskState, downloadResult, finishItem, historyView, isLegacy, isPending, isTimedOut, newId, newItem, pollTask, runDirect } from '../tasks.js';
import { removeThumb } from '../thumbs.js';
import { balanceOf, holdCredits, syncCredits } from '../credits.js';
import { IMAGE_MODELS, VIDEO_MODELS, imageProvider, videoProvider } from '../../shared/models.ts';
import { doubaoVoices } from '../../shared/doubao-voices.ts';

// ---------- 视频 ----------

// 页面发来的提示词是 prompt 字符串，素材在 frame_images 和 input_references 里，可以只给素材不写提示词；
// 发出去之前换成平台自己的 content 数组。模型在哪个平台上（火山方舟、MiniMax）登记在 shared/models.ts。
route('POST', /^\/api\/videos$/, async ({ req, space, user }) => {
  const { payload, form } = await readJsonBody(req);
  const hasPrompt = typeof payload?.prompt === 'string' && payload.prompt.trim() !== '';
  const hasMedia = ['frame_images', 'input_references'].some((field) => Array.isArray(payload?.[field]) && payload[field].length > 0);
  if (!payload || typeof payload !== 'object' || !payload.model || (!hasPrompt && !hasMedia)) {
    throw new HttpError(400, 'invalid_request', '请求缺少 model 或提示词');
  }
  const provider = videoProvider(payload.model);
  if (!provider) throw new HttpError(400, 'invalid_request', `不支持视频模型 ${payload.model}`);
  // 分辨率按模型登记的档位校验（如 2.0 Fast/Mini 只到 720p），旧的画布节点或手工请求带超档值就在这里拦下。
  const spec = VIDEO_MODELS[payload.model];
  if (payload.resolution && spec && !spec.resolutions.includes(String(payload.resolution))) {
    throw new HttpError(400, 'invalid_request', `${payload.model} 不支持 ${payload.resolution}，可选：${spec.resolutions.join('、')}`);
  }
  const minimax = provider === 'minimax';
  // 先预扣积分再提交；没提交成功就退回。
  const draft = { kind: 'video', model: payload.model, payload };
  holdCredits(user, [draft]);
  let data;
  try {
    // 参考视频不能内嵌：先把 /media 开头的本机视频按需上传到 TOS，换成公网直链再提交。
    const publicPayload = await withPublicVideos(space, payload);
    ({ data } = minimax
      ? await callMinimax('POST', MINIMAX_VIDEO_PATH, { json: minimaxVideoRequest(withLocalFiles(space, publicPayload)) })
      : await callArk('POST', VIDEO_TASKS_PATH, { json: arkVideoRequest(withLocalFiles(space, publicPayload)) }));
    if (!(data?.id || data?.task_id)) throw new HttpError(502, 'bad_upstream_response', `${(minimax ? MINIMAX : ARK).label} 未返回任务 ID`, data);
  } catch (err) {
    syncCredits(space, { ...draft, status: 'failed' });
    throw err;
  }
  const id = data.id || data.task_id;

  const item = newItem({
    id: String(id),
    provider,
    kind: 'video',
    createdAt: data.created_at ? data.created_at * 1000 : Date.now(),
    model: payload.model,
    prompt: String(payload.prompt || '').trim(),
    payload,
    form: form || null,
    status: 'queued',
    lastPolledAt: Date.now(),
    ...(draft.credits ? { credits: draft.credits } : {}),
  });
  applyTaskState(item, data);
  syncCredits(space, item);
  space.history.unshift(item);
  space.save('history');
  return historyView(item, undefined, space);
});

// 把页面发来的视频请求换成火山方舟的格式：提示词和素材都放进 content 数组，每份素材用 role 说明它的用途。
// 首帧、尾帧的 role 就是页面给的 frame_type（first_frame、last_frame），参考素材按类型是 reference_image、reference_video、reference_audio。
// 没有指定画面比例时（给了首帧）用 adaptive，由模型跟着图片定。水印默认关着，这里写明。
function arkVideoRequest(payload) {
  const content = [];
  const text = String(payload.prompt || '').trim();
  if (text) content.push({ type: 'text', text });
  for (const frame of payload.frame_images || []) content.push({ type: 'image_url', image_url: frame.image_url, role: frame.frame_type });
  for (const ref of payload.input_references || []) {
    const kind = ['image', 'video', 'audio'].find((k) => ref?.[`${k}_url`]);
    if (kind) content.push({ type: `${kind}_url`, [`${kind}_url`]: ref[`${kind}_url`], role: `reference_${kind}` });
  }
  const request = { model: payload.model, content, resolution: payload.resolution, ratio: payload.aspect_ratio || 'adaptive', duration: payload.duration, watermark: false };
  // Seedance 2.5 的子任务类型引导（reference/edit/extend）：显式指定能把参数报错前置，其余型号不带。
  if (payload.omni_reference_task_type) request.omni_reference_task_type = payload.omni_reference_task_type;
  if (typeof payload.generate_audio === 'boolean') request.generate_audio = payload.generate_audio;
  if (Number.isInteger(payload.seed)) request.seed = payload.seed;
  return request;
}

// MiniMax H3 的格式和火山方舟几乎一样，也是 content 数组加 role。不一样的地方：
// 提示词必填；文生视频必须指定画面比例，不能是 adaptive；给了首尾帧时比例跟着图片走，不用传；没有要不要声音、随机种子这两个参数。
function minimaxVideoRequest(payload) {
  const { content } = arkVideoRequest(payload);
  if (content[0]?.type !== 'text') throw new HttpError(400, 'invalid_request', `${payload.model} 须填写提示词`);
  const request = { model: payload.model, content, resolution: payload.resolution, duration: payload.duration };
  const textOnly = content.length === 1;
  if (textOnly && !payload.aspect_ratio) throw new HttpError(400, 'invalid_request', '文生视频须指定画面比例');
  if (payload.aspect_ratio && !(payload.frame_images || []).length) request.ratio = payload.aspect_ratio;
  return request;
}

// ---------- 生成记录 ----------

// 多人模式下带上这个人剩多少积分：页面本来就一直在读记录，余额跟着它更新。
route('GET', /^\/api\/history$/, async ({ space, user }) => ({ items: space.history.map((item) => historyView(item, user, space)), ...(user ? { credits: balanceOf(user.id) } : {}) }));

// 刷新一条记录。带 ?wait=N（秒，最多 60）时服务端长轮询：一直查到完成/失败或超时再返回，
// 这样 Agent 用 curl 调一次就能拿到结果，不用自己 sleep 循环。
route('POST', /^\/api\/history\/([^/]+)\/refresh$/, async ({ params, space, user, query }) => {
  const item = space.history.find((h) => h.id === params[0]);
  if (!item) throw new HttpError(404, 'not_found', '记录不存在');
  // direct 的记录没有任务可查；别的平台留下的记录也查不了。
  if (item.direct || isLegacy(item)) return historyView(item, user, space);
  const deadline = Date.now() + Math.min(Number(query.get('wait')) || 0, 60) * 1000;
  do {
    if (isPending(item) || isTimedOut(item)) {
      await pollTask(space, item);
    } else if (item.status === 'completed' && !item.localFile) {
      item.downloadAttempts = 0;
      await downloadResult(space, item);
    }
    if (item.status === 'completed' || item.status === 'failed') break;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  } while (Date.now() < deadline);
  return historyView(item, user, space);
});

route('DELETE', /^\/api\/history\/([^/]+)$/, async ({ params, space }) => {
  const index = space.history.findIndex((h) => h.id === params[0]);
  if (index === -1) throw new HttpError(404, 'not_found', '记录不存在');
  const [item] = space.history.splice(index, 1);
  // 一份记录可能有一组结果文件（AutoDL 的工作流会出好几个），主文件和其余的都要删。
  const dir = space.resultDir(item);
  for (const file of [item.localFile, ...(item.extraFiles || []).map((entry) => entry?.file)]) {
    if (file) fs.rmSync(path.join(dir, path.basename(file)), { force: true });
  }
  removeThumb(space, item);
  space.save('history');
  return null;
});

// ---------- 图片 ----------

const IMAGE_EXT = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' };

route('POST', /^\/api\/images$/, async ({ req, space, user }) => {
  const { payload, form } = await readJsonBody(req);
  const model = String(payload?.model || '');
  const prompt = String(payload?.prompt || '').trim();
  if (!model || !prompt) throw new HttpError(400, 'invalid_request', '请求缺少 model 或提示词');
  const provider = imageProvider(model);
  if (!provider) throw new HttpError(400, 'invalid_request', `不支持图片模型 ${model}`);
  const aihubmix = provider === 'aihubmix';
  if (aihubmix && !aihubmixKey()) throw new HttpError(401, 'no_api_key', `请先在「管理」中配置 ${AIHUBMIX.label} 的 API Key。`);
  if (!aihubmix) requireKey();
  const platform = aihubmix ? AIHUBMIX : ARK;
  const spec = IMAGE_MODELS[model];
  const count = Math.min(MAX_IMAGES, Math.max(1, Math.round(Number(payload.n)) || 1));
  const request = { model, prompt, n: count };
  if (payload.aspect_ratio) request.aspect_ratio = String(payload.aspect_ratio);
  // 分辨率档位（1K、2K 这样）。
  if (payload.resolution) request.resolution = String(payload.resolution);
  if (request.resolution && !spec.sizes[request.resolution]) throw new HttpError(400, 'invalid_request', `${model} 不支持 ${request.resolution}，可选：${Object.keys(spec.sizes).join('、')}`);
  // 画质：只有分画质的模型（GPT Image 2.5）才带，没选就用它默认的那一档。
  if (spec.qualities) {
    request.quality = String(payload.quality || spec.quality);
    if (!spec.qualities.includes(request.quality)) throw new HttpError(400, 'invalid_request', `${model} 不支持画质 ${request.quality}，可选：${spec.qualities.join('、')}`);
  }
  // 参考图（图生图）。每个型号收几张登记在 shared/models.ts。
  const refs = Array.isArray(payload.input_references) ? payload.input_references.filter((entry) => typeof entry?.image_url?.url === 'string') : [];
  if (refs.length) {
    if (spec.refs === 0) throw new HttpError(400, 'invalid_request', `${model} 不支持参考图`);
    if (refs.length > spec.refs) throw new HttpError(400, 'invalid_request', `${model} 最多支持 ${spec.refs} 张参考图`);
    request.input_references = withLocalFiles(space, { input_references: refs }).input_references;
  }

  // 一次请求出几张，就建几条记录，每张图各自一条。
  const items = Array.from({ length: count }, () =>
    newItem({ id: newId('img'), provider, kind: 'image', model, prompt, payload: { model, prompt, aspect_ratio: request.aspect_ratio, ...(request.resolution ? { resolution: request.resolution } : {}), ...(request.quality ? { quality: request.quality } : {}), ...(refs.length ? { input_references: refs } : {}) }, form: form || null }),
  );
  holdCredits(user, items);
  runDirect(space, items, async () => {
    const images = await (aihubmix ? aihubmixImages : arkImages)(spec, request);
    if (!images.length) throw new HttpError(502, 'bad_upstream_response', `${platform.label} 未返回图片`);
    items.forEach((item, index) => {
      const image = images[index];
      if (!image) {
        item.status = 'failed';
        item.error = { message: '该图片生成失败', code: 'missing_image' };
        return;
      }
      // 没写格式的按 JPG 存（Seedream 默认出 JPG）。
      const type = image.mime_type || image.media_type;
      const ext = image.ext || (type ? IMAGE_EXT[type] : 'jpg');
      if (!ext) {
        item.status = 'failed';
        item.error = { message: `不支持模型返回的格式（${type}）`, code: 'unsupported_image' };
        return;
      }
      finishItem(space, item, image.bytes || Buffer.from(image.b64_json, 'base64'), ext, image.usage ? { usage: image.usage } : {});
    });
  });
  return { items: items.map(historyView) };
});

// 火山方舟的生图接口（Seedream）。5.0 pro 和 5.0 flash 一次只出一张，所以要几张就发几次、同时进行，各出一张；有一次失败了，其余成功的照样留下。
// 图片大小写成「宽x高」，按分辨率档位和画面比例查登记好的像素值，没指定档位就用这个模型默认的那一档；参考图放在 image 数组里，本机的图已经换成内嵌数据。
// 返回的用量只有张数和 token，没有金额。每张图记下 token 和实际大小，费用按张、按像素档位估算（shared/models.ts 的 estimateCost）。
async function arkImages(spec, { model, prompt, n, aspect_ratio, resolution, input_references }) {
  const sizes = spec.sizes[resolution || spec.size];
  const request = { model, prompt, size: sizes[aspect_ratio] || sizes['1:1'], response_format: 'b64_json', watermark: false };
  if (input_references) request.image = input_references.map((ref) => ref.image_url.url);
  const results = await Promise.allSettled(Array.from({ length: n }, () => callArk('POST', '/images/generations', { json: request, timeoutMs: 5 * 60 * 1000 })));
  const done = results.filter((r) => r.status === 'fulfilled').map((r) => r.value.data);
  if (!done.length) throw results[0].reason;
  return done.flatMap((data) => {
    const made = listOf(data).filter((image) => image?.b64_json);
    const tokens = Number(data?.usage?.total_tokens) || 0;
    return made.map((image) => ({ ...image, usage: { generated_images: 1, ...(tokens ? { total_tokens: Math.round(tokens / made.length) } : {}), size: image.size || request.size } }));
  });
}

// AiHubMix 的生图接口（GPT Image 2.5、Nano Banana 2.1）。和方舟一样要几张发几次、同时进行，有一次失败了其余成功的照样留下。
// 请求是它自己的格式：GPT Image 发「宽x高」，画质放在 extra.quality；Nano Banana 发画面比例和分辨率档位。参考图放在 images 数组里，本机的图已经换成内嵌数据。
// 默认是同步的：请求一直等到出图，返回一个任务对象，图在 output 里，要么是 b64_json，要么是 content_url（下载要带 Key，约 30 分钟过期）。
// 返回里没有用量，所以这几个模型不估算费用。
async function aihubmixImages(spec, { model, prompt, n, aspect_ratio, resolution, quality, input_references }) {
  const tier = resolution || spec.size;
  const request = { model, prompt, n: 1 };
  if (spec.byTier) Object.assign(request, { aspect_ratio: aspect_ratio || '1:1', resolution: tier });
  else request.size = spec.sizes[tier][aspect_ratio] || spec.sizes[tier]['1:1'];
  if (quality) request.extra = { quality };
  if (input_references) request.images = input_references.map((ref) => ref.image_url.url);
  const results = await Promise.allSettled(Array.from({ length: n }, () => aihubmixImage(request)));
  const done = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!done.length) throw results[0].reason;
  return done;
}

const IMAGE_MAGIC = [['png', '89504e47'], ['jpg', 'ffd8ff'], ['webp', '52494646']];

async function aihubmixImage(request) {
  let { data: task } = await callAihubmix('POST', '/ai/v1/images/generations', { json: request, timeoutMs: 10 * 60 * 1000 });
  // 同步的请求正常是带着结果回来的；万一回来时还没完成，就接着查，最多再等十分钟。
  for (let waited = 0; ['pending', 'in_progress'].includes(task?.status) && task.id && waited < 120; waited += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    task = (await callAihubmix('GET', `/ai/v1/images/${encodeURIComponent(task.id)}`, { timeoutMs: 20000 })).data;
  }
  if (task?.status !== 'completed') {
    const code = String(task?.error?.code || 'image_failed');
    throw upstreamError(AIHUBMIX.label, 502, code, task?.error?.message || `图片生成未完成（${task?.status || '无状态'}）`, task);
  }
  const output = (task.output || []).find((entry) => entry?.b64_json || entry?.content_url);
  if (!output) throw new HttpError(502, 'bad_upstream_response', `${AIHUBMIX.label} 未返回图片`, task);
  let bytes;
  if (output.b64_json) {
    bytes = Buffer.from(output.b64_json, 'base64');
  } else {
    // 只在 AiHubMix 自己的域名下才带上 Key，避免把 Key 发给别的主机。
    const url = new URL(output.content_url, AIHUBMIX.baseUrl);
    const headers = url.origin === new URL(AIHUBMIX.baseUrl).origin ? { Authorization: `Bearer ${aihubmixKey()}` } : {};
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5 * 60 * 1000) });
    if (!res.ok) throw new HttpError(502, 'download_failed', `${AIHUBMIX.label} 的图片下载返回 ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  }
  // 存成什么格式看文件开头的几个字节，不靠返回里的说明。
  const head = bytes.subarray(0, 4).toString('hex');
  const ext = IMAGE_MAGIC.find(([, magic]) => head.startsWith(magic))?.[0];
  if (!ext) throw new HttpError(502, 'unsupported_image', `${AIHUBMIX.label} 返回的不是 PNG、JPG 或 WebP 图片`);
  return { bytes, ext };
}

// ---------- 语音、音效、配乐 ----------
// 三样都走豆包语音，用的是同一个 Key。

function requireSpeechKey() {
  if (!speechKey()) throw new HttpError(401, 'no_api_key', '请先在「管理」中配置豆包语音的 API Key。');
}

// 豆包语音的音色是登记好的，不用去读。
route('GET', /^\/api\/voices$/, async () => ({ items: doubaoVoices() }));

route('POST', /^\/api\/audio\/speech$/, async ({ req, space, user }) => {
  const { text, voiceId, voiceName, form } = await readJsonBody(req);
  const script = String(text || '').trim();
  if (!script) throw new HttpError(400, 'invalid_request', '请输入朗读文本');
  if (!/^[\w-]+$/.test(voiceId || '')) throw new HttpError(400, 'invalid_request', '请选择音色');
  requireSpeechKey();
  const item = newItem({
    id: newId('aud'),
    kind: 'audio',
    tool: 'speech',
    model: DOUBAO_SPEECH.model,
    prompt: script,
    payload: { voice_id: voiceId, voice_name: String(voiceName || '') },
    form: form || null,
  });
  holdCredits(user, [item]);
  runDirect(space, [item], async () => {
    const { audio, usage } = await doubaoSpeech(script, voiceId);
    finishItem(space, item, audio, 'mp3', usage ? { usage } : {});
  });
  return historyView(item, user, space);
});

// 音效和配乐是同一个模型（seed-audio-1.0），区别只在怎么跟它说：要音效时说明不要人声和音乐，要配乐时说明是没有人声的纯音乐。
// 这个模型没有时长的参数，要多长也写在话里；一段最长 120 秒。
const MAX_AUDIO_SECONDS = 120;
function audioSeconds(value, required) {
  if (value == null || value === '') {
    if (required) throw new HttpError(400, 'invalid_request', '请选择时长');
    return null;
  }
  const seconds = Math.round(Number(value));
  if (!(seconds >= 1 && seconds <= MAX_AUDIO_SECONDS)) throw new HttpError(400, 'invalid_request', `时长须在 1–${MAX_AUDIO_SECONDS} 秒之间`);
  return seconds;
}

function submitAudio(space, user, { tool, prompt, request, payload, form }) {
  requireSpeechKey();
  const item = newItem({ id: newId('aud'), kind: 'audio', tool, model: DOUBAO_SPEECH.audioModel, prompt, payload, form: form || null });
  holdCredits(user, [item]);
  runDirect(space, [item], async () => {
    const { audio, usage } = await doubaoAudio(request);
    finishItem(space, item, audio, 'mp3', usage ? { usage } : {});
  });
  return historyView(item, user, space);
}

route('POST', /^\/api\/audio\/sfx$/, async ({ req, space, user }) => {
  const { text, duration, form } = await readJsonBody(req);
  const prompt = String(text || '').trim();
  if (!prompt) throw new HttpError(400, 'invalid_request', '请输入音效描述');
  // 不带时长时由模型自己决定。
  const seconds = audioSeconds(duration, false);
  const request = `音效：${prompt}。只要音效，不要人声，不要音乐。${seconds ? `时长 ${seconds} 秒。` : ''}`;
  return submitAudio(space, user, { tool: 'sfx', prompt, request, payload: { text: prompt, ...(seconds ? { duration_seconds: seconds } : {}) }, form });
});

// 配乐：按文字描述生成一段没有人声的音乐。video 是这段音乐要配的那条本机视频，只记在记录里，详情里拿它和音乐一起放；模型看不到它。
route('POST', /^\/api\/audio\/music$/, async ({ req, space, user }) => {
  const { text, duration, video, form } = await readJsonBody(req);
  const prompt = String(text || '').trim();
  if (!prompt) throw new HttpError(400, 'invalid_request', '请输入配乐描述');
  const seconds = audioSeconds(duration, true);
  if (video && !/\.(mp4|mov|webm)$/i.test(localMediaFile(space, video))) throw new HttpError(400, 'invalid_request', '请选择视频');
  const request = `纯音乐，没有人声：${prompt}。时长 ${seconds} 秒。`;
  return submitAudio(space, user, { tool: 'music', prompt, request, payload: { text: prompt, duration_seconds: seconds, ...(video ? { video } : {}) }, form });
});

// ---------- 上传 ----------

// 从本机选来当输入的文件先存到 uploads，之后用返回的地址引用它。
route('POST', /^\/api\/uploads$/, async ({ req, space, query }) => {
  const ext = UPLOAD_TYPES[String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()];
  if (!ext) throw new HttpError(415, 'unsupported_media_type', '只支持 JPG、PNG、WebP 图片，MP4、MOV、WebM 视频，MP3、WAV 音频');
  const body = await readBody(req, MAX_UPLOAD_BYTES);
  if (!body.length) throw new HttpError(400, 'invalid_request', '文件为空');
  const file = `${newId('up')}.${ext}`;
  fs.writeFileSync(path.join(space.dir('uploads'), file), body);
  const url = `/media/uploads/${file}`;
  const kind = /^(jpg|jpeg|png|webp)$/.test(ext) ? 'image' : /^(mp4|mov|webm)$/.test(ext) ? 'video' : 'audio';
  const requested = String(query.get('filename') || '').replace(/[\\/\x00-\x1f\x7f]/g, '').trim().slice(0, 160);
  const material = { id: newId('mat'), url, name: requested || `素材.${ext}`, kind, size: body.length, contentType: String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), createdAt: Date.now() };
  if (!Array.isArray(space.materials)) space.materials = [];
  space.materials.unshift(material);
  space.save('materials');
  return { url, size: body.length, material };
});
