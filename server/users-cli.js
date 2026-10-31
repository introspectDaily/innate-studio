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
import { allUsers, createUser, newPassword, updateUser, userDir } from './auth.js';
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
  } else {
    console.log('用法：\n  pnpm user add <名称> [--admin] [--with-local-data] [--password <密码>]\n  pnpm user reset <名称> [--password <密码>]\n  pnpm user grant <名称> <积分数>\n  pnpm user list');
    process.exit(1);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
