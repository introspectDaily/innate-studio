#!/usr/bin/env node

// 在命令行里管账号。第一个管理员只能在这里建：建了第一个账号，服务就进入多人模式，要登录才能用。
//   pnpm user add <名称> [--admin] [--with-local-data]    建账号，密码随机生成，只在这里显示一次
//   pnpm user reset <名称>                                重置密码
//   pnpm user list                                        列出账号
// --with-local-data：把数据目录里原来本机模式的数据（生成记录、画布、角色、技能、工作流和文件）搬给这个账号。
// 运行前先停掉服务，改完再启动：服务运行时账号在它的内存里，这里改的会被它覆盖。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { allUsers, createApiKey, createUser, listApiKeys, newPassword, revokeApiKey, updateUser, userDir } from './auth.js';
import { balanceOf, grantCredits } from './credits.js';

const rawArgs = process.argv.slice(2);
let customPassword = null;
const filteredArgs = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--password' && rawArgs[i + 1]) {
    customPassword = rawArgs[i + 1];
    i++;
  } else if (rawArgs[i].startsWith('--password=')) {
    customPassword = rawArgs[i].slice('--password='.length);
  } else {
    filteredArgs.push(rawArgs[i]);
  }
}

const [command, name, ...flags] = filteredArgs;
const LOCAL_DATA = ['history.json', 'canvases.json', 'characters.json', 'skills.json', 'workflows.json', 'videos', 'images', 'audio', 'uploads', 'thumbs'];

function moveLocalData(id) {
  const target = userDir(id);
  fs.mkdirSync(target, { recursive: true });
  for (const entry of LOCAL_DATA) {
    const from = path.join(DATA_DIR, entry);
    if (fs.existsSync(from) && !fs.existsSync(path.join(target, entry))) fs.renameSync(from, path.join(target, entry));
  }
}

try {
  if (command === 'add' && name) {
    const password = customPassword || newPassword();
    const user = createUser({ name, role: flags.includes('--admin') ? 'admin' : 'member', password });
    if (flags.includes('--with-local-data')) moveLocalData(user.id);
    console.log(`已创建${user.role === 'admin' ? '管理员' : '成员'}：${user.name}`);
    console.log(`初始密码：${password}`);
    if (!customPassword) console.log('密码只显示这一次。');
  } else if (command === 'reset' && name) {
    const user = allUsers().find((u) => u.name.toLowerCase() === name.toLowerCase());
    if (!user) throw new Error(`没有名为「${name}」的账号`);
    const password = customPassword || newPassword();
    updateUser(user, { password });
    console.log(`${user.name} 的新密码：${password}`);
  } else if (command === 'grant' && name) {
    const user = allUsers().find((u) => u.name.toLowerCase() === name.toLowerCase());
    if (!user) throw new Error(`没有名为「${name}」的账号`);
    const amount = Number(flags[0]);
    if (!amount) throw new Error('请输入有效的积分数');
    const balance = grantCredits(user, amount, { id: 'cli' });
    console.log(`已为 ${user.name} 发放积分，当前余额：${balance} 积分`);
  } else if (command === 'list') {
    for (const user of allUsers()) console.log(`${user.role === 'admin' ? '管理员' : '成员  '}  ${user.name}${user.disabled ? '（已停用）' : ''}  积分: ${balanceOf(user.id)}`);
    if (!allUsers().length) console.log('还没有账号，服务处于本机模式。');
  } else if (command === 'token' && name === 'add') {
    // 本机模式（没有账号）创建绑定到“本地 Agent”的 key；多人模式必须指定 --user <名称>。
    let userId = null;
    if (allUsers().length) {
      const who = flags.find((f) => f.startsWith('--user='))?.slice('--user='.length) || (flags.includes('--user') ? flags[flags.indexOf('--user') + 1] : null);
      const target = allUsers().find((u) => u.name.toLowerCase() === String(who || '').toLowerCase());
      if (!target) throw new Error('多人模式下请用 --user <名称> 指定令牌绑定的账号');
      userId = target.id;
    }
    const scope = flags.includes('--scope=read') ? 'read' : 'write';
    const display = flags.find((f) => f.startsWith('--name='))?.slice('--name='.length) || 'agent-key';
    const key = createApiKey({ userId, name: display, scope });
    console.log(`已创建令牌（${scope}）：${key.name}`);
    console.log(`令牌：${key.token}`);
    console.log('令牌只显示这一次，请妥善保存。');
  } else if (command === 'token' && name === 'list') {
    let userId = null;
    if (allUsers().length) {
      const who = flags.find((f) => f.startsWith('--user='))?.slice('--user='.length) || (flags.includes('--user') ? flags[flags.indexOf('--user') + 1] : null);
      const target = allUsers().find((u) => u.name.toLowerCase() === String(who || '').toLowerCase());
      if (!target) throw new Error('多人模式下请用 --user <名称> 指定账号');
      userId = target.id;
    }
    const items = listApiKeys(userId);
    if (!items.length) console.log('还没有令牌。');
    for (const k of items) console.log(`${k.scope === 'read' ? '只读 ' : '读写 '}  ${k.prefix}…  ${k.name}  创建于 ${new Date(k.createdAt).toISOString().slice(0, 10)}`);
  } else if (command === 'token' && name === 'revoke' && flags[0]) {
    let userId = null;
    if (allUsers().length) {
      const who = flags.find((f) => f.startsWith('--user='))?.slice('--user='.length) || (flags.includes('--user') ? flags[flags.indexOf('--user') + 1] : null);
      const target = allUsers().find((u) => u.name.toLowerCase() === String(who || '').toLowerCase());
      if (!target) throw new Error('多人模式下请用 --user <名称> 指定账号');
      userId = target.id;
    }
    revokeApiKey(userId, flags[0]);
    console.log(`已吊销令牌 ${flags[0]}`);
  } else {
    console.log('用法：\n  pnpm user add <名称> [--admin] [--with-local-data] [--password <密码>]\n  pnpm user reset <名称> [--password <密码>]\n  pnpm user grant <名称> <积分数>\n  pnpm user list\n  pnpm user token add [--user <名称>] [--name <名>] [--scope read|write]\n  pnpm user token list [--user <名称>]\n  pnpm user token revoke <id> [--user <名称>]');
    process.exit(1);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
