// 调用 RunningHub 的 ComfyUI 工作流接口：多 Key 路由、上传素材、提交任务、查任务。
//
// 和别的平台都不一样的地方：
// 1. 一整套 Key，不是一个 Key。每个 Key 有自己的最大并发（默认 1）；一个 Key 满了就换下一个，
//    全满时等一小会儿（RUNNINGHUB_QUEUE_WAIT_MS）再放弃，让用户重试。
// 2. Key 分属两个站点：国内站 runninghub.cn、海外站 runninghub.ai。两个站是独立的产品——账号、Key、
//    工作流 id、素材库都不通用，所以每个 Key 带一个 site（枚举 ai / cn），请求按它打到对应域名。
// 3. 判成败不能看 HTTP 状态：平台成功失败都返回 200，要看 body 里的 errorCode（V2）或者 code（V1）。
// 4. 素材要先传到平台，拿回 fileName 才能塞进 ComfyUI 节点的字段里（不是公网 URL 那套）。两个站的素材库
//    也是分开的，所以素材必须传到「这次任务用的那个 Key」所在的站点。
// 5. 每个 Key 的账户还有自己的余额（remainCoins，RH 币）。挑 Key 时优先用余额多的，让各账号余额趋近；
//    余额是后台定时拉回来的一份快照，提交任务时只读内存，不会为了排序去打平台接口。
//
// Key 从哪来：环境变量 RUNNINGHUB_KEYS_FILE 给一个 JSON 文件的路径，读出里面的 Key 列表。
// 没有路径时也认 RUNNINGHUB_KEYS（一段 JSON 文本）和 RUNNINGHUB_API_KEY（单个 Key）。
// JSON 的形状（三种都行，混着写也行）：
//   ["rh-aaa", "rh-bbb"]
//   [{"title": "国内主账号", "key": "rh-aaa", "site": "cn", "concurrency": 2}, {"title": "海外号", "key": "rh-bbb", "site": "ai"}]
//   {"keys": [{"title": "主账号", "key": "rh-aaa", "site": "cn"}]}
// site 只能是 ai 或 cn；不写就用 RUNNINGHUB_SITE（默认 cn，照顾原来只配国内站的部署）。
// 没写 title 的按顺序叫 Key 1、Key 2；没写 concurrency 的是 1；enabled: false 可以临时下线一个 Key。
// 文件改了不用重启：每次取 Key 都看文件的修改时间，变了就重读。
// Key 只在这个文件里读、只放进请求头，不落盘、不写日志、不给页面完整值。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { RUNNINGHUB } from './config.js';
import { HttpError } from './http.js';
import { config, openSpaces } from './store.js';
import { upstreamError } from './ark.js';
import { RH_SITES, RH_WORKFLOWS, rhSiteOf } from '../shared/runninghub.ts';

const DEFAULT_CONCURRENCY = 1;
const MAX_CONCURRENCY = 20;
const USER_AGENT = 'innate-studio/1.0 (runninghub-comfyui)';
const RELOAD_MS = 5 * 1000;
const CONNECT_ERRORS = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET']);
const MAX_CONNECT_ATTEMPTS = 3;

// ---------- Key 文件 ----------

const keyId = (value) => `k${crypto.createHash('sha1').update(value).digest('hex').slice(0, 10)}`;
// 给页面看的形状：头尾各四个字符。太短的就不漏了。
const mask = (value) => (value.length <= 8 ? '…' : `${value.slice(0, 4)}…${value.slice(-4)}`);

export const rhSiteLabel = (site) => RUNNINGHUB.sites[site]?.label || String(site || '');
export const rhSiteHost = (site) => RUNNINGHUB.sites[site]?.host || RUNNINGHUB.sites.cn.host;
// 这次请求该打到哪个域名：配了 RUNNINGHUB_BASE_URL 就全体走它（调试/代理），否则按 Key 的站点。
export const rhBaseUrl = (site) => RUNNINGHUB.baseUrl || rhSiteHost(site);

// 把一份 JSON 读成 Key 列表。认不出来的条目跳过，不因为一条写错就整份作废。
// error 里会写明哪几条被跳过了（比如 site 写成了 us），管理面板直接显示这一句。
export function parseKeys(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { keys: [], error: 'Key 文件不是合法的 JSON' };
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.keys) ? data.keys : data?.key ? [data] : [];
  const keys = [];
  const bad = [];
  const seen = new Set();
  const titles = new Set();
  for (const [index, entry] of list.entries()) {
    const record = typeof entry === 'string' ? { key: entry } : entry && typeof entry === 'object' ? entry : {};
    const value = String(record.key ?? record.apiKey ?? record.token ?? '').trim();
    if (!value || seen.has(value)) continue;
    if (record.enabled === false) {
      seen.add(value);
      continue;
    }
    seen.add(value);
    // 站点：ai / cn 两个枚举值。没写就用默认站点；写了别的值这条直接不要，免得请求打到错的站。
    const rawSite = record.site ?? record.region ?? record.host;
    const site = rawSite === undefined || rawSite === null || String(rawSite).trim() === '' ? RUNNINGHUB.site : rhSiteOf(rawSite);
    if (!site) {
      bad.push(`第 ${index + 1} 个 Key 的 site「${String(rawSite).slice(0, 24)}」不是 ai / cn`);
      continue;
    }
    // 没写 title 的按顺序编号；两条重名的加个后缀（不然管理面板上分不清谁是谁）。
    let title = String(record.title ?? record.name ?? '').trim() || `Key ${index + 1}`;
    if (titles.has(title)) title = `${title} (${index + 1})`;
    titles.add(title);
    const wanted = Number(record.concurrency ?? record.maxConcurrency ?? record.max);
    const concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, Math.round(Number.isFinite(wanted) && wanted > 0 ? wanted : DEFAULT_CONCURRENCY)));
    keys.push({ id: keyId(value), title, key: value, hint: mask(value), concurrency, site, index });
  }
  return { keys, error: bad.length ? `有 ${bad.length} 个 Key 没读进来：${bad.slice(0, 3).join('；')}` : '' };
}

let cache = { at: 0, stamp: '', keys: [], source: '', error: '' };

// 内存里的源（环境变量、config.json）用内容摘要当 stamp：内容换了就能发现，
// 不然 env 源永远叫「env:RUNNINGHUB_KEYS」，改了内容也重读不了。摘要只在内存里比，不落盘不输出。
const digest = (raw) => crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12);

function readKeySource() {
  const file = process.env[RUNNINGHUB.envKeysFile] || '';
  if (file) {
    const resolved = path.resolve(file);
    try {
      const stat = fs.statSync(resolved);
      return { raw: fs.readFileSync(resolved, 'utf8'), stamp: `${resolved}:${stat.mtimeMs}`, source: resolved };
    } catch (err) {
      return { raw: '', stamp: `${resolved}:missing`, source: resolved, error: `读不到 Key 文件 ${resolved}：${err.message}` };
    }
  }
  if (process.env[RUNNINGHUB.envKeys]) {
    const raw = process.env[RUNNINGHUB.envKeys];
    return { raw, stamp: `env:RUNNINGHUB_KEYS:${digest(raw)}`, source: '环境变量 RUNNINGHUB_KEYS' };
  }
  if (process.env[RUNNINGHUB.envKey]) {
    const raw = JSON.stringify([process.env[RUNNINGHUB.envKey]]);
    return { raw, stamp: `env:RUNNINGHUB_API_KEY:${digest(raw)}`, source: '环境变量 RUNNINGHUB_API_KEY' };
  }
  // 兜底：数据目录 config.json 里的 runninghubKeys（和管理面板能改的其它 Key 放一起）。
  const inline = config[RUNNINGHUB.configKey];
  if (inline) {
    const raw = typeof inline === 'string' ? inline : JSON.stringify(inline);
    return { raw, stamp: `config:runninghubKeys:${digest(raw)}`, source: '数据目录 config.json' };
  }
  return { raw: '', stamp: '', source: '', error: '' };
}

// 当前的 Key 列表。只有「文件源」才用 5 秒节流（省掉每次请求都 stat）；
// 环境变量和 config.json 都在内存里，读一次几乎不花钱，所以每次都读，改了立刻生效。
export function rhKeys() {
  const now = Date.now();
  const file = process.env[RUNNINGHUB.envKeysFile];
  if (file && cache.at && now - cache.at < RELOAD_MS && cache.stamp.startsWith(`${path.resolve(file)}:`)) return cache.keys;
  const source = readKeySource();
  if (source.error) {
    cache = { at: now, stamp: source.stamp, keys: [], source: source.source, error: source.error };
    return cache.keys;
  }
  if (!source.stamp) {
    cache = { at: now, stamp: '', keys: [], source: '', error: '' };
    return cache.keys;
  }
  if (cache.stamp === source.stamp) {
    cache.at = now;
    return cache.keys;
  }
  const { keys, error } = parseKeys(source.raw);
  cache = { at: now, stamp: source.stamp, keys, source: source.source, error };
  return cache.keys;
}

export const rhHasKey = () => rhKeys().length > 0;
export const rhKeyById = (id) => rhKeys().find((item) => item.id === id) || null;

// /api/state 里那一小块：只说到「配了几个、总共能并行几个、我们派出去了几个、涉及哪几个站点」，不列 Key。
// 这里的 running 是**我们自己**占的位子：/api/state 每次刷新都会走一遍，不便挨个问平台。
// 平台上真实在跑多少（别人也用同一个 Key 的时候会更多）由 rhKeyState() 给管理面板。
export function rhSummary() {
  const keys = rhKeys();
  return {
    hasKey: keys.length > 0,
    count: keys.length,
    concurrency: keys.reduce((sum, item) => sum + item.concurrency, 0),
    running: keys.reduce((sum, item) => sum + slotsOf(item.id).size, 0),
    sites: RH_SITES.filter((site) => keys.some((item) => item.site === site)),
  };
}

// ---------- 平台侧运行状态与余额 ----------
// 为什么要问平台：这份 Key 文件里的 Key 可能同时被别的项目、别的人用，本地只知道自己派出去几单，
// 平台上真正占着并发的是「我们 + 别人」。管理面板上的「在跑」要的是后者。
// 用 /uc/openapi/accountStatus（网页端在用的账号接口，文档没公开，实测可用）：
//   POST {apiKey} → {code:0, data:{remainCoins:"10351", currentTaskCounts:"0", remainMoney, currency, apiType}}
// currentTaskCounts 是这个账号此刻在跑的任务数；remainCoins 是剩余 RH 币（账户积分）。按 Key 各查各的：
// 余额既给管理面板看，也用来挑 Key——优先用余额多的账号，让各账号的余额慢慢趋近。
// 另一条 /api/billing/usage/wideDetails（网页端「账单明细」）**用 API Key 打不通**：
// 返回 {code:412,msg:"TOKEN_INVALID"}，它只认浏览器里的登录 token，所以不选它。
// 查平台要花时间，所以答案缓存 20 秒；服务另外按 RUNNINGHUB_COINS_REFRESH_MS 后台刷新，路由只读这份内存快照，
// 提交任务时绝不为了算优先级去打一次网络请求。
const LIVE_TTL_MS = 20 * 1000;
const LIVE_TIMEOUT_MS = 8 * 1000;
const LIVE_CONCURRENCY = 4;
let live = { at: 0, stamp: '', counts: new Map(), coins: new Map(), coinIds: new Set(), error: '', ok: false, coinsOk: false };
let inflight = null;

// 平台给的是字符串，也可能是 null（remainMoney 就是）。认不出来一律当「没问到」，不能把 null 当成 0 币。
function numeric(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// 账户状态里我们关心的两个数，抽出来单独测。
export function parseAccountStatus(data) {
  const running = numeric(data?.currentTaskCounts);
  const coins = numeric(data?.remainCoins);
  return {
    running: running == null ? null : Math.max(0, Math.round(running)),
    coins: coins == null ? null : Math.max(0, Math.round(coins * 100) / 100),
  };
}

// 上次快照之后派出去的单：{id, at}。平台余额的更新有延迟，用它给刚派过单的 Key 先记一笔虚拟消耗，
// 免得同一批并发请求全挤到「余额最高」的那一个 Key 上。拿到新快照后，快照时刻之前的记录作废。
let dispatches = [];
const pruneDispatches = (at) => {
  dispatches = dispatches.filter((item) => item.at > at);
};

async function collectLive(keys, stamp) {
  const counts = new Map();
  const coins = new Map();
  const failed = [];
  let cursor = 0;
  // 快照时间取发起查询的时刻：这之后派出去的单，消耗多半还没反映到平台的余额里。
  const at = Date.now();
  // 同时最多问 4 个：Key 多了也不至于一口气打出几十个请求。
  const worker = async () => {
    while (cursor < keys.length) {
      const item = keys[cursor++];
      try {
        // 这个接口要 body 里再带一份 apiKey（V1 的老规矩），只给 header 不认。
        const data = await call(item, { path: '/uc/openapi/accountStatus', json: { apiKey: item.key }, timeoutMs: LIVE_TIMEOUT_MS });
        const status = parseAccountStatus(data);
        if (status.running != null) counts.set(item.id, status.running);
        if (status.coins != null) coins.set(item.id, status.coins);
        if (status.running == null && status.coins == null) failed.push(item.title);
      } catch {
        // 单个 Key 查不到（失效、被封、超时）不影响别的 Key：这个 Key 的页面数字回落到本地计数。
        failed.push(item.title);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LIVE_CONCURRENCY, keys.length) }, worker));
  // 余额变化慢，某一轮全问不到时留着上次的值继续用，别让路由突然跳回纯轮转。
  // 在跑数不行：那是「此刻」的数，查不到就得回落本地计数，不能拿旧值冒充。
  const merged = new Map(live.coins);
  for (const [id, value] of coins) merged.set(id, value);
  if (coins.size > 0) pruneDispatches(at);
  live = {
    at,
    stamp,
    counts,
    coins: merged,
    coinIds: new Set(coins.keys()),
    ok: counts.size > 0 || coins.size > 0,
    coinsOk: coins.size > 0,
    error: failed.length ? `有 ${failed.length} 个 Key 没问到平台状态（${failed.slice(0, 2).join('、')}${failed.length > 2 ? ' 等' : ''}）` : '',
  };
  return live;
}

// 每个 Key 在平台上跑着几个任务、还剩多少币。Key 文件变了（stamp 变了）就重新问，不看缓存。
// force 给管理面板的「刷新」用：不等 20 秒 TTL，立刻再问一次平台。
export function rhLiveUsage({ force = false } = {}) {
  const keys = rhKeys();
  const stamp = `${readKeySource().stamp}|${keys.map((item) => `${item.id}:${item.site}`).join(',')}`;
  if (!force && live.stamp === stamp && live.at && Date.now() - live.at < LIVE_TTL_MS) return Promise.resolve(live);
  // 两个人同时打开管理面板时只发一轮请求。
  if (inflight) return inflight;
  inflight = collectLive(keys, stamp).finally(() => {
    inflight = null;
  });
  return inflight;
}

// 服务启动时开一个后台刷新：不打开管理面板、只提交任务的部署，路由也能拿到余额。
// 定时器 unref，不拦着进程退出；设 RUNNINGHUB_COINS_REFRESH_MS=0 可以只靠管理面板和提交时的懒刷新。
let poller = null;
export function startRhCoinsPolling() {
  if (poller || RUNNINGHUB.coinsRefreshMs <= 0) return;
  const tick = () => void rhLiveUsage().catch(() => {});
  tick();
  poller = setInterval(tick, RUNNINGHUB.coinsRefreshMs);
  poller.unref?.();
}

// 提交任务时顺手催一次刷新（不等待）：TTL 和 inflight 保证不会重复打平台。
export const kickRhCoinsRefresh = () => void rhLiveUsage().catch(() => {});

// 管理面板用：有哪些 Key（各自在哪个站点、平台上跑到多满、还剩多少 RH 币）、从哪儿读的。
// **只给头尾**，不给完整 Key。这一份只给管理员（routes/runninghub.js 里 access = 'admin'）。
// running 优先用平台给的 currentTaskCounts；平台没答上来的那个 Key 才用本地计数，并标注 measured。
export async function rhKeyState({ force = false } = {}) {
  const keys = rhKeys();
  const source = readKeySource();
  const usage = await rhLiveUsage({ force });
  const runningOf = (item) => usage.counts.get(item.id) ?? slotsOf(item.id).size;
  const coinsOf = (item) => usage.coins.get(item.id) ?? null;
  const known = keys.map(coinsOf).filter((value) => value !== null);
  const min = known.length ? Math.min(...known) : null;
  const max = known.length ? Math.max(...known) : null;
  return {
    configured: keys.length > 0,
    source: source.source,
    envVar: RUNNINGHUB.envKeysFile,
    error: source.error || cache.error || '',
    total: keys.length,
    concurrency: keys.reduce((sum, item) => sum + item.concurrency, 0),
    running: keys.reduce((sum, item) => sum + runningOf(item), 0),
    // 这批数字是问的谁：platform = RunningHub 平台（含别人跑的），local = 本地占位（平台查不到时的兜底）。
    live: { at: usage.at, ok: usage.ok, coinsOk: usage.coinsOk, error: usage.error, ttl: LIVE_TTL_MS },
    // 余额汇总：极差越小，说明各账号用得越均衡。
    coins: {
      unit: 'RH 币',
      at: usage.at,
      known: known.length,
      unknown: keys.length - known.length,
      total: known.length ? known.reduce((sum, value) => sum + value, 0) : null,
      min,
      max,
      spread: min === null ? null : Math.round((max - min) * 100) / 100,
    },
    routing: { byCoins: RUNNINGHUB.routeByCoins, refreshMs: RUNNINGHUB.coinsRefreshMs },
    // 两个站点各自配了几个 Key、能并行几个、合计还剩多少币（一个站没配就是 0 / null）。
    sites: RH_SITES.map((site) => {
      const own = keys.filter((item) => item.site === site);
      const ownCoins = own.map(coinsOf).filter((value) => value !== null);
      return {
        site,
        label: rhSiteLabel(site),
        host: rhSiteHost(site),
        keys: own.length,
        concurrency: own.reduce((sum, item) => sum + item.concurrency, 0),
        coins: ownCoins.length ? ownCoins.reduce((sum, value) => sum + value, 0) : null,
      };
    }),
    keys: keys.map((item) => {
      const running = runningOf(item);
      return {
        title: item.title,
        hint: item.hint,
        site: item.site,
        siteLabel: rhSiteLabel(item.site),
        concurrency: item.concurrency,
        running,
        coins: coinsOf(item),
        // platform = 这次刚问到；cached = 这轮没问到、沿用上次的值；unknown = 从没问到过。
        coinsMeasured: usage.coinIds.has(item.id) ? 'platform' : usage.coins.has(item.id) ? 'cached' : 'unknown',
        // 这个数字是平台给的，还是（平台没答上来时）本地自己数的。
        measured: usage.counts.has(item.id) ? 'platform' : 'local',
        localRunning: slotsOf(item.id).size,
        full: running >= item.concurrency,
      };
    }),
    // 每个工作流在两个站点上各配的是哪个 workflowId、配好了没有（工作流 id 不是密钥，可以照实显示）。
    workflows: RH_WORKFLOWS.map((workflow) => {
      const ids = resolveWorkflowIds(workflow);
      return {
        key: workflow.key,
        name: workflow.name,
        kind: workflow.kind,
        // ai-app 是平台包装过的「AI 应用」，提交端点和普通工作流不同，面板上标出来免得把 id 混着配。
        endpoint: workflow.endpoint || 'workflow',
        ids,
        ready: RH_SITES.some((site) => Boolean(ids[site])),
        // 没配好的站点，把登记表里该填的那一行列出来（两个站可以共用同一个 id）。
        missing: RH_SITES.filter((site) => !ids[site]).map((site) => workflowIdPath(workflow, site)),
      };
    }),
  };
}

// ---------- 工作流 id ----------
// 每个工作流在 RunningHub 上有一个 id，两个站点各自独立（同一个工作流在 .cn 和 .ai 上导出的 id 不一样）。
// 登记在 shared/runninghub-workflows.json（进 git），shared/runninghub.ts 按 key 把它挂到 workflowId 上。
// 不用环境变量：工作流多了，一份能看、能 diff 的登记表比一堆变量好维护。
const idFrom = (value, site) => {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') return String(value[site] ?? '').trim();
  return '';
};

// 给管理面板显示用：这个站点在登记表里该填哪一行。
export function workflowIdPath(workflow, site) {
  return `shared/runninghub-workflows.json → workflows.${workflow.key}.ids.${site}`;
}

export function resolveWorkflowId(workflow, site = RUNNINGHUB.site) {
  if (!workflow) return '';
  const wanted = rhSiteOf(site) || RUNNINGHUB.site;
  return idFrom(workflow.workflowId, wanted);
}

// 两个站点各自的 id，管理面板和目录都用它。
export function resolveWorkflowIds(workflow) {
  return Object.fromEntries(RH_SITES.map((site) => [site, resolveWorkflowId(workflow, site)]));
}

// ---------- 并发与路由 ----------
// 每个 Key 现在占着几个位子。位子先记一个临时的 ticket，提交成功后换成 taskId，
// 这样「提交到拿到 taskId」这段时间里别的请求不会挑中同一个 Key。
const running = new Map();
let cursor = 0;

const slotsOf = (id) => running.get(id) || new Set();

// 给空闲的 Key 排优先级。纯函数，方便单测；coins / spent 都是 Map<keyId, number>。
// 目标：余额多的先用，高余额先被消耗，各账号的余额慢慢趋近。四条规矩：
//  1. 查不到余额的按「已知余额里最低的那个」算——既不让它饿死，也不会被优先照顾；
//     一个都没查到时分数全相等，退化成原来的轮转。
//  2. spent 是上次快照之后本进程派出去的单折算的虚拟消耗，防止一批并发请求全挤到余额最高的 Key。
//  3. 只要还有别的 Key 有余额，就把余额耗尽的排除，省得提交时吃平台的 416。
//  4. 同分按轮转顺序排，保持原来「两个都空闲就轮着来」的手感。
export function rankKeys(free, { coins = new Map(), spent = new Map(), cursor: rotation = 0, byCoins = true } = {}) {
  const size = free.length;
  if (!size) return [];
  const values = free.map((item) => {
    const value = coins.get(item.id);
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  });
  const known = values.filter((value) => value !== null);
  const floor = known.length ? Math.min(...known) : 0;
  const hasBalance = known.some((value) => value > 0);
  return free
    .map((item, index) => ({
      item,
      order: (index - (rotation % size) + size) % size,
      value: values[index],
      score: byCoins ? (values[index] ?? floor) - (spent.get(item.id) || 0) : 0,
    }))
    .filter(({ value }) => !byCoins || !hasBalance || value === null || value > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ item }) => item);
}

// 上次快照之后派出去的单，折算成每个 Key 的虚拟消耗（币）。
// 快照里的余额已经含了查询发起之前的消耗，所以那之前的记录不再计。
function spentSinceSnapshot() {
  const spent = new Map();
  for (const item of dispatches) {
    if (item.at <= live.at) continue;
    spent.set(item.id, (spent.get(item.id) || 0) + RUNNINGHUB.routeSpend);
  }
  return spent;
}

// 服务重启后内存里的计数没了，但平台上那些任务还在跑。用历史记录把占位情况还原回来，
// 不然重启一次就会把同一个 Key 的超额任务又派上去。
// 每次提交前都扫一遍：成员的空间可能是这之后才打开的（多用户模式下），那会儿也要把它算进来。
function hydrate() {
  for (const space of openSpaces()) {
    for (const item of space.history) {
      if (item.provider !== 'runninghub' || !item.rhKeyId) continue;
      if (item.status !== 'queued' && item.status !== 'in_progress') continue;
      if (!running.has(item.rhKeyId)) running.set(item.rhKeyId, new Set());
      running.get(item.rhKeyId).add(item.id);
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 挑一个还有空位的 Key。都满时等一会儿再看，等不到就报「都在忙」。
// 传进来的 workflow 用来过滤：只有「这个站点上配了该工作流 id」的 Key 才能接这单——两个站点的工作流互相调不到，
// 挑错了会在提交时白报一次 380。
// 有余额数据时按「余额多的优先」排，没有就退回轮转。options 里的 coins / spent / byCoins 可以覆盖快照，
// 给测试和特殊调用方用；正常情况下路由只读内存快照，不为了排序去打平台接口。
// 返回的 lease 带一个 ticket 和 site，提交成功后用 claim() 换成 taskId，失败了用 drop() 还回去。
export async function pick(workflow, waitMs = RUNNINGHUB.waitMs, options = {}) {
  hydrate();
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  for (;;) {
    const keys = rhKeys();
    if (!keys.length) throw new HttpError(503, 'no_api_key', 'RunningHub 暂未开通，请联系管理员。');
    const usable = workflow ? keys.filter((item) => Boolean(resolveWorkflowId(workflow, item.site))) : keys;
    if (!usable.length) {
      const sites = [...new Set(keys.map((item) => item.site))].map(rhSiteLabel).join('、') || '当前站点';
      throw new HttpError(503, 'workflow_not_configured', `「${workflow?.name || '这个工作流'}」在${sites}上没有配置工作流 ID，请联系管理员`, { sites: [...new Set(keys.map((item) => item.site))] });
    }
    const free = usable.filter((item) => slotsOf(item.id).size < item.concurrency);
    if (free.length) {
      const ordered = rankKeys(free, {
        coins: options.coins ?? live.coins,
        spent: options.spent ?? spentSinceSnapshot(),
        cursor,
        byCoins: options.byCoins ?? RUNNINGHUB.routeByCoins,
      });
      const key = ordered[0];
      cursor += 1;
      const ticket = `t${crypto.randomBytes(6).toString('hex')}`;
      // 记一笔虚拟消耗：同一批并发提交里，下一个请求会看到这个 Key 已经「花掉」一点。
      dispatches.push({ id: key.id, at: Date.now(), ticket });
      if (dispatches.length > 500) dispatches = dispatches.slice(-250);
      if (!running.has(key.id)) running.set(key.id, new Set());
      running.get(key.id).add(ticket);
      return { ...key, ticket };
    }
    if (Date.now() >= deadline) {
      throw new HttpError(429, 'runninghub_busy', `RunningHub 的 ${usable.length} 个 Key 都在忙，请稍后重试。`);
    }
    await sleep(400);
  }
}

// 提交成功：ticket 换成真正的 taskId，任务跑完才还位子。
export function claim(lease, taskId) {
  const set = running.get(lease.id);
  if (!set) return;
  set.delete(lease.ticket);
  set.add(String(taskId));
}

// 提交失败（或者根本没提交）：立刻还位子，这单也不该算进虚拟消耗。
export function drop(lease) {
  if (!lease?.ticket) return;
  running.get(lease.id)?.delete(lease.ticket);
  dispatches = dispatches.filter((item) => item.ticket !== lease.ticket);
}

// 任务结束（成功或失败）时还位子。查询轮询里调，keyId 记在记录上。
export function releaseTask(keyIdValue, taskId) {
  if (keyIdValue) running.get(keyIdValue)?.delete(String(taskId));
}

// ---------- 请求 ----------

// RunningHub 的错误码。V1 的 code 和 V2 的 errorCode 语义大致对得上，放在一张表里。
// 值的第一项是给用户看的原因，第二项是 HTTP 状态。
const ERROR_CODES = {
  // 上传接口用的是另一套很短的码：1 就是 Key 不存在（实测）。
  1: ['RunningHub 的 Key 无效或已被删除', 401],
  301: ['提交的参数不完整或类型不对', 400],
  380: ['工作流不存在，请核对工作流 ID', 400],
  412: ['接口路径不对（多半是工作流 ID 为空）', 500],
  415: ['平台的独占机器不够用，请稍后重试', 429],
  416: ['RunningHub 账户余额不足，请在平台充值', 402],
  421: ['平台的并发已经满了，请稍后重试', 429],
  423: ['任务不存在或已被平台清理', 404],
  433: ['工作流校验没通过', 400],
  435: ['账号没有这个档位的机器，换成标准档再试', 400],
  801: ['这个 Key 是免费账号，不能调 API', 401],
  802: ['RunningHub 的 Key 无效或已被删除', 401],
  803: ['参数和工作流定义对不上（nodeId 或字段名不对）', 400],
  804: ['任务还在跑', 409],
  806: ['RunningHub 的 Key 无效或已被删除', 401],
  807: ['任务不存在或已被平台清理', 404],
  810: ['这个工作流没保存或从没手动运行过，请先在平台上跑一次', 400],
  813: ['任务在排队', 409],
  814: ['个人队列超过 1000 个，请稍后重试', 429],
  901: ['AI 应用不存在', 400],
  1002: ['RunningHub 的 Key 无效或已被删除', 401],
  1003: ['请求过于频繁，请稍后重试', 429],
  1004: ['任务不存在或已过期', 404],
  1007: ['参数校验没通过', 400],
  1008: ['文件超过平台上限', 400],
  1013: ['素材下载不到，请换一份再试', 400],
  1014: ['这个 Key 不能调标准模型 API，需要企业级共享 Key', 401],
  1015: ['生成失败，可以重试一次', 502],
  1101: ['节点信息异常（nodeInfoList 有问题）', 400],
  1501: ['内容未通过平台审核，请修改提示词或素材', 400],
  1504: ['模型超时，可以重试', 504],
  1505: ['平台禁止生成真人内容，请换素材或提示词', 400],
  1520: ['账号并发达到上限，请稍后重试', 429],
};

function rhError(payload, fallbackStatus, fallbackCode) {
  const code = String(payload?.errorCode || payload?.code || fallbackCode || '');
  const raw = String(payload?.errorMessage || payload?.msg || payload?.message || '').slice(0, 2000);
  const [message, status] = ERROR_CODES[code] || [`RunningHub 返回错误${code ? `（${code}）` : ''}`, 502];
  // 平台把业务错误也放在 200 里，所以这里的状态码不能被它带跑：不认识的错误一律当网关错误（502）。
  const httpStatus = status >= 400 ? status : fallbackStatus >= 400 ? fallbackStatus : 502;
  const err = new HttpError(httpStatus, `runninghub_${code || 'error'}`, message, payload);
  err.detail = raw ? `${RUNNINGHUB.label}（${code}）：${raw}` : '';
  return err;
}

// 一次请求。成功返回解析后的 JSON（V2 是扁平结构，V1 是 {code,msg,data} 的信封，这里统一把 data 拆出来）。
// target 可以是 Key 字符串（按默认站点）或 Key 记录（带 site，提交/查询都走这条）。
// tolerateTaskError 只给查询用：查询接口里「任务失败」也是 200 + errorCode（805 等），
// 那是任务状态而不是接口报错，要交给上层判断，否则任务会永远卡在「进行中」。
async function call(target, { method = 'POST', path: pathname, json, form, timeoutMs = 60000, tolerateTaskError = false }) {
  const keyValue = typeof target === 'string' ? target : String(target?.key || '');
  const site = (typeof target === 'string' ? RUNNINGHUB.site : rhSiteOf(target?.site)) || RUNNINGHUB.site;
  const headers = { Authorization: `Bearer ${keyValue}`, Accept: 'application/json', 'User-Agent': USER_AGENT };
  let body;
  if (form) body = form;
  else if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }

  let res;
  for (let attempt = 1; ; attempt += 1) {
    try {
      res = await fetch(rhBaseUrl(site) + pathname, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
      break;
    } catch (err) {
      if (CONNECT_ERRORS.has(err?.cause?.code) && attempt < MAX_CONNECT_ATTEMPTS) continue;
      const reason = err?.name === 'TimeoutError' ? '请求超时' : err?.cause?.code || err?.message;
      throw new HttpError(502, 'upstream_unreachable', `连接 ${RUNNINGHUB.label}（${rhSiteLabel(site)}）失败：${reason}`);
    }
  }

  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text.slice(0, 2000) };
    }
  }

  // 平台几乎不用 HTTP 状态表达业务错误，真给了 4xx/5xx 才是连接层的问题。
  if (!res.ok && res.status >= 500) throw upstreamError(RUNNINGHUB.label, res.status, `http_${res.status}`, payload?.raw || `HTTP ${res.status}`, payload);
  // V2：扁平结构，errorCode 为空字符串才算成功。
  if (payload && Object.hasOwn(payload, 'errorCode')) {
    // 带 status 字段的说明这是「任务的结果」，不是「接口调不动了」，查询时照常返回。
    const isTaskResult = typeof payload.status === 'string' && Object.hasOwn(payload, 'taskId');
    if (payload.errorCode && !(tolerateTaskError && isTaskResult)) throw rhError(payload, res.status, `http_${res.status}`);
    return payload;
  }
  // V1：{code, msg, data}，code 是 0 才算成功。
  if (payload && Object.hasOwn(payload, 'code')) {
    if (Number(payload.code) !== 0) throw rhError(payload, res.status, `http_${res.status}`);
    return payload.data ?? payload;
  }
  if (!res.ok) throw upstreamError(RUNNINGHUB.label, res.status, `http_${res.status}`, text.slice(0, 2000), payload);
  return payload;
}

// ---------- 素材上传 ----------
// 工作流节点的图片、视频字段要的是平台上的 fileName（不是 URL）。同一份文件在一天里只传一次：
// 平台给的地址只有 1 天有效期，缓存比它短一点。
// 两个站点的素材库是分开的，所以缓存键里带站点——同一个 Key 从 .cn 挪到 .ai（改了 site）时不会用错文件名。
const uploads = new Map();

export async function uploadMedia(lease, { buffer, filename, contentType }) {
  const digest = crypto.createHash('sha1').update(buffer).digest('hex');
  const cacheKey = `${lease.site || RUNNINGHUB.site}:${lease.id}:${digest}`;
  const cached = uploads.get(cacheKey);
  if (cached && Date.now() - cached.at < RUNNINGHUB.uploadTtlMs) return cached.value;

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: contentType || 'application/octet-stream' }), filename || `${digest.slice(0, 8)}.bin`);
  const data = await call(lease, { path: '/openapi/v2/media/upload/binary', form, timeoutMs: 180000 });
  const fileName = data?.fileName || data?.data?.fileName;
  if (!fileName) throw new HttpError(502, 'bad_upstream_response', `${RUNNINGHUB.label} 没有返回素材文件名`, data);
  const value = { fileName: String(fileName), downloadUrl: data?.download_url || data?.data?.download_url || '' };
  uploads.set(cacheKey, { at: Date.now(), value });
  return value;
}

// ---------- 提交 ----------
// 优先走 V2。两类端点共用一条链路，差别在 URL 和请求体：
//   workflow → /openapi/v2/run/workflow/{workflowId}，nodeInfoList 的值保持原类型；
//   ai-app   → /openapi/v2/run/ai-app/{appId}，官方示例里每个 fieldValue 都是字符串、带 description:null，
//              另外还要带 usePersonalQueue。
// 普通工作流万一 V2 没了，还能退回文档主推的 V1（/task/openapi/create，body 里再带一份 apiKey）。
export async function submitWorkflow(lease, workflowId, nodeInfoList, { instanceType = 'default', retainSeconds = 0, endpoint = 'workflow' } = {}) {
  const aiApp = endpoint === 'ai-app';
  // 照平台生成的示例 curl 发：AI 应用的值一律字符串，连数字也是（"1080" 而不是 1080）。
  const nodes = aiApp
    ? nodeInfoList.map((item) => ({ nodeId: item.nodeId, fieldName: item.fieldName, fieldValue: String(item.fieldValue), description: null }))
    : nodeInfoList;
  const extra = {
    instanceType,
    ...(retainSeconds > 0 ? { retainSeconds } : {}),
    // 文档表格写 Boolean，但平台自己生成的示例 curl 是字符串 "false"——跟着实测过的样例走。
    ...(aiApp ? { usePersonalQueue: 'false' } : {}),
  };
  const pathname = aiApp
    ? `/openapi/v2/run/ai-app/${encodeURIComponent(workflowId)}`
    : `/openapi/v2/run/workflow/${encodeURIComponent(workflowId)}`;
  let payload;
  try {
    payload = await call(lease, { path: pathname, json: { nodeInfoList: nodes, ...extra } });
  } catch (err) {
    // AI 应用**不能**退回 V1：/task/openapi/ai-app/run 要 webappId 是 integer，
    // 而 19 位的 appId 超过 Number.MAX_SAFE_INTEGER，转成数字会丢精度、指到另一个应用上。
    if (aiApp) throw err;
    const fallback = err.status === 404 || err.status === 500 || err.code === 'runninghub_412';
    if (!fallback) throw err;
    payload = await call(lease, { path: '/task/openapi/create', json: { apiKey: lease.key, workflowId, nodeInfoList, addMetadata: false, ...extra } });
  }
  const taskId = payload?.taskId || payload?.data?.taskId;
  if (!taskId) throw new HttpError(502, 'bad_upstream_response', `${RUNNINGHUB.label} 没有返回任务 ID`, payload);
  return { taskId: String(taskId), data: payload };
}

// ---------- 查询 ----------
// V2 的 /openapi/v2/query 所有模型、工作流共用一个。返回 {status, results, usage, errorCode, ...}。
// 任务 id 只在它提交的那个站点上有效，所以要整条 Key 记录（带 site），不能只给 Key 字符串。
// 传字符串时按默认站点走（老记录没有 site 字段时的兜底）。
// 注意：任务失败时平台照样回 200，只是 errorCode=805、status=FAILED，所以这里要 tolerateTaskError，
// 否则失败任务会被当成接口错误抛出去，轮询永远停在「进行中」。
export async function queryTask(target, taskId) {
  return call(target, { path: '/openapi/v2/query', json: { taskId: String(taskId) }, timeoutMs: 20000, tolerateTaskError: true });
}

// 状态归一：平台是大写；多认几个别处的写法，页面只认 queued / in_progress / completed / failed。
export function normalizeStatus(status) {
  const text = String(status ?? '').trim().toUpperCase();
  if (text === 'CREATE' || text === 'QUEUED' || text === 'PENDING') return 'queued';
  if (text === 'RUNNING' || text === 'EXECUTING') return 'in_progress';
  if (text === 'SUCCESS' || text === 'SUCCEEDED' || text === 'COMPLETED' || text === 'DONE') return 'completed';
  if (text === 'FAILED' || text === 'FAILURE' || text === 'ERROR' || text === 'CANCELED' || text === 'CANCELLED') return 'failed';
  return '';
}
