// RunningHub 的接口：工作流目录（登记表编译出来的）、提交任务、管理面板看的 Key 状态。
// 和 AutoDL.art 那套的区别：
// 1. 目录不是从平台拉的，是 shared/runninghub.ts 里登记的几个工作流编译出来的；
// 2. 素材要先上传到 RunningHub 换 fileName（AutoDL 是内嵌 data URL 或 TOS 直链）；
// 3. 提交时除了 nodeInfoList 还要带机器档位，而且 Key 是从一组里路由出来的。

import fs from 'node:fs';
import path from 'node:path';
import { HttpError, MIME, readJsonBody, route } from '../http.js';
import { MAX_UPLOAD_BYTES } from '../config.js';
import { localMediaFile } from '../media.js';
import { claim, drop, pick, resolveWorkflowId, resolveWorkflowIds, rhHasKey, rhKeyState, submitWorkflow, uploadMedia } from '../runninghub.js';
import { RH_PROVIDER, RH_SITES, RH_WORKFLOWS, rhCost, rhMachines, rhMedia, rhPlan, rhRules, rhWorkflow, rhUuid } from '../../shared/runninghub.ts';
import { applyTaskState, historyView, newItem } from '../tasks.js';
import { previewState, startPreview, stopPreview } from '../rhpreview.js';
import { holdCredits, syncCredits } from '../credits.js';
import { toCredits } from '../../shared/models.ts';

// 目录：登记表里至少在一个站点上配好了工作流 ID 的那几个。一个都没配的不出现在页面上（在管理面板里能看到为什么）。
function catalog() {
  return RH_WORKFLOWS.map((workflow) => ({ workflow, ids: resolveWorkflowIds(workflow) }))
    .filter(({ ids }) => RH_SITES.some((site) => Boolean(ids[site])))
    .map(({ workflow, ids }) => {
      const estimate = workflow.estimate || {};
      const from = rhCost(workflow.key, {});
      const readySites = RH_SITES.filter((site) => Boolean(ids[site]));
      return {
        uuid: rhUuid(workflow.key),
        name: workflow.name,
        description: workflow.summary,
        cover: workflow.cover || null,
        output: workflow.kind,
        media: rhMedia(workflow),
        rules: rhRules(workflow),
        // 提示词里 @ 引用的写法（<Picture 1> 这种）。画布提交前照着换。
        mentions: workflow.mentions || null,
        machines: rhMachines(workflow).map((machine) => ({ value: machine.value, label: machine.label, note: machine.note })),
        provider: RH_PROVIDER,
        // 价格：按标准档的估价。页面上的「起 N 积分」用它，服务端预扣用同一份估价（rhCost）。
        fromCredits: from == null ? null : toCredits(from),
        billing: { price_type: 'rh_machine', billing_config: { rh_machine: estimate }, price: Math.round((Number(estimate.default) || 0) * 100) },
        // 这个工作流在哪几个站点上能用（用户不选站点：由 Key 池按站点路由）。
        sites: readySites,
        workflowId: ids[readySites[0]],
      };
    });
}

route('GET', /^\/api\/runninghub\/workflows$/, async () => {
  const items = catalog();
  return { hasKey: rhHasKey(), total: items.length, items };
});

// 实时预览：跑着的任务把最近一帧中间结果给前端（base64，现给现用，不落盘）。
// 平台那条 WS 通道是「不推荐、不稳定」的，所以拿不到就是拿不到——
// 这个接口返回 state:'none'，前端照常等轮询结果，不影响出片。
route('GET', /^\/api\/runninghub\/preview\/([^/]+)$/, async ({ params }) => previewState(decodeURIComponent(params[0])) || { state: 'none' });

// 管理面板：有哪些 Key、各自跑到多满、每个工作流配的是哪个 workflowId。只给管理员，Key 只露头尾。
// 「跑到多满」问的是 RunningHub 平台（currentTaskCounts），不是本地计数——同一个 Key 可能还有别人在用。
route('GET', /^\/api\/runninghub\/keys$/, async () => rhKeyState(), 'admin');

// ---------- 素材：页面给的值 → 平台认的 fileName ----------
// 页面传三种值：本机文件（/media/...）、公网链接、data URL。三种都读成 Buffer 再上传。
const DATA_URL = /^data:([\w/+.-]+);base64,(.*)$/s;
const MIME_FOR = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };

async function readMedia(space, value) {
  const url = String(value || '');
  const dataUrl = DATA_URL.exec(url);
  if (dataUrl) {
    const buffer = Buffer.from(dataUrl[2], 'base64');
    if (buffer.length > MAX_UPLOAD_BYTES) throw new HttpError(413, 'payload_too_large', `文件过大，超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`);
    return { buffer, filename: `upload.${(MIME_FOR[dataUrl[1]] || 'bin')}`, contentType: dataUrl[1] };
  }
  if (url.startsWith('/media/')) {
    const file = localMediaFile(space, url);
    const stat = fs.statSync(file);
    if (stat.size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'payload_too_large', `文件过大，超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`);
    const ext = path.extname(file).toLowerCase();
    return { buffer: fs.readFileSync(file), filename: path.basename(file), contentType: MIME[ext] || 'application/octet-stream' };
  }
  if (/^https?:\/\//i.test(url)) {
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok || !res.body) throw new HttpError(400, 'invalid_request', `素材下载失败（${res.status}）：${url.slice(0, 120)}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_UPLOAD_BYTES) throw new HttpError(413, 'payload_too_large', `文件过大，超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`);
    return { buffer, filename: decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || 'remote.bin', contentType: res.headers.get('content-type') || 'application/octet-stream' };
  }
  throw new HttpError(400, 'invalid_request', '素材须为本机文件、公网链接或 data URL');
}

// 提交一个工作流任务。请求体 { workflow: 登记表里的 key, inputs: {规则里的参数}, form }。提交会花钱。
route('POST', /^\/api\/runninghub\/submit$/, async ({ req, space, user }) => {
  const { workflow: key, inputs: raw, form } = await readJsonBody(req);
  if (!key) throw new HttpError(400, 'invalid_request', '请求缺少 workflow');
  // 页面传的是目录里的 uuid（rh:<key>），也接受直接给登记表的 key。
  const workflow = rhWorkflow(String(key).replace(/^rh:/, ''));
  if (!workflow) throw new HttpError(400, 'invalid_request', '这个工作流没有接入');
  // 两个站点各自的工作流 id。至少要有一个站点配好；具体用哪个站点由 pick() 按 Key 的 site 决定。
  const ids = resolveWorkflowIds(workflow);
  if (!RH_SITES.some((site) => Boolean(ids[site]))) {
    throw new HttpError(503, 'workflow_not_configured', `「${workflow.name}」还没配置 RunningHub 工作流 ID，请联系管理员`);
  }
  if (!rhHasKey()) throw new HttpError(503, 'no_api_key', 'RunningHub 暂未开通，请联系管理员');

  const { inputs, problems, nodeInfoList, machine, uploads } = rhPlan(workflow, raw || {});
  if (problems.length) throw new HttpError(400, 'invalid_request', problems[0], { problems });

  // 记录上的提示词、估价、以及提交时的定义快照（之后复现这条记录用）。
  const prompt = String(inputs.prompt || '').trim();
  const estimate = rhCost(workflow.key, inputs);
  const snapshot = { uuid: rhUuid(workflow.key), name: workflow.name, kind: workflow.kind, inputs, rules: rhRules(workflow), provider: RH_PROVIDER };
  const draft = { provider: RH_PROVIDER, kind: workflow.kind, model: workflow.name, prompt, payload: inputs, rh: { key: workflow.key, machine, estimate }, workflow: snapshot };
  holdCredits(user, [draft]);

  let lease = null;
  let taskId;
  let submitted;
  try {
    // 只在「这个站点上配了该工作流 id」的 Key 里挑：两个站点的工作流调不到对方那边。
    lease = await pick(workflow);
    const workflowId = resolveWorkflowId(workflow, lease.site);
    // 素材上传：位置 → fileName。nodeInfoList 里对应的字段换成平台认的文件名。
    // 上传也打到这个 Key 的站点（两个站的素材库不通用）。
    // 值一律用 upload.value：补位补出来的位置（用户只给了 2 张、剩下 7 个 LoadImage 也要有文件）
    // 在 inputs 里是空的，回 inputs 取就会漏传，平台那边直接 Invalid image file。
    // 同一个文件被多个位置复用时只上传一次。
    const names = new Map();
    const sent = new Map();
    for (const upload of uploads) {
      const value = String(upload.value ?? inputs[upload.key] ?? '').trim();
      if (!value) continue;
      let fileName = sent.get(value);
      if (!fileName) {
        const media = await readMedia(space, value);
        ({ fileName } = await uploadMedia(lease, media));
        sent.set(value, fileName);
      }
      names.set(upload.key, fileName);
    }
    const outbound = nodeInfoList.map((item) => {
      const hit = uploads.find((upload) => {
        const slot = uploadSlot(workflow, upload.key);
        return slot && slot.nodeId === item.nodeId && slot.field === item.fieldName;
      });
      return hit && names.has(hit.key) ? { ...item, fieldValue: names.get(hit.key) } : item;
    });
    ({ taskId, data: submitted } = await submitWorkflow(lease, workflowId, outbound, { instanceType: machine }));
    claim(lease, taskId);
  } catch (err) {
    drop(lease);
    syncCredits(space, { ...draft, status: 'failed' });
    throw err;
  }

  // 提交响应里有 netWssUrl / clientId：ComfyUI 的实时预览通道（官方标注「不推荐、不稳定」，
  // 当成锦上添花）。有地址就连上，把中间帧留在内存里给前端低频拉。
  const wsUrl = String(submitted?.netWssUrl || '');
  const wsClient = String(submitted?.clientId || '');
  if (wsUrl) startPreview(taskId, wsUrl, wsClient);

  const item = newItem({
    id: taskId,
    provider: RH_PROVIDER,
    kind: workflow.kind,
    model: workflow.name,
    prompt,
    payload: inputs,
    workflow: snapshot,
    form: form || null,
    // 这条任务占用的是哪个 Key、在哪个站点（还位子时要用；重启后还原占位也靠它）。只存 id，不存 Key 本身。
    rhKeyId: lease.id,
    rhSite: lease.site,
    rh: { key: workflow.key, machine, estimate, site: lease.site },
    // 实时预览通道的地址：记在记录上，服务重启后还能重新连上（任务还在跑才有帧）。
    ...(wsUrl ? { rhPreview: { url: wsUrl, clientId: wsClient } } : {}),
    status: 'queued',
    lastPolledAt: Date.now(),
    ...(draft.credits ? { credits: draft.credits } : {}),
  });
  applyTaskState(item, submitted);
  syncCredits(space, item);
  space.history.unshift(item);
  space.save('history');
  return historyView(item, user, space);
});

// 素材键 → 登记表里的槽位。
function uploadSlot(workflow, key) {
  const image = /^ref_image_(\d+)$/.exec(key);
  if (image) return workflow.images?.[Number(image[1])] || null;
  const video = /^ref_video_(\d+)$/.exec(key);
  if (video) return workflow.videos?.[Number(video[1])] || null;
  const audio = /^ref_audio_(\d+)$/.exec(key);
  if (audio) return workflow.audios?.[Number(audio[1])] || null;
  return null;
}
