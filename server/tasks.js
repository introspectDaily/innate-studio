// 生成记录的一生：建记录、向平台查进度、把结果存到本机。
// 两种来历：视频是平台上的异步任务，要轮询；图片和语音是一次请求直接返回结果（direct），请求在后台跑完再写回记录。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ARK, AUTODL, MINIMAX, RUNNINGHUB, MEDIA_DIRS, POLL_INTERVAL_MS, MAX_PENDING_MS, DOWNLOAD_RETRY_MS, MAX_DOWNLOAD_ATTEMPTS } from './config.js';
import { HttpError } from './http.js';
import { openSpaces } from './store.js';
import { apiKey, autodlToken, minimaxKey } from './keys.js';
import { callArk, callMinimax, ERROR_HINTS } from './ark.js';
import { getResult } from './autodl.js';
import { normalizeStatus as runninghubStatus, queryTask, releaseTask, rhHasKey, rhKeys } from './runninghub.js';
import { rhWorkflow } from '../shared/runninghub.ts';
import { makeThumb } from './thumbs.js';
import { syncCredits } from './credits.js';
import { stopPreview, startPreview } from './rhpreview.js';

const STATUS_ALIASES = {
  queued: 'queued', pending: 'queued', submitted: 'queued', created: 'queued',
  in_progress: 'in_progress', processing: 'in_progress', running: 'in_progress', generating: 'in_progress',
  completed: 'completed', succeeded: 'completed', success: 'completed',
  failed: 'failed', failure: 'failed', error: 'failed', cancelled: 'failed', canceled: 'failed', expired: 'failed',
};

export const VIDEO_TASKS_PATH = '/contents/generations/tasks';
export const MINIMAX_VIDEO_PATH = '/v2/video_generation';

// 视频任务在哪个平台上，就到哪个平台去查。query 返回的东西统一成火山方舟的样子（status、usage、content.video_url、results），applyTaskState 只认这一种。
// MiniMax 的任务包在 task 里，成片地址叫 content.url；它没有完成时间，记的是查到它完成的那一刻（手动填的余额按这个时刻扣，要精确到毫秒）；任务只能查到 7 天以内的。
// AutoDL 的状态是大写的 QUEUED / RUNNING / SUCCESS / FAILED，结果在 results 数组里（可能是视频、音频或图片）；
// 下载结果地址不用带令牌（平台给的是对象存储的地址），只有平台自己域名下才用原样令牌。
const AUTODL_STATUS = { QUEUED: 'queued', RUNNING: 'running', SUCCESS: 'success', FAILED: 'failed' };
// 刚提交的任务第一次查询的间隔。平台上的小任务几秒就完了，等满一轮 6 秒太慢。
const FIRST_POLL_MS = 1500;

const PLATFORMS = {
  ark: {
    ...ARK,
    key: apiKey,
    query: async (id) => (await callArk('GET', `${VIDEO_TASKS_PATH}/${encodeURIComponent(id)}`, { timeoutMs: 20000 })).data,
  },
  minimax: {
    ...MINIMAX,
    key: minimaxKey,
    query: async (id) => {
      const task = (await callMinimax('GET', `/v2/query/video_generation/${encodeURIComponent(id)}`, { timeoutMs: 20000 })).data?.task;
      if (!task) return null;
      return { ...task, content: { video_url: task.content?.url } };
    },
  },
  autodl: {
    ...AUTODL,
    key: autodlToken,
    // 令牌原样放进 Authorization，不加 Bearer（和火山、MiniMax 不一样）。
    authScheme: 'raw',
    query: async (id) => {
      const { status, results, data } = await getResult(id);
      if (status === 'FAILED') {
        const e = data?.error;
        return { status: AUTODL_STATUS.FAILED, error: (typeof e === 'string' ? e : e?.message) || data?.message || data?.msg || '任务执行失败' };
      }
      return { status: AUTODL_STATUS[status], ...(results.length ? { results } : {}) };
    },
  },
  // RunningHub：一整套 Key，提交时路由到具体某一个，查询也得用同一个（任务是挂在 Key 的账号下的）。
  // 任务结束（成功或失败）时还要把那个 Key 的并发位子还给别人。
  runninghub: {
    ...RUNNINGHUB,
    key: () => (rhHasKey() ? 'runninghub' : ''),
    query: async (id, item) => {
      // 查询要回到提交时那个站点：两个站的任务 id 互不相通，请求打到对方会报「任务不存在」。
      // 所以传给 queryTask 的是整条 Key 记录（带 site），不是 Key 字符串。
      // 提交用的 Key 已经从配置文件里拿掉时，优先找同一站点的其他 Key（同一账号下多发的 Key 也能查到），
      // 最后才退回第一个（老记录没有 rhSite 字段，只能这么兜）。
      const keys = rhKeys();
      const key = keys.find((entry) => entry.id === item.rhKeyId) || (item.rhSite ? keys.find((entry) => entry.site === item.rhSite) : null) || keys[0];
      if (!key) throw new HttpError(404, 'no_api_key', 'RunningHub 的 Key 都配置没了');
      const payload = await queryTask(key, id);
      const status = runninghubStatus(payload?.status);
      // 平台可能一次返回好几个文件（成片 + 一次采样的片段）。登记表里写明了成片在哪个节点，
      // 把它排到前面：主文件、播放器都用第一个。
      const primary = new Set(rhWorkflow(item.rh?.key)?.outputNodes || []);
      const results = (Array.isArray(payload?.results) ? payload.results : [])
        .map((result) => {
          const ext = String(result?.outputType || result?.fileType || '').toLowerCase().replace(/^\./, '');
          const type = RH_FILE_KINDS[ext] || '';
          return { url: result?.url || result?.fileUrl, nodeId: result?.nodeId ? String(result.nodeId) : '', ...(ext && { file_type: ext }), ...(type && { type }) };
        })
        .filter((result) => result.url && result.type)
        .sort((a, b) => (primary.has(b.nodeId) ? 1 : 0) - (primary.has(a.nodeId) ? 1 : 0));
      if (status === 'failed') {
        // 平台把失败原因放在 failedReason 里：异常类型、死在哪个节点、还有一段可读的建议。
        // 最常见的是显存爆了（OOM），这个要单独翻译给用户，不然只看到「工作流运行失败」没法处理。
        const reason = payload?.failedReason || {};
        const type = String(reason.exception_type || '');
        const node = reason.node_name ? `${reason.node_id || '?'} ${reason.node_name}` : '';
        const advice = String(reason.exception_message || payload?.errorMessage || '').trim();
        const code = /outofmemory/i.test(type) || /VRAM OOM/i.test(advice) ? 'vram_oom' : '';
        const raw = [type && `异常类型：${type}`, node && `失败节点：${node}`, advice].filter(Boolean).join('\n');
        return { status: 'failed', results, error: { message: raw || '任务执行失败', code } };
      }
      return { status: status || 'in_progress', ...(results.length ? { results } : {}), ...(payload?.usage ? { usage: payload.usage } : {}) };
    },
    // 任务到终态了：把占着的并发位子还回去。
    settle: (item) => releaseTask(item.rhKeyId, item.id),
  },
};

// RunningHub 给的输出类型（outputType）是扩展名，换成我们这边的三种。
const RH_FILE_KINDS = { mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', mp3: 'audio', wav: 'audio', flac: 'audio' };

export const isPending = (item) => item.status === 'queued' || item.status === 'in_progress';
export const isTimedOut = (item) => item.status === 'failed' && item.error?.code === 'poll_timeout';
// 以前在别的平台（Flatkey、OpenRouter）上提交的记录。那些平台已经从应用里拿掉了，记录留着看，但不再查询。
export const isLegacy = (item) => !Object.hasOwn(PLATFORMS, item.provider);

export const newId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;

export function newItem(fields) {
  return { provider: 'ark', createdAt: Date.now(), status: 'in_progress', progress: 0, error: null, usage: null, remoteUrl: null, localFile: null, ...fields };
}

export function applyTaskState(item, data) {
  if (!data) return;
  // 认得的状态，或者一组结果文件（AutoDL 成功时只有 results）。两样都没有就什么都不改。
  if (!STATUS_ALIASES[String(data.status || '').toLowerCase()] && !Array.isArray(data.results)) return;
  const status = STATUS_ALIASES[String(data.status || '').toLowerCase()];
  if (status) item.status = status;
  if (typeof data.progress === 'number') item.progress = data.progress;
  if (data.usage) item.usage = data.usage;
  if (data.completed_at) item.completedAt = data.completed_at * 1000;
  if (data.content?.video_url) item.remoteUrl = data.content.video_url;
  // AutoDL 的结果是一组文件，按顺序记下来，第一份当主文件（卡片、播放器用它），其余在详情里也能下载。
  if (Array.isArray(data.results) && data.results.length) item.results = data.results.filter((result) => result?.url);
  if (item.results?.length && !item.remoteUrl) item.remoteUrl = item.results[0].url;
  if (item.status === 'completed') {
    item.progress = 100;
    item.error = null;
    if (!item.completedAt) item.completedAt = Date.now();
  }
  if (item.status === 'failed') {
    const e = data.error;
    const raw = (typeof e === 'string' ? e : e?.message) || '';
    const code = (typeof e === 'object' && e?.code) || '';
    // 平台给的失败原因是英文的：卡片上显示中文的原因，原话留在 detail 里。
    const known = ERROR_HINTS[code] || (/audit|sensitive|moderation|censor/i.test(raw) ? '内容未通过审核，请修改提示词或参考素材后重试' : '');
    item.error = { message: known || '生成失败，请稍后重试', code, ...(raw && { detail: `${PLATFORMS[item.provider]?.label || '平台'}${code ? `（${code}）` : ''}：${raw}` }) };
  }
}

const polling = new Set();
const downloading = new Set();

export async function pollTask(space, item) {
  if (polling.has(item.id)) return;
  polling.add(item.id);
  try {
    applyTaskState(item, await PLATFORMS[item.provider].query(item.id, item));
    item.pollError = null;
  } catch (err) {
    if (err.status === 404 || err.code === 'task_not_exist') {
      item.status = 'failed';
      item.error = { message: `${PLATFORMS[item.provider].label} 上不存在该任务`, code: 'task_not_found' };
    } else {
      item.pollError = err.message;
    }
  } finally {
    item.lastPolledAt = Date.now();
    item.polls = (item.polls || 0) + 1;
    // 先查再判断：服务停了很久再启动时，任务可能早就完成了。查过这一次仍没有结果才算超时。
    if (isPending(item) && Date.now() - item.createdAt > MAX_PENDING_MS) {
      item.status = 'failed';
      item.error = { message: '查询超时，请稍后重新查询。', code: 'poll_timeout' };
    }
    // 到终态了：平台占用的东西（RunningHub 的并发位子）该还回去了。
    if (!isPending(item)) {
      PLATFORMS[item.provider].settle?.(item);
      // 实时预览的 WS 也到点就断：任务不会再有新的中间帧了。
      stopPreview(item.id);
    }
    polling.delete(item.id);
    // AutoDL 的结果里有平台给的时长，按秒计费时拿它对账。
    syncCredits(space, item, { seconds: Number(item.results?.[0]?.duration) || 0 });
    space.save('history');
  }
  if (item.status === 'completed') downloadResult(space, item);
}

// 存到本机用的扩展名。平台给了 file_type（mp4、wav…）就用它；没给就按记录的类型猜。
const KNOWN_EXTS = new Set(['mp4', 'mov', 'webm', 'jpg', 'jpeg', 'png', 'webp', 'mp3', 'wav']);
function resultExt(item) {
  const given = String(item.results?.[0]?.file_type || '').toLowerCase().replace(/^\./, '');
  if (KNOWN_EXTS.has(given)) return given;
  if (item.kind === 'audio') return 'mp3';
  if (item.kind === 'image') return 'png';
  return 'mp4';
}

// 下载的结果不是音频、视频、图片时（多半是一段错误说明）不算下载成功。
const DOWNLOAD_REJECT = /^(application\/json|text\/)/i;

// 结果地址拼成绝对地址。
// 平台的域名可能留空（RunningHub 就是：结果放在对象存储上，不是 runninghub 自己的域名），
// 这时候地址本身就是完整的绝对地址，直接用它——拿空串当基准会抛 Invalid URL，
// 结果就是任务在平台上跑完了、文件却一个都下不下来。
export function absUrl(url, platform) {
  const base = String(platform?.baseUrl || '');
  return base ? new URL(url, base) : new URL(url);
}

// 下载一个结果地址到 tmp。只有平台自己的域名下才带上令牌，避免把令牌发给别的主机。
async function fetchInto(url, tmp, platform) {
  const base = String(platform.baseUrl || '');
  const target = absUrl(url, platform);
  const headers = {};
  if (base && target.origin === new URL(base).origin && platform.key()) {
    headers.Authorization = platform.authScheme === 'raw' ? platform.key() : `Bearer ${platform.key()}`;
  }
  const res = await fetch(target, { headers, signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!res.ok || !res.body) throw new Error(`下载返回 ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (DOWNLOAD_REJECT.test(type)) throw new Error(`下载的文件不是媒体（${type}）`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  const { size } = fs.statSync(tmp);
  if (!size) throw new Error('下载的文件为空');
  return size;
}

// 任务完成后把结果存到本机，历史记录不依赖远端地址是否还有效（AutoDL 的文档也写明结果地址很快过期）。
// 平台给了一组结果（AutoDL）就逐个存：第一份是主文件，记在 item.localFile 里；多给的几份放在 item.extraFiles，删记录时一起删。
export async function downloadResult(space, item) {
  if (!item.remoteUrl || item.localFile || downloading.has(item.id)) return;
  if ((item.downloadAttempts || 0) >= MAX_DOWNLOAD_ATTEMPTS) return;
  const platform = PLATFORMS[item.provider] || PLATFORMS.ark;
  downloading.add(item.id);
  item.downloadAttempts = (item.downloadAttempts || 0) + 1;
  item.lastDownloadAt = Date.now();
  try {
    const results = (item.results || []).filter((result) => result?.url);
    if (results.length) await saveResults(space, item, platform, results);
    else await saveSingle(space, item, platform);
  } catch (err) {
    item.downloadError = err.message;
  } finally {
    downloading.delete(item.id);
    space.save('history');
  }
}

async function saveSingle(space, item, platform) {
  const file = `${item.id.replace(/[^\w.-]/g, '_')}.${resultExt(item)}`;
  const dir = space.resultDir(item);
  const tmp = path.join(dir, `${file}.part`);
  try {
    const size = await fetchInto(item.remoteUrl, tmp, platform);
    fs.renameSync(tmp, path.join(dir, file));
    Object.assign(item, { localFile: file, fileSize: size, downloadError: null });
    makeThumb(space, item);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

async function saveResults(space, item, platform, results) {
  // 按结果类型定这条记录是哪一种，文件存进对应的目录（以后不会再变）。
  const type = results[0]?.type;
  if (type === 'image' || type === 'video' || type === 'audio') item.kind = type;
  const dir = space.resultDir(item);
  const base = item.id.replace(/[^\w.-]/g, '_');
  const saved = [];
  let failure = '';
  for (const [index, result] of results.entries()) {
    const ext = resultExt({ ...item, results: [result] });
    const file = `${base}${index ? `_${index + 1}` : ''}.${ext}`;
    const tmp = path.join(dir, `${file}.part`);
    try {
      const size = await fetchInto(result.url, tmp, platform);
      fs.renameSync(tmp, path.join(dir, file));
      saved.push({ file, size });
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      failure = err.message;
    }
  }
  if (!saved.length) throw new Error(failure || '没有下载到结果文件');
  const [first, ...rest] = saved;
  Object.assign(item, { localFile: first.file, fileSize: first.size, extraFiles: rest, downloadError: saved.length < results.length ? failure || '部分文件下载失败' : null });
  makeThumb(space, item);
}

function tick() {
  const now = Date.now();
  for (const space of openSpaces()) {
    for (const item of space.history) {
      // direct 的记录没有任务可查，结果由发起它的那次请求自己写回来。
      // 这个平台的 Key 被清掉了就先不查。
      if (item.direct || isLegacy(item) || !PLATFORMS[item.provider].key()) continue;
      if (isPending(item)) {
        // 刚提交的任务先快点查一次（很多任务几秒就完了，不该让用户先等满一轮）。
        const every = item.polls ? POLL_INTERVAL_MS : FIRST_POLL_MS;
        if (now - (item.lastPolledAt || 0) >= every) pollTask(space, item);
      } else if (item.status === 'completed' && !item.localFile && item.remoteUrl) {
        if (now - (item.lastDownloadAt || 0) >= DOWNLOAD_RETRY_MS) downloadResult(space, item);
      }
    }
  }
}

export function startPolling() {
  setInterval(tick, 2000);
  tick();
}

// mediaUrl 是结果文件的地址，三种类型都有；videoUrl 只有视频有，页面上放视频的地方用它；thumbUrl 是列表里用的小图，没做出来就没有。
// user 是来看的人。多人模式下平台的原话（error.detail、状态查询失败的原因）只给管理员看，成员只看中文的原因。
export function historyView(item, user, space) {
  const kind = item.kind || 'video';
  const mediaUrl = item.localFile ? `/media/${MEDIA_DIRS[kind]}/${item.localFile}` : item.remoteUrl || null;
  const hidden = user && user.role !== 'admin';
  // 本地优先的最大好处：Agent 在同一台机器上能直接读文件。结果落盘了就给出绝对路径。
  const localPath = space && item.localFile ? path.join(space.resultDir(item), item.localFile) : null;
  return {
    ...item,
    ...(hidden && item.error?.detail && { error: { message: item.error.message, code: item.error.code } }),
    ...(hidden && item.pollError && { pollError: '平台暂时无法查询' }),
    kind,
    mediaUrl,
    videoUrl: kind === 'video' ? mediaUrl : null,
    thumbUrl: item.thumbFile ? `/media/thumbs/${item.thumbFile}` : null,
    localPath,
    savedLocally: Boolean(item.localFile),
  };
}

export function finishItem(space, item, buffer, ext, extra = {}) {
  // 等结果的这段时间里，记录可能已经被用户删掉了，那就不再落盘。
  if (!space.history.includes(item)) return;
  const file = `${item.id}.${ext}`;
  fs.writeFileSync(path.join(space.resultDir(item), file), buffer);
  Object.assign(item, { status: 'completed', progress: 100, completedAt: Date.now(), localFile: file, fileSize: buffer.length, ...extra });
  makeThumb(space, item);
}

// 图片和语音是一次请求直接返回结果，平台上没有任务可查。
// 所以先建记录、立刻返回给页面，请求在后台跑；跑完把文件存到本机，再把结果写回记录。
export function runDirect(space, items, work) {
  for (const item of [...items].reverse()) {
    item.direct = true;
    space.history.unshift(item);
  }
  space.save('history');
  work()
    .catch((err) => {
      if (!(err instanceof HttpError)) console.error(err);
      for (const item of items) {
        if (item.status === 'completed') continue;
        item.status = 'failed';
        item.error = { message: err instanceof HttpError ? err.message : `本地服务出错：${err.message}`, code: err.code || '', ...(err.detail && { detail: err.detail }) };
      }
    })
    .finally(() => {
      for (const item of items) syncCredits(space, item);
      space.save('history');
    });
}

// 打开一份空间时把上次留下的记录理一遍：
// 已经拿掉的平台上没跑完的没法再查，结果没存到本机的也下不回来；
// direct 的请求跟着进程走，服务重启后没法接着等，上次没跑完的直接标为中断。
export function settleHistory(space) {
  let changed = false;
  for (const item of space.history) {
    if (!isPending(item)) continue;
    if (item.direct) item.error = { message: '生成已中断，请重新生成。', code: 'interrupted' };
    else if (isLegacy(item)) item.error = { message: '该平台已停用，无法查询该任务。', code: 'provider_removed' };
    else continue;
    item.status = 'failed';
    syncCredits(space, item);
    changed = true;
  }
  if (changed) space.save('history');
}

// 服务重启后接着跑。
// 记录是写在盘上的，平台上那些任务照旧在跑——所以关掉再开，应该像没关过一样：
// 还在跑的继续查状态，跑完了但文件没存下来的再存一次。
// 返回接上了几个任务（给启动日志报个数）。
export function resumePending(space) {
  let changed = false;
  let resumed = 0;
  for (const item of space.history) {
    if (isPending(item)) {
      resumed += 1;
      // lastPolledAt 是旧的，轮询循环的第一个 tick 就会去查，不用特别处理。
      // RunningHub 的实时预览：地址记在记录上，重启后重新连上，任务还在跑就有中间帧。
      if (item.provider === 'runninghub' && item.rhPreview?.url) {
        startPreview(item.id, item.rhPreview.url, item.rhPreview.clientId);
      }
      continue;
    }
    // 平台上跑完了、本机却没存下文件：上次可能是服务关着，也可能是地址/网络的问题。
    // 重启就是一次新的机会，把次数放开重来一遍（不然它会一直卡在「保存失败」）。
    if (item.status === 'completed' && !item.localFile && item.remoteUrl && (item.downloadAttempts || 0) >= MAX_DOWNLOAD_ATTEMPTS) {
      item.downloadAttempts = 0;
      changed = true;
    }
  }
  if (changed) space.save('history');
  return resumed;
}
