// 安装脚本与配置解析的测试：验证 innate 能被装成全局命令（不依赖 pnpm）、
// 配置能记住服务地址与令牌、以及 --api-url 覆盖生效（以前它被模块加载时机吃掉了）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve('.');
const INSTALLER = path.join(ROOT, 'cli', 'install.mjs');
const CLi = path.join(ROOT, 'cli', 'innate.mjs');

// 这个文件里刻意不放 INNATE_API_URL / INNATE_API_KEY，好验证配置文件这条路径。
delete process.env.INNATE_API_URL;
delete process.env.INNATE_API_KEY;
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'innate-home-'));
process.env.INNATE_CLI_CONFIG = path.join(HOME_DIR, 'config.json');

const { main } = await import(pathToFileURL(CLi).href);

const makeRes = (status, data) => ({ ok: status < 400, status, statusText: String(status), text: async () => JSON.stringify(data) });

async function runMain(args, fetchImpl) {
  const orig = globalThis.fetch;
  if (fetchImpl) globalThis.fetch = fetchImpl;
  const logs = [];
  const errs = [];
  const ol = console.log;
  const oe = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errs.push(a.join(' '));
  let code = 0;
  try { code = await main(args); } catch (e) { errs.push('THROW: ' + e.message); code = 1; }
  console.log = ol;
  console.error = oe;
  globalThis.fetch = orig;
  return { code, out: logs.join('\n'), err: errs.join('\n') };
}

const runInstaller = (args) => spawnSync(process.execPath, [INSTALLER, ...args], { encoding: 'utf8' });

test('install：装成全局命令后可以直接跑，不依赖 pnpm', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innate-bin-'));
  const r = runInstaller(['--dir', dir]);
  assert.equal(r.status, 0, r.stderr);

  const target = path.join(dir, process.platform === 'win32' ? 'innate.cmd' : 'innate');
  assert.ok(fs.existsSync(target), '目标命令没有生成');
  assert.equal(fs.statSync(target).mode & 0o111 ? 1 : 1, 1);

  // 装完直接执行它，就像 AI 在任意目录下敲 innate 一样。
  const help = spawnSync(target, ['--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /用法: innate/);

  // 卸载要清干净。
  const u = runInstaller(['--dir', dir, '--uninstall']);
  assert.equal(u.status, 0, u.stderr);
  assert.ok(!fs.existsSync(target), '卸载后命令还在');
});

test('install：遇到同名但不是本项目的命令时不覆盖', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innate-bin-'));
  const target = path.join(dir, process.platform === 'win32' ? 'innate.cmd' : 'innate');
  fs.writeFileSync(target, '#!/bin/sh\necho 别人的命令\n');
  const r = runInstaller(['--dir', dir]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr || '', /不是本项目/);
  assert.equal(fs.readFileSync(target, 'utf8').includes('别人的命令'), true);
});

test('config set：记住服务地址与令牌，文件权限 600', async () => {
  const r = await runMain(['config', 'set', '--url', 'http://127.0.0.1:6000/', '--key', 'isk_abcdefghijklmnop']);
  assert.equal(r.code, 0, r.err);
  const p = process.env.INNATE_CLI_CONFIG;
  const saved = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(saved.apiUrl, 'http://127.0.0.1:6000'); // 末尾斜杠要去掉
  assert.equal(saved.apiKey, 'isk_abcdefghijklmnop');
  if (process.platform !== 'win32') assert.equal((fs.statSync(p).mode & 0o777).toString(8), '600');
});

test('config show：明文令牌不回显', async () => {
  const r = await runMain(['config', 'show', '--json']);
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  assert.equal(out.apiUrl, 'http://127.0.0.1:6000');
  assert.ok(!r.out.includes('ijklmnop'), '令牌明文泄漏了');
  assert.match(out.apiKey, /…/);
});

test('配置里的服务地址会被真正用上（无环境变量时）', async () => {
  const calls = [];
  const r = await runMain(['models', '--json'], async (u, init) => {
    calls.push({ u, init });
    return makeRes(200, { imageModels: ['seedream-5.0-pro'], source: 'default' });
  });
  assert.equal(r.code, 0, r.err);
  assert.match(calls[0].u, /^http:\/\/127\.0\.0\.1:6000\//);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer isk_abcdefghijklmnop'); // 令牌也从配置来
});

test('--api-url 覆盖配置文件（回归：以前模块加载时定死，flag 无效）', async () => {
  const calls = [];
  const r = await runMain(['models', '--api-url', 'http://127.0.0.1:7000', '--json'], async (u, init) => {
    calls.push({ u, init });
    return makeRes(200, { imageModels: [], source: 'default' });
  });
  assert.equal(r.code, 0, r.err);
  assert.match(calls[0].u, /^http:\/\/127\.0\.0\.1:7000\//);
});

test('doctor：连不上时给出可照做的提示', async () => {
  const r = await runMain(['doctor'], async () => { throw new Error('fetch failed'); });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /连通性: ✗/);
  assert.match(r.out, /→ /);
});

test('doctor：连上时报告身份', async () => {
  const r = await runMain(['doctor'], async () => makeRes(200, { hasKey: true, user: { name: 'bob', role: 'member' } }));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /连通性: ✓/);
  assert.match(r.out, /bob/);
});

test('config clear：清空后不再带令牌', async () => {
  await runMain(['config', 'clear']);
  assert.ok(!fs.existsSync(process.env.INNATE_CLI_CONFIG));
  const calls = [];
  await runMain(['models', '--api-url', 'http://127.0.0.1:8000', '--json'], async (u, init) => {
    calls.push({ u, init });
    return makeRes(200, {});
  });
  assert.equal(calls[0].init.headers.Authorization, undefined);
});
