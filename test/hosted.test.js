// 多人模式：建了账号之后要登录才能用，各人的数据分开，Key 和成员只有管理员能管；成员生成要花积分。
// 和 server.test.js 一样把真实的 server.js 跑起来，火山引擎换成模拟接口。

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock, MOCK_ARK_KEY } from './mock-ark.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const IMAGE = 'doubao-seedream-5-0-pro-260628';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
let mock;
let app;
let base;
let dataDir;
let env;
// 每个人登录后拿到的 Cookie。
const cookies = {};
const passwords = {};

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
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      /* 还没准备好，继续等 */
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`等待超时：${what}`);
}

// who 是用谁的身份发；不给就是没登录。
async function call(who, method, url, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (who) init.headers.Cookie = cookies[who];
  if (body instanceof Buffer) init.body = body;
  else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + url, init);
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null, cookie: res.headers.get('set-cookie') };
}

async function signIn(name, password = passwords[name]) {
  const res = await call(null, 'POST', '/api/login', { name, password });
  if (res.status === 200) cookies[name] = res.cookie.split(';')[0];
  return res;
}

const cli = (...args) => execFileSync(process.execPath, ['server/users-cli.js', ...args], { cwd: root, env, encoding: 'utf8' });

before(async () => {
  mock = await startMock({ taskSeconds: 0.3 });
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'innate-hosted-'));
  // 本机模式留下的一条记录：建第一个管理员时搬给他。
  fs.writeFileSync(path.join(dataDir, 'history.json'), JSON.stringify([{ id: 'img_old', provider: 'ark', kind: 'image', model: IMAGE, prompt: '本机模式时生成的', status: 'completed', localFile: 'img_old.jpg', createdAt: Date.now() }]));
  fs.mkdirSync(path.join(dataDir, 'images'));
  fs.writeFileSync(path.join(dataDir, 'images', 'img_old.jpg'), PNG);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  env = { ...process.env, PORT: String(port), ARK_BASE_URL: mock.url, DOUBAO_SPEECH_BASE_URL: mock.url, VOLC_BILLING_BASE_URL: mock.url, MINIMAX_BASE_URL: mock.url, MINIMAX_CN_API_KEY: '', AIHUBMIX_BASE_URL: mock.url, AIHUBMIX_API_KEY: '', AIHUBMIX_MANAGE_KEY: '', ARK_API_KEY: '', DOUBAO_SPEECH_API_KEY: '', VOLC_ACCESS_KEY_ID: '', VOLC_SECRET_ACCESS_KEY: '', INNATE_DATA_DIR: dataDir };
  passwords.owner = /初始密码：(\S+)/.exec(cli('add', 'owner', '--admin', '--with-local-data'))[1];
  app = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'ignore', env });
  await waitFor(async () => (await fetch(`${base}/api/state`)).ok, '服务启动');
});

after(async () => {
  app?.kill();
  await mock?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('没登录：只读得到「要登录」这件事，别的接口和文件都不给', async () => {
  const state = await call(null, 'GET', '/api/state');
  assert.deepEqual(state.data, { hasKey: false, hosted: true, user: null });
  for (const [method, url] of [['GET', '/api/history'], ['GET', '/api/models'], ['GET', '/api/users'], ['PUT', '/api/key'], ['GET', '/media/images/img_old.jpg']]) {
    const res = await call(null, method, url, method === 'PUT' ? { apiKey: MOCK_ARK_KEY } : undefined);
    assert.equal(res.status, 401, url);
    assert.equal(res.data.error.code, 'login_required', url);
  }
  // 页面本身不用登录就能打开，登录框在页面里。
  assert.equal((await fetch(`${base}/`)).status, 200);
});

test('登录：密码不对不给进，连错几次先锁住；登录后拿到自己的账号', async () => {
  const wrong = await signIn('owner', 'not-the-password');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.cookie, null);
  assert.equal((await signIn('nobody', 'whatever-123')).status, 401);
  for (let i = 0; i < 5; i += 1) await signIn('locked-name', 'x');
  assert.equal((await signIn('locked-name', 'x')).status, 429);

  const ok = await signIn('owner');
  assert.equal(ok.status, 200);
  assert.match(ok.cookie, /^innate_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
  assert.deepEqual([ok.data.user.name, ok.data.user.role], ['owner', 'admin']);
  const state = await call('owner', 'GET', '/api/state');
  assert.equal(state.data.user.name, 'owner');
  // 密码的散列不出现在任何返回里，磁盘上存的也不是明文。
  assert.equal(JSON.stringify(state.data).includes('hash'), false);
  assert.equal(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8').includes(passwords.owner), false);
  assert.equal(fs.readFileSync(path.join(dataDir, 'sessions.json'), 'utf8').includes(cookies.owner.split('=')[1]), false);
});

test('本机模式的数据搬给了第一个管理员', async () => {
  const { items } = (await call('owner', 'GET', '/api/history')).data;
  assert.deepEqual(items.map((i) => i.id), ['img_old']);
  assert.equal((await call('owner', 'GET', '/api/history')).status, 200);
  const file = await fetch(`${base}/media/images/img_old.jpg`, { headers: { Cookie: cookies.owner } });
  assert.equal(file.status, 200);
  assert.equal(fs.existsSync(path.join(dataDir, 'history.json')), false);
});

test('管理员：配 Key、建成员（初始密码只给这一次）；成员改不了 Key、看不到任何平台的 Key 状态和成员列表', async () => {
  assert.equal((await call('owner', 'PUT', '/api/key', { apiKey: MOCK_ARK_KEY })).status, 200);
  const made = await call('owner', 'POST', '/api/users', { name: '小林' });
  assert.equal(made.status, 200);
  assert.equal(made.data.user.role, 'member');
  assert.match(made.data.password, /^[A-Za-z2-9]{12}$/);
  passwords['小林'] = made.data.password;
  assert.equal((await call('owner', 'POST', '/api/users', { name: '小林' })).status, 400);
  // 页面上建不出管理员：管理员只能在服务器的命令行里建。
  const sneaky = await call('owner', 'POST', '/api/users', { name: '想当管理员', role: 'admin' });
  assert.equal(sneaky.data.user.role, 'member');
  assert.equal((await call('owner', 'DELETE', `/api/users/${sneaky.data.user.id}`)).status, 204);
  assert.equal((await signIn('小林')).status, 200);

  const state = (await call('小林', 'GET', '/api/state')).data;
  // 成员只知道服务能不能用：接了哪些平台、各自配没配、地址是什么，都不在返回里。
  assert.deepEqual(Object.keys(state).sort(), ['hasKey', 'hosted', 'user']);
  assert.deepEqual([state.hasKey, state.user.role], [true, 'member']);
  for (const [method, url, body] of [['PUT', '/api/key', { apiKey: 'another-key' }], ['DELETE', '/api/key'], ['GET', '/api/credits'], ['GET', '/api/users'], ['POST', '/api/users', { name: 'x' }], ['POST', `/api/users/${state.user.id}/credits`, { amount: 1000 }]]) {
    const res = await call('小林', method, url, body);
    assert.equal(res.status, 403, `${method} ${url}`);
  }
  // 成员照样能用模型。没配 Key 的平台上的型号列在 unavailable 里，页面上标成「暂未开通」；配了的不在里面。
  const models = (await call('小林', 'GET', '/api/models')).data;
  assert.equal(models.source, 'remote');
  assert.ok(models.unavailable.includes('MiniMax-H3'));
  assert.ok(!models.unavailable.includes(models.models[0]));
});

test('积分：没有积分不能生成；提交时预扣，完成后按用量结算，失败了全退', async () => {
  const draw = (prompt, n = 1) => call('小林', 'POST', '/api/images', { payload: { model: IMAGE, prompt, n, aspect_ratio: '16:9' } });
  const balance = async () => (await call('小林', 'GET', '/api/history')).data.credits;
  const broke = await draw('没有积分');
  assert.equal(broke.status, 402);
  assert.equal(broke.data.error.code, 'insufficient_credits');
  assert.equal((await call('小林', 'GET', '/api/history')).data.items.length, 0);

  const me = (await call('小林', 'GET', '/api/state')).data.user;
  assert.equal((await call('owner', 'POST', `/api/users/${me.id}/credits`, { amount: 0 })).status, 400);
  assert.equal((await call('owner', 'POST', `/api/users/${me.id}/credits`, { amount: 100 })).data.credits, 100);
  assert.equal(await balance(), 100);

  // 5.0 pro 的 1.5K 一张 0.30 元，就是 30 积分。失败的那张提交时扣了，失败后退回。
  const failed = await draw('FAIL 这张会失败');
  assert.equal(failed.status, 200);
  assert.deepEqual(failed.data.items[0].credits, { quote: 30, charged: 30 });
  const gone = await waitFor(async () => (await call('小林', 'GET', '/api/history')).data.items.find((i) => i.id === failed.data.items[0].id && i.status === 'failed'), '图片失败');
  assert.equal(gone.credits.charged, 0);
  assert.equal(await balance(), 100);
  // 失败的原因：成员只看中文的那一句，平台的原话（detail）只给管理员。
  assert.equal(gone.error.message, '火山方舟 服务暂时异常，请稍后重试');
  assert.equal(gone.error.detail, undefined);
  // 管理员看得到原话。
  const own = await call('owner', 'POST', '/api/images', { payload: { model: IMAGE, prompt: 'FAIL 管理员的', n: 1, aspect_ratio: '16:9' } });
  const ownFailed = await waitFor(async () => (await call('owner', 'GET', '/api/history')).data.items.find((i) => i.id === own.data.items[0].id && i.status === 'failed'), '管理员的图片失败');
  assert.match(ownFailed.error.detail, /^火山方舟（InternalServiceError）：/);
  assert.equal((await call('owner', 'DELETE', `/api/history/${ownFailed.id}`)).status, 204);
  // 四张要 120，余额只有 100：一张都不提交。
  assert.equal((await draw('太多了', 4)).status, 402);
  assert.equal(await balance(), 100);
  assert.equal((await call('小林', 'DELETE', `/api/history/${gone.id}`)).status, 204);
});

test('各人的数据分开：记录、文件、画布互相看不到', async () => {
  const created = await call('小林', 'POST', '/api/images', { payload: { model: IMAGE, prompt: '小林的图', n: 1, aspect_ratio: '16:9' } });
  assert.equal(created.status, 200);
  const { id } = created.data.items[0];
  const image = await waitFor(async () => (await call('小林', 'GET', '/api/history')).data.items.find((i) => i.id === id && i.status === 'completed'), '图片生成完');
  assert.equal(image.credits.charged, 30);
  assert.ok(fs.existsSync(path.join(dataDir, 'users', (await call('小林', 'GET', '/api/state')).data.user.id, 'images', image.localFile)));

  assert.deepEqual((await call('owner', 'GET', '/api/history')).data.items.map((i) => i.id), ['img_old']);
  assert.equal((await fetch(base + image.mediaUrl, { headers: { Cookie: cookies.owner } })).status, 404);
  assert.equal((await fetch(base + image.mediaUrl, { headers: { Cookie: cookies['小林'] } })).status, 200);
  assert.equal((await call('owner', 'DELETE', `/api/history/${id}`)).status, 404);

  const upload = await call('小林', 'POST', '/api/uploads', PNG, { 'Content-Type': 'image/png' });
  // 别人上传的文件不能拿来当自己的参考图。
  const stolen = await call('owner', 'POST', '/api/images', { payload: { model: IMAGE, prompt: '改', n: 1, input_references: [{ type: 'image_url', image_url: { url: upload.data.url } }] } });
  assert.equal(stolen.status, 400);
  assert.equal(stolen.data.error.code, 'file_not_found');

  const canvas = await call('小林', 'POST', '/api/canvases', { name: '小林的画布' });
  assert.equal((await call('owner', 'GET', `/api/canvases/${canvas.data.id}`)).status, 404);
  assert.equal((await call('owner', 'GET', '/api/canvases')).data.items.length, 0);
});

test('成员列表带着每人的积分余额和本月用量；改自己的密码；停用、重置密码之后原来的登录失效', async () => {
  const { items } = (await call('owner', 'GET', '/api/users')).data;
  assert.deepEqual(items.map((u) => [u.name, u.role, u.credits, u.monthUsed]), [['owner', 'admin', 0, 0], ['小林', 'member', 70, 30]]);

  assert.equal((await call('小林', 'PUT', '/api/me/password', { current: 'wrong', next: 'a-new-password' })).status, 400);
  assert.equal((await call('小林', 'PUT', '/api/me/password', { current: passwords['小林'], next: 'short' })).status, 400);
  assert.equal((await call('小林', 'PUT', '/api/me/password', { current: passwords['小林'], next: 'a-new-password' })).status, 204);
  // 正在用的这一处还登录着，旧密码不能用了。
  assert.equal((await call('小林', 'GET', '/api/history')).status, 200);
  assert.equal((await signIn('小林')).status, 401);
  passwords['小林'] = 'a-new-password';

  const member = items.find((u) => u.name === '小林');
  assert.equal((await call('owner', 'PUT', `/api/users/${member.id}`, { disabled: true })).data.user.disabled, true);
  assert.equal((await call('小林', 'GET', '/api/history')).status, 401);
  assert.equal((await signIn('小林')).status, 401);
  const reset = await call('owner', 'PUT', `/api/users/${member.id}`, { disabled: false, resetPassword: true });
  passwords['小林'] = reset.data.password;
  assert.equal((await signIn('小林')).status, 200);

  // 最后一个管理员不能停用，也不能删自己；角色在页面上改不了。
  const owner = items.find((u) => u.name === 'owner');
  assert.equal((await call('owner', 'PUT', `/api/users/${owner.id}`, { disabled: true })).status, 400);
  assert.equal((await call('owner', 'PUT', `/api/users/${owner.id}`, { role: 'member' })).data.user.role, 'admin');
  assert.equal((await call('owner', 'PUT', `/api/users/${member.id}`, { role: 'admin' })).data.user.role, 'member');
  assert.equal((await call('owner', 'DELETE', `/api/users/${owner.id}`)).status, 400);

  // 删掉成员：账号没了，数据还在磁盘上。
  assert.equal((await call('owner', 'DELETE', `/api/users/${member.id}`)).status, 204);
  assert.equal((await call('小林', 'GET', '/api/history')).status, 401);
  assert.ok(fs.existsSync(path.join(dataDir, 'users', member.id, 'history.json')));
});

test('Agent 令牌：只读令牌能读、能等结果，但写不了；--scope read 不带等号也认', async () => {
  const asKey = async (token, method, url, body) => {
    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = /application\/json/i.test(res.headers.get('content-type') || '');
    const text = await res.text();
    return { status: res.status, data: json && text ? JSON.parse(text) : text };
  };
  const make = (...args) => /令牌：(\S+)/.exec(cli('token', 'add', '--user', 'owner', ...args))[1];

  // 空格写法（用法说明里的写法）必须真的生效，否则会悄声创建出 write 令牌。
  const readToken = make('--name', '只读', '--scope', 'read');
  const writeToken = make('--name', '读写', '--scope', 'write');

  // 读：模型、记录、自己的文件都能看。
  assert.equal((await asKey(readToken, 'GET', '/api/models')).status, 200);
  assert.equal((await asKey(readToken, 'GET', '/api/history')).data.items[0].id, 'img_old');
  assert.equal((await asKey(readToken, 'GET', '/media/images/img_old.jpg')).status, 200);

  // 写：生成、上传都不行，且明确告诉调用者换 write 令牌。
  for (const [method, url, body] of [
    ['POST', '/api/images', { payload: { model: IMAGE, prompt: '只读令牌不该能画', n: 1 } }],
    ['POST', '/api/uploads', {}],
    ['POST', '/api/canvases', { name: '只读令牌不该能建' }],
    ['DELETE', '/api/history/img_old', undefined],
  ]) {
    const res = await asKey(readToken, method, url, body);
    assert.equal(res.status, 403, `${method} ${url}`);
    assert.equal(res.data.error.code, 'read_only_key');
  }
  assert.equal((await asKey(readToken, 'GET', '/api/history')).data.items.length, 1, '删不掉');

  // 轮询是读：只读令牌也得能等任务结果，否则 agent 看不到自己发起/页面上发起的任务。
  const polled = await asKey(readToken, 'POST', '/api/history/img_old/refresh?wait=1');
  assert.equal(polled.status, 200);
  assert.equal(polled.data.id, 'img_old');

  // 读写令牌照常能写（这里故意给非法参数，400 说明请求已经进到接口里了，没被拦在门外）。
  const allowed = await asKey(writeToken, 'POST', '/api/images', { payload: { prompt: '没给模型' } });
  assert.equal(allowed.status, 400);
});

test('别的网站发来的请求被拦下；退出登录后 Cookie 失效', async () => {
  const crossSite = await call('owner', 'GET', '/api/history', undefined, { Origin: 'https://evil.example' });
  assert.equal(crossSite.status, 403);
  // 经过反向代理时，页面的域名在 X-Forwarded-Host 里，从那个域名来的算自己人。
  const proxied = await call('owner', 'GET', '/api/history', undefined, { Origin: 'https://studio.example.com', 'X-Forwarded-Host': 'studio.example.com', 'X-Forwarded-Proto': 'https' });
  assert.equal(proxied.status, 200);
  const viaHttps = await call(null, 'POST', '/api/login', { name: 'owner', password: passwords.owner }, { 'X-Forwarded-Proto': 'https' });
  assert.match(viaHttps.cookie, /; Secure$/);

  assert.equal((await call('owner', 'POST', '/api/logout')).status, 204);
  assert.equal((await call('owner', 'GET', '/api/history')).status, 401);
});
