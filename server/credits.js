// 积分：多人模式下每个成员一份余额，生成要花积分。1 积分 = 0.01 元，怎么折算在 shared/models.ts。
// 提交时按估价预扣，生成完按实际用量多退少补，失败了全退。平台不返回用量的（AiHubMix 的图片）就按预扣的收。
// 流水一行一条追加在数据目录的 credits.jsonl 里，余额是把流水加起来。本机模式没有积分。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { HttpError } from './http.js';
import { estimateCost, quoteCost, toCredits } from '../shared/models.ts';

const LEDGER_FILE = path.join(DATA_DIR, 'credits.jsonl');
const entries = [];
const balances = new Map();

function apply(entry) {
  entries.push(entry);
  balances.set(entry.userId, (balances.get(entry.userId) || 0) + entry.delta);
}

try {
  for (const line of fs.readFileSync(LEDGER_FILE, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      apply(JSON.parse(line));
    } catch {
      /* 写到一半就断电的半行，跳过 */
    }
  }
} catch {
  /* 还没有流水 */
}

// type：grant 是管理员发放（或扣回），hold 是提交时预扣，settle 是完成后补扣，refund 是退回。
function record(entry) {
  const full = { at: Date.now(), ...entry };
  fs.appendFileSync(LEDGER_FILE, `${JSON.stringify(full)}\n`, { mode: 0o600 });
  apply(full);
}

export const balanceOf = (userId) => balances.get(userId) || 0;

// 这个月花了多少积分：预扣、补扣、退回加起来。
export function monthUsed(userId) {
  const now = new Date();
  const since = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  let used = 0;
  for (const entry of entries) if (entry.userId === userId && entry.type !== 'grant' && entry.at >= since) used -= entry.delta;
  return used;
}

export function grantCredits(user, amount, by) {
  const delta = Math.round(Number(amount));
  if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 10_000_000) throw new HttpError(400, 'invalid_request', '请输入有效的积分数');
  record({ userId: user.id, delta, type: 'grant', by: by.id });
  return balanceOf(user.id);
}

// 提交之前预扣。items 是这次要建的记录（一次出几张图就是几条），预扣了多少记在每条的 credits 里。
// 余额不够就不让提交；管理员不拦，但照样记账。
export function holdCredits(user, items, opts) {
  if (!user) return;
  const quotes = items.map((item) => toCredits(quoteCost(item, opts) || 0));
  const total = quotes.reduce((sum, n) => sum + n, 0);
  const balance = balanceOf(user.id);
  if (user.role !== 'admin' && balance < total) throw new HttpError(402, 'insufficient_credits', `积分不足：本次需要 ${total}，剩余 ${balance}`);
  items.forEach((item, index) => {
    item.credits = { quote: quotes[index], charged: quotes[index] };
    if (quotes[index]) record({ userId: user.id, delta: -quotes[index], type: 'hold', kind: item.kind, model: item.model });
  });
}

// 一条记录的状态变了之后对一次账：还在跑的不动，完成了的按实际用量收（算不出来就按预扣的），失败了的全退。
// 可以反复调：查询超时退掉的，之后又查到完成了，会再扣回来。调用的地方负责把记录存盘。
// opts.seconds 是平台返回的实际时长（AutoDL 按秒计费时用）；给了 opts.fixedYuan 就按这个固定价收（平台按任务定价，和时长无关）。
export function syncCredits(space, item, opts = {}) {
  if (!space.userId || !item.credits) return;
  if (item.status !== 'completed' && item.status !== 'failed') return;
  const cost = item.status === 'completed' ? (opts.fixedYuan ?? estimateCost(item, opts)) : 0;
  const target = cost == null ? item.credits.quote : toCredits(cost);
  const delta = item.credits.charged - target;
  if (!delta) return;
  record({ userId: space.userId, delta, type: delta > 0 ? 'refund' : 'settle', itemId: item.id });
  item.credits.charged = target;
}
