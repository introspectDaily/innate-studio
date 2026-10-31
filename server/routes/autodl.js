// AutoDL.art 的接口：工作流目录、单个工作流的定义、提交任务。
// 和其他平台不一样的地方：工作流的参数是平台在线给出的（input_rules），所以这里不登记表单，
// 目录和规则都实时从平台取，按规则的形状校验参数；提交的请求体就是这组参数本身。
// 素材的处理：本机的图片、音频内嵌成 data URL 直接放进请求（太大的先传到 TOS 换成公网直链）；视频太大，一律走 TOS。

import fs from 'node:fs';
import path from 'node:path';
import { HttpError, MIME, readJsonBody, route } from '../http.js';
import { localMediaFile } from '../media.js';
import { publishLocalMedia } from '../publishing.js';
import { listWorkflows, getWorkflow, submitWorkflow } from '../autodl.js';
import { applyTaskState, historyView, newItem } from '../tasks.js';
import { holdCredits, syncCredits } from '../credits.js';
import { autodlToken } from '../keys.js';
import { cleanInputs, formValues, mediaAccepts, requiredMedia, workflowCost } from '../../shared/autodl.ts';
import { toCredits } from '../../shared/models.ts';

// 工作流目录缓存这么久。平台上新工作流、改规则都能在一分钟内看到，又不用每开一次页面就整个取一遍。
// 只缓存在进程里，不落盘。
const CATALOG_TTL_MS = 60 * 1000;
let catalog = { at: 0, value: null };

// 列表接口不带 input_rules（线上核对过），起价和必填素材要从详情里算。一次取四条，失败的那条按没有规则算，
// 不让一个工作流出错拖住整个目录。
const DETAIL_CONCURRENCY = 4;
async function withRules(workflows) {
  const pending = workflows.filter((workflow) => workflow?.uuid && !workflow.input_rules);
  for (let i = 0; i < pending.length; i += DETAIL_CONCURRENCY) {
    await Promise.all(
      pending.slice(i, i + DETAIL_CONCURRENCY).map(async (workflow) => {
        try {
          const detail = await getWorkflow(workflow.uuid);
          Object.assign(workflow, { input_rules: detail.input_rules, input_example: detail.input_example, output_example: detail.output_example, billing_config: detail.billing_config ?? workflow.billing_config, description: workflow.description || detail.description || '', cover_image_url: workflow.cover_image_url || detail.cover_image_url || null });
        } catch {
          /* 取不到详情就不算起价 */
        }
      }),
    );
  }
  return workflows;
}

async function catalogValue() {
  if (catalog.value && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.value;
  const { total, workflows } = await listWorkflows();
  await withRules(workflows);
  const items = workflows
    .filter((workflow) => workflow?.uuid)
    .map((workflow) => {
      // 起价：按表单初始值估一份。按秒计费的时长这时还不知道，起价里只含最低价。
      const from = workflowCost(workflow, formValues(workflow), 0);
      return {
        uuid: workflow.uuid,
        name: workflow.name || workflow.uuid,
        description: workflow.description || '',
        cover: workflow.cover_image_url || null,
        priceType: workflow.price_type || '',
        // 出什么类型的文件（video、audio、image）：画布上按节点类型列可用工作流时用。
        output: outputKind(workflow),
        // 计费配置：页面（画布节点的预估花费）用同一套规则算。
        billing: { price_type: workflow.price_type || '', billing_config: workflow.billing_config || {}, price: workflow.price ?? 0 },
        // 规则也带上：页面选中工作流后直接画表单，不用再取一次详情（提交前服务端仍会现取一份来校验）。
        rules: workflow.input_rules || {},
        // 这个工作流必须传的素材类型（image、video、audio），挑选列表里用来分类。
        media: requiredMedia(workflow.input_rules),
        fromCredits: from == null ? null : toCredits(from),
        usage: Number(workflow.usage_count_7d) || 0,
      };
    })
    .sort((a, b) => b.usage - a.usage);
  const value = { total, items };
  catalog = { at: Date.now(), value };
  return value;
}

route('GET', /^\/api\/autodl\/workflows$/, async () => {
  // 没有令牌时不去请求平台，页面据此显示去设置里填令牌的提示。
  if (!autodlToken()) return { hasKey: false, total: 0, items: [] };
  return { hasKey: true, ...(await catalogValue()) };
});

// 单个工作流的完整定义：input_rules、示例、计费配置。提交前总是现取，不用缓存。
route('GET', /^\/api\/autodl\/workflows\/([^/]+)$/, async ({ params }) => {
  if (!autodlToken()) throw new HttpError(503, 'no_api_key', 'AutoDL.art 暂未开通，请联系管理员');
  return { workflow: await getWorkflow(decodeURIComponent(params[0])) };
});
// 从输出示例看这次要出什么类型的文件（results[0].type / file_type），认不出来按规则里的字段名猜。
// 记下来是为了建记录时就知道结果该存到哪个目录；下载完还会按平台给的 type 纠正一次。
const FILE_KINDS = { wav: 'audio', mp3: 'audio', flac: 'audio', ogg: 'audio', m4a: 'audio', mp4: 'video', mov: 'video', webm: 'video', png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image' };

export function outputKind(workflow) {
  try {
    const example = JSON.parse(workflow.output_example || '{}');
    const result = (example?.data?.results || [])[0] || {};
    const byType = ['audio', 'video', 'image'].find((type) => result.type === type);
    if (byType) return byType;
    const byExt = FILE_KINDS[String(result.file_type || '').toLowerCase()];
    if (byExt) return byExt;
  } catch {
    /* 示例不是 JSON 就看规则的字段名 */
  }
  const keys = Object.keys(workflow.input_rules || {}).join(' ');
  if (/audio|tts|speech|voice|wav/i.test(`${workflow.uuid} ${workflow.name || ''} ${keys}`)) return 'audio';
  if (/image|cover|illustration/i.test(`${workflow.uuid} ${keys}`)) return 'image';
  return 'video';
}

// 内嵌的上限：超过这个大小的文件改成传到 TOS 换公网直链，免得请求体大得离谱。图片一般远小于它。
const INLINE_MAX_BYTES = 5 * 1024 * 1024;

// 页面传来的媒体值：本机文件的短地址（/media/...）、https 链接、data URL、纯 base64 都收。
// 本机文件按工作流认的类型检查格式，再内嵌成 data URL；视频和过大的文件传上 TOS，换成公网直链。
async function publicMedia(space, rule, value) {
  const url = String(value || '');
  if (!url.startsWith('/media/')) return url;
  const file = localMediaFile(space, url);
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || '';
  if (rule.type !== 'video' && !type) throw new HttpError(400, 'invalid_request', `不支持的文件格式：${ext}`);
  const accepts = mediaAccepts(rule);
  if (type && accepts.length && !accepts.includes(type)) throw new HttpError(400, 'invalid_request', `这个工作流不收 ${ext.slice(1)} 文件，可用的类型：${accepts.join('、')}`);
  if (rule.type === 'video' || fs.statSync(file).size > INLINE_MAX_BYTES) return (await publishLocalMedia(space, url)).url;
  return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
}

// 提交一个工作流任务。请求体 { workflow: uuid, inputs: {规则里的参数} }。提交会花钱。
route('POST', /^\/api\/autodl\/submit$/, async ({ req, space, user }) => {
  // 没配令牌就不用往下走；成员看不到「去配令牌」这种管理说法，只得到服务不可用的原因。
  if (!autodlToken()) throw new HttpError(503, 'no_api_key', 'AutoDL.art 暂未开通，请联系管理员');
  const { workflow: id, inputs: raw, form } = await readJsonBody(req);
  if (!id) throw new HttpError(400, 'invalid_request', '请求缺少 workflow');
  const workflow = await getWorkflow(String(id));
  const { inputs, problems } = cleanInputs(workflow.input_rules, raw || {});
  if (problems.length) throw new HttpError(400, 'invalid_request', problems[0], { problems });

  // 记录上的提示词：规则里第一段填了的文字。
  const prompt = Object.entries(workflow.input_rules || {})
    .filter(([, rule]) => rule.type === 'string' || rule.type === 'prompt')
    .map(([key]) => (typeof inputs[key] === 'string' ? inputs[key].trim() : ''))
    .find(Boolean) || '';

  // 记下提交时的定义：计费配置、提交的这组参数。之后平台调价、下架，这条记录都按当时的价对账。
  const snapshot = {
    uuid: workflow.uuid,
    name: workflow.name || workflow.uuid,
    kind: outputKind(workflow),
    billing: { price_type: workflow.price_type || '', billing_config: workflow.billing_config || {}, price: workflow.price ?? 0 },
    inputs,
    // 规则也记一份：复用这条记录时把输入框恢复成当时的样子，平台之后改了规则也不影响这一条。
    rules: workflow.input_rules || {},
  };
  const draft = { provider: 'autodl', kind: snapshot.kind, model: snapshot.name, prompt, payload: inputs, workflow: snapshot };
  holdCredits(user, [draft]);

  // 要发的参数：媒体换成本机文件的内容或公网直链。记录里存的仍是页面给的短地址和数据。
  const outbound = { ...inputs };
  let taskId;
  let submitted;
  try {
    for (const [key, rule] of Object.entries(workflow.input_rules || {})) {
      if (rule.type !== 'image' && rule.type !== 'video' && rule.type !== 'audio') continue;
      if (typeof inputs[key] === 'string' && inputs[key]) outbound[key] = await publicMedia(space, rule, inputs[key]);
    }
    ({ taskId, data: submitted } = await submitWorkflow(workflow.uuid, outbound));
  } catch (err) {
    syncCredits(space, { ...draft, status: 'failed' });
    throw err;
  }

  const item = newItem({
    id: taskId,
    provider: 'autodl',
    kind: snapshot.kind,
    model: snapshot.name,
    prompt,
    payload: inputs,
    workflow: snapshot,
    form: form || null,
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
