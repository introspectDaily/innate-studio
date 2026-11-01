// 服务关掉再打开：还在跑的任务接着查，跑完了的结果接着存到本机——像没关过一样。
// 这里用模拟平台：任务提交后一直卡在 running（提示词里带 STUCK），把服务杀掉再拉起来，
// 确认记录没被判失败、平台那边一完成，结果照样自动存到本机。

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock, MOCK_ARK_KEY } from './mock-ark.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VIDEO = 'doubao-seedance-2-0-260128';

let mock;
let app;
let base;
let dataDir;
let port;

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port: p } = probe.address();
      probe.close(() => resolve(p));
    });
  });

async function waitFor(check, what, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch {
      /* 还没准备好 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`等待超时：${what}`);
}

const call = async (method, url, body) => {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + url, init);
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
};

// 起一个服务；同一个数据目录起第二次，就是「重启」。
function startApp() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(port),
      ARK_BASE_URL: mock.url,
      ARK_API_KEY: MOCK_ARK_KEY,
      DOUBAO_SPEECH_BASE_URL: mock.url,
      VOLC_BILLING_BASE_URL: mock.url,
      MINIMAX_BASE_URL: mock.url,
      MINIMAX_CN_API_KEY: '',
      AIHUBMIX_BASE_URL: mock.url,
      AIHUBMIX_API_KEY: '',
      AIHUBMIX_MANAGE_KEY: '',
      AUTODL_BASE_URL: mock.url,
      AUTODL_ART_API_KEY: '',
      AUTODL_TOKEN: '',
      DOUBAO_SPEECH_API_KEY: '',
      VOLC_ACCESS_KEY_ID: '',
      VOLC_SECRET_ACCESS_KEY: '',
      INNATE_DATA_DIR: dataDir,
      // 别让「查太久就判超时」把任务掐掉：这里要测的是重启后能不能接着跑。
      INNATE_PENDING_LIMIT_MS: '3600000',
    },
  });
  return child;
}

before(async () => {
  mock = await startMock({ taskSeconds: 0.2 });
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'innate-restart-'));
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  app = startApp();
  await waitFor(async () => (await fetch(`${base}/api/state`)).ok, '服务启动');
});

after(async () => {
  app?.kill();
  await mock?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('服务重启：还在跑的任务接着跑，跑完了的结果接着存到本机', async () => {
  // 提交一个会一直卡在 running 的任务。
  const created = await call('POST', '/api/videos', { payload: { model: VIDEO, prompt: 'STUCK 一只在草地上跑', duration: 5, resolution: '720p', aspect_ratio: '16:9' } });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const id = created.data.id;
  assert.ok(['queued', 'in_progress'].includes(created.data.status));

  // 直接把服务杀掉（用户关掉服务就是这样：没有优雅退出，内存里的东西全没了）。
  app.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 500));

  // 记录还在盘上，状态还是进行中。
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'history.json'), 'utf8')).find((i) => i.id === id);
  assert.ok(onDisk, '记录没写进 history.json');
  assert.ok(['queued', 'in_progress'].includes(onDisk.status));

  // 重新启动同一个服务。
  app = startApp();
  await waitFor(async () => (await fetch(`${base}/api/state`)).ok, '服务重启');

  // 重启后它没有把这条任务判成失败，还接着去平台查。
  const afterRestart = await waitFor(
    async () => {
      const { data } = await call('GET', '/api/history');
      const item = data.items.find((i) => i.id === id);
      return item && item.polls > (onDisk.polls || 0) ? item : null;
    },
    '重启后接着查这条任务',
  );
  assert.ok(['queued', 'in_progress'].includes(afterRestart.status), afterRestart.status);
  assert.equal(afterRestart.error, null);

  // 平台那边完成了（把卡住放开），重启后的服务照样把结果存到本机。
  for (const task of mock.tasks.values()) task.stuck = false;
  const done = await waitFor(
    async () => {
      const { data } = await call('GET', '/api/history');
      const item = data.items.find((i) => i.id === id);
      return item && item.status === 'completed' && item.savedLocally ? item : null;
    },
    '结果存到本机',
  );
  assert.ok(fs.existsSync(path.join(dataDir, 'videos', done.localFile)));
  assert.match(done.videoUrl, /^\/media\/videos\//);
});
