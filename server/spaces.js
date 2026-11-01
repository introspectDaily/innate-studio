// 每个请求用哪一份数据：本机模式是数据目录本身，多人模式是登录的那个成员自己的目录。
// 一份数据第一次打开时，把上次留下的记录理一遍、给旧记录补上小图。

import { openSpace } from './store.js';
import { userDir, allUsers } from './auth.js';
import { resumePending, settleHistory } from './tasks.js';
import { backfillThumbs } from './thumbs.js';

const ready = new Set();

function prepare(space, user) {
  if (ready.has(space)) return space;
  ready.add(space);
  // 这份数据是谁的。积分记在这个账号上；本机模式是 null，没有积分。
  space.userId = user?.id || null;
  settleHistory(space);
  // 重启后接着跑：平台上还在跑的任务继续查，跑完了的继续把文件存到本机。
  space.resumed = (space.resumed || 0) + resumePending(space);
  backfillThumbs(space);
  return space;
}

export function spaceOf(user) {
  return prepare(user ? openSpace(userDir(user.id)) : openSpace(), user);
}

// 服务启动时把所有空间都打开。
// 不这样的话，轮询循环要等到第一个请求进来才看得到这些记录——
// 用户重启服务后没打开页面，任务就没人管了，结果也不会自动存下来。
export function openAllSpaces() {
  const spaces = [prepare(openSpace(), null)];
  for (const user of allUsers()) spaces.push(prepare(openSpace(userDir(user.id)), user));
  const resumed = spaces.reduce((sum, space) => sum + (space.resumed || 0), 0);
  if (resumed) console.log(`接上了 ${resumed} 个还在跑的任务，继续查状态、继续存结果。`);
  return spaces;
}
