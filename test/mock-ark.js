// 模拟火山方舟的视频、图片、对话接口，形状按它的官方文档写（2026-10-09 读的）。只用于测试和调界面，不会访问外网。
// 地址里没有 /api/v3 前缀：真实的接口地址是 https://ark.cn-beijing.volces.com/api/v3，这里的 url 对应的就是带着 /api/v3 的那一段。
//
// 约定：
// - 提示词里带 REJECT：创建时直接返回 400
// - 提示词里带 NOTOPEN：创建时返回 404，错误码是 ModelNotOpen
// - 提示词里带 FAIL：任务变成 failed
// - 提示词里带 STUCK：任务一直停在 running，直到测试把它的 stuck 改成 false
// - 对话的内容里带 LIMITED：最便宜的那个文本模型返回 429，其余正常
// - 其余任务按时间走 queued → running → succeeded
// - 生图的提示词里带 FAIL：返回 500
// - MiniMax（另一个平台，另一个 Key）：/v2/video_generation 建任务，/v2/query/video_generation/{id} 查任务，形状按它的文档写（2026-10-09 读的）。提示词里带 FAIL 时任务失败
// - AiHubMix（聚合平台，另一个 Key）：/ai/v1/images/generations 同步出图，返回任务对象，形状按它的《异步任务》文档写。提示词里带 FAIL 时任务失败，带 BYURL 时图片给的是下载地址（下载要带 Key），带 NOASYNC 时返回 403
// - 豆包语音（另一个产品，另一个 Key）：音频分两段返回，文字里带 FAIL 时在流里返回出错的 code
// - AutoDL.art（ComfyUI 云工作流，另一个令牌，原样放在 Authorization 里、不加 Bearer）：列工作流、取定义、提交、查结果都裹着 {code, data, msg}。
//   列表里没有规则（和线上一样）；提示词里带 FAIL 时任务失败。结果给一组文件，按时间走 QUEUED → RUNNING → SUCCESS

import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';

export const MOCK_ARK_KEY = '0a1b2c3d-mock-4e5f-ark0-testkey00001';
export const MOCK_MINIMAX_KEY = 'mock-minimax-cn-key-0001';
export const MOCK_AIHUBMIX_KEY = 'sk-mock-aihubmix-key-0001';
export const MOCK_AIHUBMIX_MANAGE_KEY = 'mock-aihubmix-manage-key-0001';
export const MOCK_SPEECH_KEY = 'mock-doubao-speech-key-0001';
export const MOCK_AUTODL_TOKEN = 'mock-autodl-token-0123456789';
export const MOCK_ACCESS_KEY = { id: 'AKLTmockaccesskeyid0001', secret: 'bW9ja3NlY3JldGFjY2Vzc2tleQ==' };

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// 模拟平台上的两个工作流：一个按分辨率计价、出视频，一个按秒计价、出音频。
// 规则里故意带上线上见过的几种写法：枚举、按秒计费的时长、九张参考图、default_local_path 占位。
const AUTODL_WORKFLOWS = [
  {
    uuid: 'minimax_h3_demo',
    name: 'MiniMax H3 示例',
    description: '用一张参考图和一段提示词生成视频',
    cover_image_url: '',
    price: 0,
    price_type: 'minimax_h3',
    billing_config: { minimax_h3: [{ resolution: '480p', price: 50, off_peak_price: 40 }, { resolution: '768p', price: 60, off_peak_price: 50 }] },
    usage_count_7d: 120,
    version: '1',
    input_rules: {
      prompt: { type: 'string', required: true, min_length: 1, max_length: 20000 },
      duration: { type: 'integer', default: 5, min: 1, max: 15 },
      resolution: { type: 'enum', default: '768p竖', options: [{ label: '480p横' }, { label: '480p竖' }, { label: '768p横' }, { label: '768p竖' }] },
      mode: { type: 'enum', default: '高质模式', options: [{ label: '高速模式' }, { label: '高质模式' }] },
      ref_image_0: { type: 'image', required: true, default: 'default_local_path:/blank.png;https://example.com/blank.png', accept_types: ['image/jpeg', 'image/png', 'image/webp'] },
      ref_image_1: { type: 'image', default: 'default_local_path:/blank.png;https://example.com/blank.png', accept_types: ['image/jpeg', 'image/png', 'image/webp'] },
      seed: { type: 'integer', default: 123, min: 1, max: 999999999999999 },
    },
    input_example: '{"prompt": "一只猫在草地上跑"}',
    output_example: '{"data": {"results": [{"url": "https://example.com/a.mp4", "type": "video", "file_type": "mp4"}]}}',
  },
  {
    uuid: 'indextts_demo',
    name: '声纹克隆示例',
    description: '用一段参考音频朗读文本',
    price: 0,
    price_type: 'audio_sec_cost',
    billing_config: { audio_sec_cost: { price: 1, off_peak_price: 1, minimum_price: 10 } },
    usage_count_7d: 67123,
    version: '1',
    input_rules: {
      prompt_text: { type: 'string', required: true, min_length: 1, max_length: 2048 },
      prompt_simple: { type: 'audio', required: true, accept_types: ['audio/mpeg', 'audio/wav'] },
      emo_control_method: { type: 'enum', required: true, default: '与音色参考音频相同', options: [{ label: '与音色参考音频相同' }, { label: '使用情感参考音频' }] },
      emo_happy: { type: 'number', default: 0, min: 0, max: 1.4 },
      emo_random: { type: 'boolean', default: false },
      emo_ref_audio: { type: 'audio', accept_types: ['audio/mpeg', 'audio/wav'] },
    },
    input_example: '{"prompt_text": "你好"}',
    output_example: '{"data": {"results": [{"url": "https://example.com/a.wav", "type": "audio", "file_type": "wav"}]}}',
  },
];

// sampleFile、imageFile、audioFile：调界面时让生成结果是能看能听的真实文件。
export function startMock({ port = 0, taskSeconds = 14, sampleFile = '', imageFile = '', audioFile = '' } = {}) {
  // 生成结果的内容。测试可以中途换掉（files.picture = …）。
  const files = { sample: sampleFile ? fs.readFileSync(sampleFile) : null, picture: imageFile ? fs.readFileSync(imageFile) : PNG, sound: audioFile ? fs.readFileSync(audioFile) : null };
  const tasks = new Map();
  // AutoDL 的任务：提交的参数、开始时间、是不是要失败。
  const autodlTasks = new Map();
  const log = [];

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const fail = (res, status, code, message) => json(res, status, { error: { code, message: `${message} Request id: mock`, param: '', type: status === 401 ? 'Unauthorized' : 'BadRequest' } });
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });

  function taskView(t, base) {
    const age = (Date.now() - t.start) / 1000;
    const { model, resolution, ratio, duration } = t.payload;
    const view = { id: t.id, model, created_at: Math.floor(t.start / 1000), updated_at: Math.floor(Date.now() / 1000), resolution, ratio, duration, service_tier: 'default' };
    if (age < taskSeconds * 0.1) return { ...view, status: 'queued' };
    if (t.fail) return { ...view, status: 'failed', error: { code: 'OutputVideoSensitiveContentDetected', message: 'The request failed because the output video may contain sensitive information.' } };
    if (age < taskSeconds || t.stuck) return { ...view, status: 'running' };
    return { ...view, status: 'succeeded', content: { video_url: `${base}/tos/${t.id}.mp4` }, usage: { completion_tokens: 108900, total_tokens: 108900 }, seed: 78674, framespersecond: 24 };
  }

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://mock');
    const base = `http://127.0.0.1:${server.address().port}`;
    const body = await readBody(req);
    const authed = req.headers.authorization === `Bearer ${MOCK_ARK_KEY}`;
    log.push({ method: req.method, pathname, authed, body: body.toString('utf8') });

    // 生成的视频放在对象存储上，地址本身带签名，下载不用 Key。
    const file = /^\/tos\/([\w-]+)\.mp4$/.exec(pathname);
    if (req.method === 'GET' && file && tasks.has(file[1])) {
      const bytes = files.sample || Buffer.from(`mock ark video ${file[1]}`);
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length });
      return res.end(bytes);
    }

    // AutoDL 的结果文件：和别的平台一样放在对象存储上，下载不用令牌。音频给 wav，其余给视频。
    const result = /^\/autodl-files\/([\w-]+)\.(mp4|wav|mp3|png)$/.exec(pathname);
    if (req.method === 'GET' && result && autodlTasks.has(result[1])) {
      const type = { mp4: 'video/mp4', wav: 'audio/wav', mp3: 'audio/mpeg', png: 'image/png' }[result[2]];
      const bytes = result[2] === 'mp4' ? files.sample || Buffer.from(`mock autodl video ${result[1]}`) : result[2] === 'png' ? files.picture : files.sound || Buffer.from(`mock autodl audio ${result[1]}`);
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length });
      return res.end(bytes);
    }

    // 费用中心查余额：不认 API Key，要带签名。这里只核对签名头的样子和 Access Key ID。
    if (req.method === 'GET' && pathname === '/' && new URL(req.url, 'http://mock').searchParams.get('Action') === 'QueryBalanceAcct') {
      const ok = new RegExp(`^HMAC-SHA256 Credential=${MOCK_ACCESS_KEY.id}/\\d{8}/cn-north-1/billing/request, SignedHeaders=host;x-content-sha256;x-date, Signature=[0-9a-f]{64}$`).test(req.headers.authorization || '');
      if (!ok || !/^\d{8}T\d{6}Z$/.test(req.headers['x-date'] || '')) return json(res, 401, { ResponseMetadata: { Error: { Code: 'SignatureDoesNotMatch', Message: 'signature mismatch' } } });
      return json(res, 200, { ResponseMetadata: { Action: 'QueryBalanceAcct', Service: 'billing' }, Result: { AccountID: 2100000001, ArrearsBalance: '0.00', AvailableBalance: '77.01', CashBalance: '83.01', CreditLimit: '0.00', FreezeAmount: '6.00' } });
    }

    // 豆包语音：Key 放在 X-Api-Key 里，响应体是一个接一个的 JSON，中间没有分隔。
    if (req.method === 'POST' && pathname === '/api/v3/tts/unidirectional') {
      if (req.headers['x-api-key'] !== MOCK_SPEECH_KEY) return json(res, 401, { code: 45000010, message: 'invalid api key' });
      const { req_params: params } = JSON.parse(body.toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (/FAIL/.test(params.text)) return res.end(JSON.stringify({ code: 55000000, message: 'synthesis failed {internal}' }));
      const audio = files.sound || Buffer.from(`mock mp3 ${params.speaker} ${params.text}`);
      const chunk = (bytes) => JSON.stringify({ code: 0, message: '', data: bytes.toString('base64') });
      return res.end(chunk(audio.subarray(0, 9)) + chunk(audio.subarray(9)) + JSON.stringify({ code: 20000000, message: 'OK', data: null, usage: { text_words: params.text.length } }));
    }

    // 豆包语音的音频生成：一次返回整段，音频是 base64。描述里带 FAIL 时返回出错的 code。
    if (req.method === 'POST' && pathname === '/api/v3/tts/create') {
      if (req.headers['x-api-key'] !== MOCK_SPEECH_KEY) return json(res, 401, { code: 45000010, message: 'invalid api key' });
      const { text_prompt: prompt } = JSON.parse(body.toString('utf8'));
      if (/FAIL/.test(prompt)) return json(res, 400, { code: 45001125, message: 'text audit failed' });
      const seconds = Number(/时长 (\d+) 秒/.exec(prompt)?.[1]) || 4;
      return json(res, 200, { audio: (files.sound || Buffer.from(`mock audio ${prompt}`)).toString('base64'), url: `${base}/audio.mp3`, duration: seconds, original_duration: seconds });
    }

    // AiHubMix 查余额：认的是 Manage Key，不带 Bearer；quota 除以 500000 是美元。
    if (req.method === 'GET' && pathname === '/api/user/self') {
      if (req.headers.authorization !== MOCK_AIHUBMIX_MANAGE_KEY) return json(res, 401, { message: 'Unauthorized – access token is invalid or expired.', success: false });
      return json(res, 200, { data: { username: 'mock', quota: 2260000, used_quota: 740000, request_count: 12 }, message: '', success: true });
    }

    if (pathname.startsWith('/ai/v1/')) {
      const bad = (status, code, message) => json(res, status, { error: { code, type: 'invalid_request_error', message } });
      if (req.headers.authorization !== `Bearer ${MOCK_AIHUBMIX_KEY}`) return bad(401, 'invalid_api_key', 'Invalid API key.');
      if (req.method === 'GET' && /^\/ai\/v1\/images\/task_\w+\/content\/0$/.test(pathname)) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': files.picture.length });
        return res.end(files.picture);
      }
      if (req.method === 'POST' && pathname === '/ai/v1/images/generations') {
        const payload = JSON.parse(body.toString('utf8'));
        if (/NOASYNC/.test(payload.prompt)) return bad(403, 'async_not_enabled', 'Async tasks are not enabled for this account.');
        const id = `task_${crypto.randomBytes(6).toString('hex')}`;
        const task = { id, object: 'image', model: payload.model, created_at: Math.floor(Date.now() / 1000), completed_at: Math.floor(Date.now() / 1000), expires_at: null };
        if (/FAIL/.test(payload.prompt)) return json(res, 200, { ...task, status: 'failed', output: [], error: { code: 'output_blocked', message: 'The model provider blocked the generated output.' } });
        const byUrl = /BYURL/.test(payload.prompt);
        return json(res, 200, { ...task, status: 'completed', error: null, output: [{ index: 0, type: 'file', b64_json: byUrl ? null : files.picture.toString('base64'), content_url: byUrl ? `${base}/ai/v1/images/${id}/content/0` : null }] });
      }
      return bad(404, 'not_found', 'not found');
    }

    // MiniMax：出错的样子和方舟不一样，没有 code，只有 type。任务包在 task 里，成片地址是 content.url，用量按秒。
    if (pathname.startsWith('/v2/')) {
      if (req.headers.authorization !== `Bearer ${MOCK_MINIMAX_KEY}`) return json(res, 401, { type: 'error', error: { type: 'authorized_error', message: 'invalid api key (2049)', http_code: '401' }, request_id: 'mock' });
      if (req.method === 'POST' && pathname === '/v2/video_generation') {
        const payload = JSON.parse(body.toString('utf8'));
        const text = (payload.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
        const id = String(Date.now()) + crypto.randomInt(100, 999);
        tasks.set(id, { id, start: Date.now(), fail: /FAIL/.test(text), payload });
        return json(res, 200, { task_id: id });
      }
      const found = /^\/v2\/query\/video_generation\/(\d+)$/.exec(pathname);
      if (req.method === 'GET' && found && tasks.has(found[1])) {
        const t = tasks.get(found[1]);
        const age = (Date.now() - t.start) / 1000;
        const { model, resolution, ratio, duration, content } = t.payload;
        const view = { id: t.id, model, created_at: Math.floor(t.start / 1000), updated_at: Math.floor(Date.now() / 1000), resolution, duration, task_type: 'generation', modality: 'video' };
        if (age < taskSeconds * 0.1) return json(res, 200, { task: { ...view, status: 'queued' } });
        if (t.fail) return json(res, 200, { task: { ...view, status: 'failed', error: { message: 'content moderation failed' } } });
        if (age < taskSeconds) return json(res, 200, { task: { ...view, status: 'running' } });
        const images = content.filter((c) => c.type === 'image_url').length;
        return json(res, 200, { task: { ...view, status: 'succeeded', ratio: ratio || '16:9', content: { url: `${base}/tos/${t.id}.mp4` }, usage: { total_seconds: duration, input_seconds: 0, output_seconds: duration, input_image_count: images } } });
      }
      return json(res, 500, { type: 'error', error: { type: 'server_error', message: 'record not found (1000)', http_code: '500' }, request_id: 'mock' });
    }

    // AutoDL.art：令牌原样放在 Authorization 里，响应裹着 {code, data, msg}。列表里不带规则（和线上一样），规则在详情里。
    if (pathname.startsWith('/api/v1/comfyui/')) {
      const envelope = (data) => ({ code: 'Success', msg: 'success', data, request_id: 'mock' });
      const autodlAuthed = req.headers.authorization === MOCK_AUTODL_TOKEN;
      if (!autodlAuthed) return json(res, 401, { code: 'Unauthorized', msg: 'invalid token', data: null });
      if (req.method === 'POST' && pathname === '/api/v1/comfyui/workflows') {
        const { page_index = 1 } = JSON.parse(body.toString('utf8') || '{}');
        // 每页只给一条，好让分页也走到。
        const list = page_index === 1 ? AUTODL_WORKFLOWS.map(({ input_rules, input_example, output_example, ...rest }) => rest) : [];
        return json(res, 200, envelope({ list, result_total: AUTODL_WORKFLOWS.length }));
      }
      const detail = /^\/api\/v1\/comfyui\/workflows\/([\w.-]+)$/.exec(pathname);
      if (req.method === 'GET' && detail) {
        const workflow = AUTODL_WORKFLOWS.find((w) => w.uuid === detail[1]);
        if (!workflow) return json(res, 404, { code: 'NotFound', msg: 'workflow not found', data: null });
        return json(res, 200, envelope(workflow));
      }
      const submit = /^\/api\/v1\/comfyui\/comfyui_workflow\/([\w.-]+)$/.exec(pathname);
      if (req.method === 'POST' && submit) {
        if (!AUTODL_WORKFLOWS.some((w) => w.uuid === submit[1])) return json(res, 404, { code: 'NotFound', msg: 'workflow not found', data: null });
        const inputs = JSON.parse(body.toString('utf8') || '{}');
        const id = `autodl-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
        autodlTasks.set(id, { id, uuid: submit[1], inputs, start: Date.now(), fail: /FAIL/.test(JSON.stringify(inputs)) });
        return json(res, 200, envelope({ task_id: id, status: 'QUEUED' }));
      }
      const query = /^\/api\/v1\/comfyui\/comfyui_workflow\/result\/([\w-]+)$/.exec(pathname);
      if (req.method === 'GET' && query) {
        const task = autodlTasks.get(query[1]);
        if (!task) return json(res, 200, { code: 'NotFound', msg: 'task not found', data: null });
        const age = (Date.now() - task.start) / 1000;
        if (task.fail) return json(res, 200, envelope({ status: 'FAILED', error: { message: 'Workflow node failed' } }));
        if (age < taskSeconds) return json(res, 200, envelope({ status: 'RUNNING' }));
        // 一次给两份结果：视频的工作流出两个文件，音频的出一个 wav。
        if (task.uuid === 'indextts_demo') return json(res, 200, envelope({ status: 'SUCCESS', duration: 3, cost: 3, results: [{ url: `${base}/autodl-files/${task.id}.wav`, type: 'audio', file_type: 'wav', duration: 3 }] }));
        return json(res, 200, envelope({ status: 'SUCCESS', duration: 5, cost: 50, results: [{ url: `${base}/autodl-files/${task.id}.mp4`, type: 'video', file_type: 'mp4', duration: 5 }] }));
      }
      return json(res, 404, { code: 'NotFound', msg: `no route ${req.method} ${pathname}`, data: null });
    }

    if (!authed) return fail(res, 401, 'AuthenticationError', 'the API key or AK/SK in the request is missing or invalid.');

    if (req.method === 'GET' && pathname === '/contents/generations/tasks') return json(res, 200, { items: [], total: 0 });

    if (req.method === 'POST' && pathname === '/contents/generations/tasks') {
      const payload = JSON.parse(body.toString('utf8'));
      const text = (payload.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      if (/REJECT/.test(text)) return fail(res, 400, 'InvalidParameter', 'the parameter `content` specified in the request is not valid.');
      if (/NOTOPEN/.test(text)) return fail(res, 404, 'ModelNotOpen', `Your account has not activated the model ${payload.model}.`);
      const id = `cgt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      tasks.set(id, { id, start: Date.now(), fail: /FAIL/.test(text), stuck: /STUCK/.test(text), payload });
      return json(res, 200, { id });
    }

    const task = /^\/contents\/generations\/tasks\/([\w-]+)$/.exec(pathname);
    if (req.method === 'GET' && task) {
      if (!tasks.has(task[1])) return fail(res, 404, 'ResourceNotFound', 'the specified task is not found.');
      return json(res, 200, taskView(tasks.get(task[1]), base));
    }

    // 一次出一张，要了 b64_json 就返回 base64；用量里只有张数和 token，没有金额。
    if (req.method === 'POST' && pathname === '/images/generations') {
      const payload = JSON.parse(body.toString('utf8'));
      if (/FAIL/.test(payload.prompt || '')) return fail(res, 500, 'InternalServiceError', 'The service encountered an unexpected internal error.');
      return json(res, 200, { model: payload.model, created: Math.floor(Date.now() / 1000), data: [{ b64_json: files.picture.toString('base64'), size: payload.size }], usage: { generated_images: 1, output_tokens: 16384, total_tokens: 16384 } });
    }

    if (req.method === 'POST' && pathname === '/chat/completions') {
      const { model, messages } = JSON.parse(body.toString('utf8'));
      if (/LIMITED/.test(messages.at(-1).content) && /-lite-/.test(model)) return fail(res, 429, 'ModelAccountRpmRateLimitExceeded', 'rate limit exceeded.');
      return json(res, 200, { model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: `润色后的：${messages.at(-1).content}` } }] });
    }

    fail(res, 404, 'NotFound', `no route ${req.method} ${pathname}`);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ port: server.address().port, url: `http://127.0.0.1:${server.address().port}`, log, tasks, autodlTasks, files, close: () => new Promise((done) => server.close(done)) });
    });
  });
}
