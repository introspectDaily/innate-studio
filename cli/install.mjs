#!/usr/bin/env node
// 把 cli/innate.mjs 装成一个全局命令 innate，之后不管在哪个目录都能直接敲：
//   innate models
//   innate generate image --model seedream-5.0-pro --prompt "一只猫" --wait
//
// 用法：
//   node <项目>/cli/install.mjs                装（默认挑一个在 PATH 里的目录）
//   node <项目>/cli/install.mjs --dir ~/bin    装到指定目录
//   node <项目>/cli/install.mjs --uninstall    卸
//
// 用的是软链，指向项目里的 cli/innate.mjs：改了 CLI 不用重装，项目挪位置了重装一次即可。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, 'cli', 'innate.mjs');
const NAME = 'innate';
const MARK = 'cli/innate.mjs'; // 用来认出「这个文件是我们装的」，避免误删同名命令

const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? null : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
};
const wantUninstall = argv.includes('--uninstall');
const wantHelp = argv.includes('--help') || argv.includes('-h');

function usage() {
  console.log(`安装 Innate Studio 的 Agent CLI 为全局命令

  node ${path.relative(process.cwd(), path.join(ROOT, 'cli', 'install.mjs'))}
  node ${path.relative(process.cwd(), path.join(ROOT, 'cli', 'install.mjs'))} --dir <目录>
  node ${path.relative(process.cwd(), path.join(ROOT, 'cli', 'install.mjs'))} --uninstall`);
}

// 目录可写才算数：existsSync 顺便过滤掉不存在的 /usr/local/bin（新机器可能没有）。
function usable(dir) {
  try {
    if (!fs.existsSync(dir)) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch { return false; }
}

function defaultDirs() {
  if (process.platform === 'win32') return [path.join(os.homedir(), '.innate', 'bin')];
  return ['/usr/local/bin', path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.innate', 'bin')];
}

function inPath(dir) {
  return String(process.env.PATH || '').split(path.delimiter).includes(dir);
}

function isOurs(file) {
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) return fs.readlinkSync(file).includes(MARK);
    return fs.readFileSync(file, 'utf8').includes(MARK);
  } catch { return false; }
}

function remove(dir) {
  let removed = 0;
  for (const name of [NAME, `${NAME}.cmd`]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file) || !isOurs(file)) continue;
    fs.unlinkSync(file);
    console.log(`已移除 ${file}`);
    removed += 1;
  }
  return removed;
}

function shellHint(dir) {
  const shell = path.basename(process.env.SHELL || '');
  const rc = shell.includes('zsh') ? '~/.zshrc' : shell.includes('bash') ? '~/.bashrc' : '你的 shell 配置文件';
  return `  echo 'export PATH="${dir}:$PATH"' >> ${rc} && source ${rc}`;
}

if (wantHelp) {
  usage();
  process.exit(0);
}

if (!fs.existsSync(SRC)) {
  console.error(`找不到 ${SRC}，脚本要在项目里运行。`);
  process.exit(1);
}
fs.chmodSync(SRC, 0o755);

if (wantUninstall) {
  const dirs = flag('dir') && flag('dir') !== true ? [String(flag('dir'))] : defaultDirs();
  let n = 0;
  for (const d of dirs) n += remove(d);
  console.log(n ? '已卸载 innate 命令。' : '没有找到已安装的 innate 命令。');
  process.exit(0);
}

// 挑目录：--dir 优先；否则用第一个「存在且可写」的；都不行就在 ~/.local/bin 建一个。
const wanted = flag('dir');
let dir = wanted && wanted !== true ? String(wanted) : defaultDirs().find(usable);
if (!dir) {
  dir = path.join(os.homedir(), process.platform === 'win32' ? '.innate' : '.local', 'bin');
  fs.mkdirSync(dir, { recursive: true });
}
dir = fs.realpathSync(dir);
fs.mkdirSync(dir, { recursive: true });

const target = path.join(dir, process.platform === 'win32' ? `${NAME}.cmd` : NAME);

if (fs.existsSync(target) && !isOurs(target)) {
  console.error(`${target} 已经存在，而且不是本项目的 CLI。换一个目录：--dir <目录>`);
  process.exit(1);
}

try {
  if (fs.existsSync(target)) fs.unlinkSync(target);
  if (process.platform === 'win32') {
    // Windows 没有 shebang，用一个 .cmd 转一下。
    fs.writeFileSync(target, `@echo off\r\n"${process.execPath}" "${SRC}" %*\r\n`);
  } else {
    fs.symlinkSync(SRC, target);
  }
  fs.chmodSync(target, 0o755);
} catch (err) {
  // 软链失败（比如跨盘、文件系统不支持）就退化成一层薄包装脚本。
  if (process.platform === 'win32') {
    console.error(`安装失败：${err.message}`);
    process.exit(1);
  }
  fs.writeFileSync(target, `#!/bin/sh\nexec "${process.execPath}" "${SRC}" "$@"\n`);
  fs.chmodSync(target, 0o755);
}

// 装完自己跑一下，确认真的能用（只看退出码不够：软链路径对不上的话会静默什么都不做）。
const check = spawnSync(target, ['--help'], { encoding: 'utf8' });
if (check.status !== 0 || !String(check.stdout || '').includes('用法')) {
  console.error(`装好了但跑不起来：${check.stderr || check.error?.message || '没有任何输出'}`);
  process.exit(1);
}

console.log(`✓ 已安装：${target} → ${SRC}`);
console.log(`  现在可以直接用：innate models`);
if (!inPath(dir)) {
  console.log(`  ⚠ ${dir} 不在 PATH 里，把它加进去才能在任何目录直接用：`);
  console.log(shellHint(dir));
}
if (!process.env.INNATE_API_KEY) {
  console.log(`  提示：多人模式先记住令牌 → innate config set --key isk_…`);
}
