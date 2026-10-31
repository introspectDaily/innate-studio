// 让一个节点生成：把连进来的文本和素材收齐，拼成和创作页一样的请求，交给本地服务。
// 结果是一条普通的生成记录，节点只记它的 id，进度跟着「创作记录」的轮询走。

import type { Edge, Node, ReactFlowInstance } from '@xyflow/react';
import { api, state, KINDS, startHistoryLoop, loadHistory, polishModel, canManage, usesCredits, flowModelsOf, flowSummary, flowReady, canvasPlace } from '../store.ts';
import { fmtCredits, fmtYuan } from '../format.ts';
import { quoteCost, toCredits } from '../../../shared/models.ts';
import { durationOf, flowInputs, isFlowModel, workflowCost, type FlowMedia } from '../../../shared/autodl.ts';
import { defaults, fitImageQuality, fitImageSize, hasLastFrame, imageRefLimit, specOf } from '../composer/state.ts';
import { buildVideoRequest, buildImageRequest, buildSpeechRequest, buildSfxRequest } from '../request.ts';
import { recordName } from '../media.ts';
import { confirmDialog, toast } from '../ui/layers.tsx';
import type { HistoryItem, Kind, Ref } from '../types.ts';
import { BOX_HEIGHT, NODE_LABELS, TITLE_ROOM, joinPrompt, keepBefore, nodeWidth, numbered, placeResults, resolveMentions, runOrder, stripNodeData, videoFormFrom, type AudioData, type ImageData, type LinkData, type MediaInput, type NodeKind, type TextData, type VideoData } from './model.ts';

type Flow = ReactFlowInstance<Node, Edge>;
type AnyData = Partial<ImageData & VideoData & AudioData & TextData>;

export const recordOf = (data: { recordId?: string }): HistoryItem | undefined => (data.recordId ? state.history.find((h) => h.id === data.recordId) : undefined);

// 一个节点现在能交给下游的东西：本机的一个文件。还没生成完、或者文件不在本机，就是 null。
export function outputOf(node: Node): { url: string; kind: Kind; name: string } | null {
  const data = node.data as AnyData;
  if (data.upload) return { url: data.upload.url, kind: node.type as Kind, name: data.upload.name };
  const record = recordOf(data);
  if (!record || record.status !== 'completed' || !record.mediaUrl || !record.savedLocally) return null;
  return { url: record.mediaUrl, kind: record.kind, name: recordName(record) };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// 拼视频节点的请求。forQuote：只是为了估价，上游还没生成的素材先用一个占位顶上（批量生成时下游要等上游出结果），只要知道有几份就行。
function videoRequest(node: Node, sources: { link: LinkData; node: Node }[], prompt: string, forQuote = false) {
  const data = node.data as unknown as VideoData;
  const media = sources.filter((s) => s.link.kind !== 'text');
  const counts: Record<Kind, number> = { image: 0, video: 0, audio: 0 };
  const inputs: MediaInput[] = [];

  // 如果节点挂载了本片尾帧作为续写首帧，且没有外部图片首帧连入：
  if (data.selfFrame && !sources.some((s) => s.link.kind === 'image')) {
    inputs.push({ kind: 'image', role: 'first', ref: { uid: crypto.randomUUID(), kind: 'image', source: 'local', url: data.selfFrame.url, name: data.selfFrame.name, thumb: null } });
    counts.image++;
  } else if (data.selfRole === 'reference' && !sources.some((s) => s.link.kind === 'video')) {
    const selfOutput = outputOf(node);
    if (selfOutput) {
      inputs.push({ kind: 'video', role: 'reference', ref: { uid: crypto.randomUUID(), kind: 'video', source: 'local', url: selfOutput.url, name: selfOutput.name, thumb: null } });
      counts.video++;
    }
  }

  for (const { link, node: source } of media) {
    const kind = link.kind as Kind;
    const output = outputOf(source) || (forQuote ? { url: '', name: '' } : null);
    if (!output) throw new Error(`上游${NODE_LABELS[kind]}节点尚未生成`);
    if (++counts[kind] > KINDS[kind].max) throw new Error(`参考${NODE_LABELS[kind]}最多 ${KINDS[kind].max} 个`);
    const role = kind === 'image' ? link.role || 'reference' : 'reference';
    if (role === 'last' && !hasLastFrame(data.model)) throw new Error(`${data.model} 不支持尾帧`);
    inputs.push({ kind, role, ref: { uid: crypto.randomUUID(), kind, source: 'local', url: output.url, name: output.name, thumb: null } });
  }
  const { form, problems } = videoFormFrom(defaults(), data, prompt, inputs);
  const request = buildVideoRequest(form, specOf(data.model));
  const problem = problems[0] || request.problems[0];
  if (problem && !forQuote) throw new Error(problem);
  return { form, payload: request.payload };
}

// 选的是工作流（哪种节点都可能选）：按它的规则拼入参，提交到 AutoDL.art 的那条接口。
async function submitFlow(node: Node, sources: { link: LinkData; node: Node }[], prompt: string, say: (text: string) => void) {
  const { flow, inputs, form } = flowRequest(sources, node, prompt);
  say('正在提交');
  return (await api<HistoryItem>('POST', '/api/autodl/submit', { workflow: flow.uuid, inputs, form: { ...form, ...FROM_CANVAS } })).id;
}

async function submitVideo(node: Node, sources: { link: LinkData; node: Node }[], prompt: string, say: (text: string) => void) {
  const { form, payload } = videoRequest(node, sources, prompt);
  say('正在提交');
  return (await api<HistoryItem>('POST', '/api/videos', { payload, form: { ...form, ...FROM_CANVAS } })).id;
}

// 工作流当模型用：把节点里的提示词、连进来的素材和节点上选的参数，按工作流的 input_rules 拼成入参。
// forQuote 只是为了估价：上游还没生成的素材先用空地址顶上，只要知道填了哪些字段。
function flowRequest(sources: { link: LinkData; node: Node }[], node: Node, prompt: string, forQuote = false) {
  const data = node.data as unknown as { model: string; resolution?: string; duration?: number; flowValues?: Record<string, unknown> };
  const flow = flowSummary(data.model);
  if (!flow?.rules) throw new Error('这个工作流已经不在目录里，请重新选一个');
  const media: FlowMedia[] = [];
  for (const source of sources.filter((s) => s.link.kind !== 'text')) {
    const kind = source.link.kind as Kind;
    const output = outputOf(source.node) || (forQuote ? { url: '', name: '' } : null);
    if (!output) throw new Error(`上游${NODE_LABELS[kind]}节点尚未生成`);
    media.push({ kind, url: output.url, name: output.name, role: source.link.role });
  }
  // 视频的分辨率、时长是节点上直接选的；图片、音频的分辨率和其他参数一样放在「参数」里（flowValues）。
  const isVideo = node.type === 'video';
  const { inputs, problems, placed } = flowInputs(flow.rules, { prompt, media, resolution: isVideo ? data.resolution : String(data.flowValues?.resolution ?? ''), duration: isVideo ? data.duration : undefined, extra: data.flowValues });
  if (problems.length && !forQuote) throw new Error(problems[0]);
  // 记录里的素材快照：以后复现这条记录时，输入框里的格子能按当时的样子恢复。
  const refs: Record<string, Ref> = {};
  for (const { key, media: item } of placed) {
    refs[key] = { uid: crypto.randomUUID(), kind: item.kind, source: 'local', url: item.url, name: item.name || '', thumb: null };
  }
  return { flow, inputs, form: { type: 'flow' as const, workflow: flow, values: inputs, refs } };
}

// 画布上提交的记录带着这个记号：创作页的「最近生成」不列它们，记录页里切到「画布」才看。
const FROM_CANVAS = { from: 'canvas' };

function imageRequest(node: Node, sources: { link: LinkData; node: Node }[], prompt: string, given?: { url: string; name: string }[], forQuote = false) {
  const data = node.data as unknown as ImageData;
  const selfOutput = outputOf(node);
  const hasWireImages = sources.some((s) => s.link.kind === 'image');
  const limit = imageRefLimit(data.model);
  const usesSelfRef = Boolean(!hasWireImages && selfOutput?.kind === 'image' && limit > 0 && !(data as { ignoreSelfRef?: boolean }).ignoreSelfRef);

  // 连进来的图片是参考图（图生图）。given 是这一次临时指定的参考图（扩图的底图），有它就不看连线。
  let refs: Ref[] = [];
  if (given) {
    refs = given.map((item) => ({ uid: crypto.randomUUID(), kind: 'image' as const, source: 'local' as const, url: item.url, name: item.name, thumb: null }));
  } else if (hasWireImages) {
    refs = sources
      .filter((s) => s.link.kind === 'image')
      .map((s) => {
        const output = outputOf(s.node) || (forQuote ? { url: '', name: '' } : null);
        if (!output) throw new Error('上游图片节点尚未生成');
        return { uid: crypto.randomUUID(), kind: 'image' as const, source: 'local' as const, url: output.url, name: output.name, thumb: null };
      });
  } else if (usesSelfRef && selfOutput) {
    refs = [{ uid: crypto.randomUUID(), kind: 'image' as const, source: 'local' as const, url: selfOutput.url, name: selfOutput.name, thumb: null }];
  }

  const trimmed = limit > 0 && refs.length > limit;
  if (trimmed) refs = refs.slice(0, limit);

  const form = { prompt, model: data.model, ratio: data.ratio, resolution: fitImageSize(data.model, data.resolution), quality: fitImageQuality(data.model, data.quality), count: data.count || 1, refs };
  const request = buildImageRequest(form, limit);
  if (request.problems.length && !forQuote) throw new Error(request.problems[0]);
  return { form, payload: request.payload, trimmed: trimmed ? limit : 0 };
}

async function submitImage(node: Node, sources: { link: LinkData; node: Node }[], prompt: string, given?: { url: string; name: string }[]) {
  const { form, payload, trimmed } = imageRequest(node, sources, prompt, given);
  if (trimmed) toast(`已自动取前 ${trimmed} 张参考图`, 'info', 3000);
  return (await api<{ items: HistoryItem[] }>('POST', '/api/images', { payload, form: { type: 'image', ...form, ...FROM_CANVAS } })).items.map((item) => item.id);
}

function audioRequest(node: Node, prompt: string, forQuote = false) {
  const data = node.data as unknown as AudioData;
  const tool = data.tool === 'sfx' ? 'sfx' : 'speech';
  const form = tool === 'sfx' ? { prompt, duration: 'auto' } : { prompt, voiceId: data.voiceId, voiceName: data.voiceName };
  const request = tool === 'sfx' ? buildSfxRequest(form as { prompt: string; duration: string }) : buildSpeechRequest(form as { prompt: string; voiceId: string; voiceName: string });
  if (request.problems.length && !forQuote) throw new Error(request.problems[0]);
  return { tool, form, body: request.body };
}

async function submitAudio(node: Node, prompt: string) {
  const { tool, form, body } = audioRequest(node, prompt);
  return (await api<HistoryItem>('POST', `/api/audio/${tool}`, { ...body, form: { type: tool, ...form, ...FROM_CANVAS } })).id;
}

// 一个节点显示出来的名字：图片 1。提示词里 @ 的就是它。
export const nameOf = (node: Node) => `${NODE_LABELS[node.type as NodeKind]}${node.data.no ? ` ${node.data.no}` : ''}`;

// 最后发给模型的提示词：先把 @ 引用换掉，再把没被 @ 到的上游文本节点整段拼在前面。
function promptOf(sources: { link: LinkData; node: Node }[], own: string) {
  const { prompt, inlined } = resolveMentions(own, sources.map((s) => ({ name: nameOf(s.node), kind: s.link.kind, text: (s.node.data as AnyData).text })));
  const upstream = sources.filter((s) => s.link.kind === 'text' && !inlined.has(nameOf(s.node))).map((s) => (s.node.data as AnyData).text || '');
  return joinPrompt(upstream, prompt);
}

// 节点里是不是已经有内容了：上传的、生成出来的（生成失败的、记录已经删掉的不算）。
export function isFilled(data: AnyData) {
  const record = recordOf(data);
  return Boolean(data.upload || (record && record.status !== 'failed') || (data.text || '').trim());
}

// 一个节点再次生成时，结果放哪：节点上单独选过就按节点，没选过跟随设置里的默认（另开新节点）。
export function inPlaceOf(data: AnyData) {
  return data.inPlace ?? canvasPlace() === 'here';
}

// 把一批结果放上画布。空节点总是把结果放进它自己。已经有内容时看落点：
// 就地替换（inPlace）就换掉它原来那份，旧的退进「历史版本」；否则每份结果各开一个新节点，原节点留着不动。
// 新节点的参数和提示词照抄原节点，连进原节点的线也照样连进它，排在原节点下面。snap 是撤销用的那一下。
// append：盒子里的东西是用户自己写的，生成的结果不覆盖它，另开一个节点（文本节点手写的正文就是这样）。
export function deliver(flow: Flow, id: string, results: Record<string, unknown>[], snap: () => void, append = false) {
  const node = flow.getNode(id);
  if (!node || !results.length) return;
  const before = node.data as AnyData;
  const width = (n: Node) => n.measured?.width || nodeWidth(n.type as NodeKind, n.data);
  const rowStep = Math.max(TITLE_ROOM + BOX_HEIGHT + 56, (node.measured?.height || (TITLE_ROOM + BOX_HEIGHT + 240)) + 48);
  // 已经有内容、又不想覆盖它，那一份也不放进这个节点：全部各开新节点。
  const separate = append || (isFilled(before) && !inPlaceOf(before));
  const { here, spots } = placeResults(
    { id, position: node.position, width: width(node) },
    separate,
    results.length,
    flow.getNodes().filter((n) => n.type !== 'group' && !n.hidden).map((n) => ({ id: n.id, position: n.position, width: width(n) })),
    rowStep
  );
  // 换掉原来那份：它退进历史版本，随时能换回来。原来那份是失败的结果就不留了。
  if (here >= 0) {
    const patch = { ...results[here], upload: undefined };
    flow.updateNodeData(id, isFilled(before) ? keepBefore(before, patch) : patch);
  }
  const rest = results.filter((_, index) => index !== here);
  if (!rest.length) return;
  snap();
  // 新节点不带原节点的那份内容、历史版本，也不带「一次几张」：再点它生成，默认只出一份。
  const base = { ...stripNodeData(node.data), recordId: undefined, upload: undefined, kept: undefined, aspect: undefined, count: undefined, no: undefined };
  const fresh = numbered(rest.map((result, index) => ({ id: crypto.randomUUID(), type: node.type, position: spots[index], data: { ...base, ...result } }) as Node), flow.getNodes());
  const incoming = flow.getEdges().filter((edge) => edge.target === id);
  flow.addNodes(fresh);
  flow.addEdges(fresh.flatMap((made) => incoming.map((edge) => ({ ...edge, id: crypto.randomUUID(), target: made.id, selected: false }))));
  // 原节点在一个分组里，新节点也进这个组。
  for (const group of flow.getNodes()) {
    const members = (group.data as { members?: string[] }).members;
    if (group.type === 'group' && members?.includes(id)) flow.updateNodeData(group.id, { members: [...members, ...fresh.map((made) => made.id)] });
  }
}

// 一次只提交一份的接口（视频、工作流）：要几份就提交几次。中途有一次没提交上，已经提交的照样放上画布。
async function submitEach(count: number, say: (text: string) => void, submit: (report: (text: string) => void) => Promise<string>) {
  const ids: string[] = [];
  for (let n = 0; n < count; n++) {
    try {
      ids.push(await submit((text) => say(count > 1 ? `${text}（${n + 1}/${count}）` : text)));
    } catch (err) {
      if (!ids.length) throw err;
      toast(`第 ${n + 1} 份提交失败：${(err as Error).message}`, 'error', 6000);
      break;
    }
  }
  return ids;
}

// once：只管这一次的临时安排。prompt 是直接用这段提示词（斜杠预设、扩图），refs 是直接用这几张参考图。
export async function generate(flow: Flow, id: string, snap: () => void = () => {}, once: { prompt?: string; refs?: { url: string; name: string }[] } = {}) {
  const node = flow.getNode(id);
  if (!node || (node.data as AnyData).busy) return;
  if (node.type === 'text') return write(flow, id, snap);
  // 选的是工作流时看 AutoDL.art 的令牌，其余类型看火山方舟的 Key。
  const flowNode = isFlowModel(String((node.data as AnyData).model || ''));
  if (flowNode ? !flowReady() : !state.app.hasKey) return toast(canManage() ? (flowNode ? '请先在「管理」中配置 AutoDL.art 令牌' : '请先在「管理」中配置 API Key') : '服务暂未开通', 'info');
  const say = (busy: string) => flow.updateNodeData(id, { busy });
  flow.updateNodeData(id, { busy: '准备中', error: '' });
  try {
    const sources = flow
      .getEdges()
      .filter((edge) => edge.target === id)
      .map((edge) => ({ link: edge.data as unknown as LinkData, node: flow.getNode(edge.source)! }))
      .filter((s) => s.node);
    const prompt = promptOf(sources, once.prompt ?? ((node.data as AnyData).prompt || ''));
    const kind = node.type as NodeKind;
    const count = Math.max(1, Number((node.data as AnyData).count) || 1);
    let ids: string[];
    if (flowNode) ids = await submitEach(count, say, (report) => submitFlow(node, sources, prompt, report));
    else if (kind === 'image') ids = await submitImage(node, sources, prompt, once.refs);
    else if (kind === 'video') ids = await submitEach(count, say, (report) => submitVideo(node, sources, prompt, report));
    else ids = [await submitAudio(node, prompt)];
    // 图片、视频、音频都一样：空节点直接把结果放进去；已经有内容时按节点（或设置）选的落点，就地替换或另开新节点。
    deliver(flow, id, ids.map((recordId) => ({ recordId, upload: undefined })), snap);
    await loadHistory().catch(() => {});
    startHistoryLoop();
  } catch (err) {
    flow.updateNodeData(id, { error: (err as Error).message });
    toast((err as Error).message, 'error', 6000);
  } finally {
    flow.updateNodeData(id, { busy: '' });
  }
}

// 文本节点让文本模型写：连进来的文本节点和框里已有的内容当参考，写出来的放进框里（框里已经有字就放进新节点）。
async function write(flow: Flow, id: string, snap: () => void) {
  const node = flow.getNode(id)!;
  const data = node.data as AnyData;
  const prompt = (data.prompt || '').trim();
  const model = state.catalog.polish.includes(data.model || '') ? data.model! : polishModel();
  if (!prompt) return toast('请输入写作要求', 'info');
  if (!model) return toast('暂无可用的文本模型', 'info');
  flow.updateNodeData(id, { busy: '生成中', error: '' });
  try {
    const sources = flow
      .getEdges()
      .filter((edge) => edge.target === id && (edge.data as unknown as LinkData)?.kind === 'text')
      .map((edge) => ({ link: edge.data as unknown as LinkData, node: flow.getNode(edge.source)! }))
      .filter((s) => s.node);
    // 要求里 @ 到的文本节点，内容直接写进要求；其余连进来的文本和框里已有的内容当参考。
    const { prompt: ask, inlined } = resolveMentions(prompt, sources.map((s) => ({ name: nameOf(s.node), kind: 'text' as const, text: (s.node.data as AnyData).text })));
    const upstream = sources.filter((s) => !inlined.has(nameOf(s.node))).map((s) => (s.node.data as AnyData).text || '');
    const result = await api<{ text: string }>('POST', '/api/text', { prompt: ask, context: joinPrompt(upstream, data.text || ''), model });
    // 框里这段字如果是自己手写的，模型写的另开一个节点，别把手写的稿子冲掉；本来就是模型写的，按落点设置走。
    deliver(flow, id, [{ text: result.text }], snap, Boolean((data.text || '').trim()));
  } catch (err) {
    flow.updateNodeData(id, { error: (err as Error).message });
    toast((err as Error).message, 'error', 6000);
  } finally {
    flow.updateNodeData(id, { busy: '' });
  }
}

// ---------- 执行整组 ----------

const RUN_WAIT_MS = 20 * 60 * 1000;

// 把一批节点按上游到下游的顺序挨个生成。只动还没有内容的节点：已经有内容的当作现成的输入，不重新生成。
// 每个节点要等它出了结果才轮到下一个，因为下游要拿它的结果当输入。中途有一个失败就停下。
// 这个节点生成一次大约多少钱（元），和创作页、服务端预扣用的是同一个算法（shared/models.ts 的 quoteCost）。
// 估不出来（没登记价格的型号、拼不出请求）是 null。视频要几段就算几段，图片要几张就算几张。
export function quoteNode(flow: Flow, id: string): number | null {
  const node = flow.getNode(id);
  if (!node || node.type === 'text') return 0;
  const sources = flow
    .getEdges()
    .filter((edge) => edge.target === id)
    .map((edge) => ({ link: edge.data as unknown as LinkData, node: flow.getNode(edge.source)! }))
    .filter((s) => s.node);
  const prompt = promptOf(sources, (node.data as AnyData).prompt || '');
  try {
    if (isFlowModel(String((node.data as AnyData).model || ''))) {
      // 工作流的价按提交的这组参数算（分辨率档、按秒计费的时长），和创作页用同一套规则。
      const { flow, inputs } = flowRequest(sources, node, prompt, true);
      const yuan = workflowCost({ price_type: flow.billing?.price_type, billing_config: flow.billing?.billing_config, price: flow.billing?.price }, inputs, durationOf(inputs));
      return yuan == null ? null : yuan * Math.max(1, Number((node.data as AnyData).count) || 1);
    }
    if (node.type === 'video') {
      const payload = videoRequest(node, sources, prompt, true).payload || {};
      const yuan = quoteCost({ kind: 'video', model: String(payload.model || ''), payload });
      return yuan == null ? null : yuan * Math.max(1, Number((node.data as AnyData).count) || 1);
    }
    if (node.type === 'image') {
      const payload = imageRequest(node, sources, prompt, undefined, true).payload || {};
      const yuan = quoteCost({ kind: 'image', model: String(payload.model || ''), payload });
      return yuan == null ? null : yuan * (Number(payload.n) || 1);
    }
    const { tool, body } = audioRequest(node, prompt, true);
    return quoteCost({ tool, prompt: String(body?.text || ''), payload: { duration_seconds: body?.duration } });
  } catch {
    return null;
  }
}

// 一次要生成好几个节点之前问一句：要生成几个、各是什么，已经有结果的几个会不会被重新生成。只有文本节点（不花钱）时不问。
export async function confirmRun(flow: Flow, ids: string[]) {
  const all = ids.map((id) => flow.getNode(id)).filter((node): node is Node => Boolean(node));
  const nodes = all.filter((node) => node.type !== 'text');
  if (!nodes.length) return true;
  // 列出来的个数要和标题对得上，文本节点也算进去。
  const counts = (['video', 'image', 'audio', 'text'] as NodeKind[]).map((kind) => [kind, all.filter((n) => n.type === kind).length] as const).filter(([, n]) => n);
  const redo = nodes.filter((n) => isFilled(n.data as AnyData)).length;
  const what = `${counts.map(([kind, n]) => `${NODE_LABELS[kind]} ${n} 个`).join('、')}，按连线的先后依次生成。`;
  // 合计大约要花多少：多人模式的成员说积分（和发送键旁边一样），其余说元。有估不出来的单独说。
  const quotes = nodes.map((node) => quoteNode(flow, node.id));
  const known = quotes.filter((q): q is number => q != null);
  const total = known.reduce((sum, q) => sum + q, 0);
  const unknown = quotes.length - known.length;
  const cost = known.length ? `预计花费约 ${usesCredits() ? fmtCredits(known.reduce((sum, q) => sum + toCredits(q), 0)) : fmtYuan(total)}${unknown ? `，另有 ${unknown} 个无法估算` : ''}。` : '';
  const short = usesCredits() && state.credits != null && known.length ? known.reduce((sum, q) => sum + toCredits(q), 0) > state.credits : false;
  return confirmDialog({ title: `生成 ${ids.length} 个节点？`, message: `${redo ? `${what}其中 ${redo} 个已有结果，会重新生成。` : what}${cost}${short ? `剩余 ${fmtCredits(state.credits!)}，可能不够全部生成。` : ''}`, okText: '开始生成' });
}

export async function runAll(flow: Flow, ids: string[], snap: () => void) {
  const todo = runOrder(ids, flow.getEdges()).filter((id) => {
    const node = flow.getNode(id);
    if (!node || isFilled(node.data as AnyData)) return false;
    // 没写要求的文本节点是留给人自己填的，跳过。
    return node.type !== 'text' || Boolean(((node.data as AnyData).prompt || '').trim());
  });
  if (!todo.length) return toast('该分组没有待生成的节点', 'info');
  if (!(await confirmRun(flow, todo))) return;
  for (const [index, id] of todo.entries()) {
    await generate(flow, id, snap);
    const deadline = Date.now() + RUN_WAIT_MS;
    for (;;) {
      const node = flow.getNode(id);
      if (!node) return;
      const data = node.data as AnyData;
      const record = recordOf(data);
      const failed = Boolean(data.error) || record?.status === 'failed' || (node.type !== 'text' && !data.recordId);
      if (failed || Date.now() > deadline) return toast(`第 ${index + 1} 个节点执行失败：${data.error || record?.error?.message || '未返回结果'}`, 'error', 6000);
      if (node.type === 'text' ? (data.text || '').trim() && !data.busy : outputOf(node)) break;
      await sleep(1000);
    }
  }
  toast('分组执行完成', 'success');
}

// ---------- 新节点的默认参数 ----------

// 视频节点的分辨率、比例、时长要落在所选模型支持的范围里；换模型之后不在范围里的换成它支持的第一个。
export function fitVideo(data: VideoData): VideoData {
  const able = specOf(data.model);
  const pick = <T,>(list: T[], value: T) => (list.includes(value) || !list.length ? value : list[0]);
  return { ...data, resolution: pick(able.resolutions, data.resolution), ratio: pick(able.ratios, data.ratio), duration: pick(able.durations, data.duration) };
}

// 新建节点时的参数跟创作页当前选的一致，选的模型不在了就用列表里的第一个。
export function newNodeData(kind: NodeKind, seed: { form: { model: string; resolution: string; ratio: string; duration: number }; image: { model: string; ratio: string; resolution?: string }; speech: { voiceId: string; voiceName: string } }): Record<string, unknown> {
  if (kind === 'text') return { text: '', prompt: '' };
  if (kind === 'image') {
    const models = state.catalog.image;
    const model = models.includes(seed.image.model) || !models.length ? seed.image.model : models[0];
    return { prompt: '', model, ratio: seed.image.ratio, resolution: fitImageSize(model, seed.image.resolution) };
  }
  if (kind === 'video') {
    // 新建节点的默认模型：优先能用的型号（所在的平台配了 Key），都不可用时用目录里第一个出视频的工作流。
    const usable = state.models.filter((m) => !state.catalog.unavailable.includes(m));
    const flows = flowModelsOf('video');
    const model = usable.includes(seed.form.model) ? seed.form.model : usable[0] || flows[0] || state.models[0] || '';
    return { ...fitVideo({ prompt: '', model, resolution: seed.form.resolution, ratio: seed.form.ratio, duration: seed.form.duration }) };
  }
  return { tool: 'speech', prompt: '', voiceId: seed.speech.voiceId, voiceName: seed.speech.voiceName };
}

// 画布的封面：里面最近生成的一张图或一段视频；没有生成过就用上传的。
export function coverOf(nodes: Node[]): { url: string; kind: 'image' | 'video' } | null {
  let best: { url: string; kind: 'image' | 'video'; at: number } | null = null;
  for (const node of nodes) {
    if (node.type !== 'image' && node.type !== 'video') continue;
    const kind: 'image' | 'video' = node.type;
    const data = node.data as AnyData;
    const record = recordOf(data);
    const found =
      record?.status === 'completed' && record.mediaUrl && record.savedLocally
        ? { url: record.mediaUrl, kind, at: record.completedAt || record.createdAt || 1 }
        : data.upload
          ? { url: data.upload.url, kind, at: 0 }
          : null;
    if (found && (!best || found.at > best.at)) best = found;
  }
  return best && { url: best.url, kind: best.kind };
}
