// 把创作表单转成发给本地服务的请求。纯函数，不碰页面和网络，可以单独测试。
// 视频的提示词是 prompt 字符串，首尾帧在 frame_images，参考素材在 input_references，本地服务把它换成平台（火山方舟、MiniMax）自己的格式再发出去。图片、语音、音效、配乐各有一个小函数。

import { cleanInputs, ruleKind, type InputRule } from '../../shared/autodl.ts';
import type { VideoSpec } from '../../shared/models.ts';
import type { VideoForm, ImageForm, SpeechForm, SfxForm, MusicForm, Ref, BuiltRequest } from './types.ts';

const MEDIA_FIELD: Record<string, string> = { image: 'image_url', video: 'video_url', audio: 'audio_url' };

// 当前模式下实际会用到的参考素材。
export function refsInUse(form: VideoForm): Ref[] {
  if (form.mode === 'frames') return [form.frames.first, form.frames.last].filter((r): r is Ref => Boolean(r));
  if (form.mode === 'reference') return [...form.refs.image, ...form.refs.video, ...form.refs.audio];
  return [];
}

// 换生成方式时把已经添加的图片带过去，不用重新添加。返回换完之后的首尾帧和参考素材。
// 换成首尾帧：首帧空着的话，第一张参考图当首帧。换成参考生成：首帧、尾帧排到参考图的最前面，放不下的留在原处。
// 图是挪过去的，不在原处留一份，免得在一边移除了、换回来又出现。
export function carryRefs(form: VideoForm, mode: VideoForm['mode'], maxImages: number): Pick<VideoForm, 'frames' | 'refs'> {
  const frames = { ...form.frames };
  let images = [...form.refs.image];
  if (mode === 'frames' && !frames.first && images.length) {
    frames.first = images[0];
    images = images.slice(1);
  // 换到非首尾帧的方式（全能参考、编辑、延长）时，首尾帧槽里的图退回参考图。
  } else if (mode !== 'frames') {
    const moved: Ref[] = [];
    for (const key of ['first', 'last'] as const) {
      const ref = frames[key];
      if (!ref) continue;
      const known = [...moved, ...images].some((r) => r.url === ref.url);
      if (!known && moved.length + images.length >= maxImages) continue;
      if (!known) moved.push(ref);
      frames[key] = null;
    }
    images = [...moved, ...images];
  }
  return { frames, refs: { ...form.refs, image: images } };
}

// 返回 { payload, problems }。problems 非空时不能提交。spec 是这个模型支持什么。
// 图片和音频可以用本机的文件（本地服务会把它内嵌进请求）；参考视频也会由本地服务按需发布成公网直链。
// 2026-10-09 用真实接口跑过：文生视频、首帧、首尾帧、参考图、图加视频加音频的参考生成都能用。
export function buildVideoRequest(form: VideoForm, spec: VideoSpec): BuiltRequest {
  const problems: string[] = [];
  const text = form.prompt.trim();
  // 时长交给模型决定时发 -1（官方约定），其余按选的秒数发。
  const payload: Record<string, unknown> = { model: form.model, duration: form.durationAuto ? -1 : Number(form.duration), resolution: form.resolution };
  if (text) payload.prompt = text;
  const media = (ref: Ref) => ({ type: MEDIA_FIELD[ref.kind], [MEDIA_FIELD[ref.kind]]: { url: ref.url } });

  if (form.mode === 'text') {
    if (!text) problems.push('请输入提示词');
  } else if (form.mode === 'frames') {
    const frames: Record<string, unknown>[] = [];
    if (form.frames.first) frames.push({ ...media(form.frames.first), frame_type: 'first_frame' });
    else problems.push('请添加首帧图片');
    if (form.frames.last && spec.frames.includes('last_frame')) frames.push({ ...media(form.frames.last), frame_type: 'last_frame' });
    payload.frame_images = frames;
  } else if (form.mode === 'edit' || form.mode === 'extend') {
    // 编辑/延长：素材照参考生成那样发，但必须有一段参考视频当原片，比例跟原片走（adaptive，不发 aspect_ratio），
    // 编辑的时长必须交给模型（-1，跟随原视频）。2.5 用 omni_reference_task_type 显式指定子任务，把参数报错前置；
    // 2.0 系列没有这个参数，任务类型由提示词意图判定。
    const refs = [...form.refs.image, ...form.refs.video, ...form.refs.audio];
    payload.input_references = refs.map(media);
    if (!form.refs.video.length) problems.push(form.mode === 'edit' ? '编辑视频需要一段参考视频，请添加或连接视频' : '延长视频需要一段参考视频，请添加或连接视频');
    if (!text) problems.push(`请输入提示词，说明要${form.mode === 'edit' ? '怎么改' : '怎么接'}`);
    if (form.mode === 'edit') payload.duration = -1;
    if (spec.taskTypeParam) payload.omni_reference_task_type = form.mode;
  } else {
    const refs = [...form.refs.image, ...form.refs.video, ...form.refs.audio];
    payload.input_references = refs.map(media);
    // 2.5 支持纯音频参考；其余模型（2.0 系列、MiniMax）的音频必须搭配图片或视频。
    if (!text && !form.refs.image.length && !form.refs.video.length && !form.refs.audio.length) {
      problems.push('请输入提示词，或添加参考图片、视频');
    } else if (!text && !form.refs.image.length && !form.refs.video.length && form.refs.audio.length && !spec.audioOnlyRefs) {
      problems.push('仅有音频无法生成，请添加提示词、图片或视频');
    }
  }
  // 有的模型（MiniMax H3）只给素材不行，必须写提示词。
  if (spec.promptRequired && !text && !problems.length) problems.push('请输入提示词');
  // 有首帧时画面比例跟着图片走，编辑/延长跟原视频走（adaptive）；其余情况才需要指定。
  if (!['frames', 'edit', 'extend'].includes(form.mode)) payload.aspect_ratio = form.ratio;

  if (spec.audio) payload.generate_audio = Boolean(form.generateAudio);
  const seed = String(form.seed).trim();
  if (spec.seed && seed !== '') {
    if (/^-?\d+$/.test(seed)) payload.seed = Number(seed);
    else problems.push('随机种子须为整数');
  }
  return { payload, problems };
}

// refLimit 是这个模型最多收几张参考图，0 是不收。参考图只能是本机的图片或公网链接，本地服务会把本机的内嵌进请求。
export function buildImageRequest(form: ImageForm, refLimit = 0): BuiltRequest {
  const prompt = form.prompt.trim();
  const refs = form.refs || [];
  const problems: string[] = [];
  const payload: Record<string, unknown> = { model: form.model, prompt, n: Number(form.count) || 1, aspect_ratio: form.ratio };
  if (form.resolution) payload.resolution = form.resolution;
  if (form.quality) payload.quality = form.quality;
  if (!prompt) problems.push(refs.length ? '请输入修改要求' : '请输入提示词');
  if (refs.length) {
    if (!refLimit) problems.push(`${form.model} 不支持参考图，请移除参考图或更换模型`);
    else if (refs.length > refLimit) problems.push(`${form.model} 最多支持 ${refLimit} 张参考图`);
    payload.input_references = refs.map((ref) => ({ type: 'image_url', image_url: { url: ref.url } }));
  }
  return { payload, problems };
}

// ---------- 工作流：把表单按 input_rules 拼成入参 ----------
// 两家工作流（AutoDL.art / RunningHub）共用这一套形状。纯函数，创作页和画布都用它。
export type FlowFormValues = { values: Record<string, unknown>; refs: Record<string, Ref | null> };

export function buildFlowInputs(rules: Record<string, InputRule>, form: FlowFormValues): { inputs: Record<string, unknown>; problems: string[] } {
  const raw: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(rules)) {
    const kind = ruleKind(rule);
    if (kind === 'media') {
      const ref = form.refs[key];
      if (ref) raw[key] = ref.url;
    } else if (kind === 'number') {
      const text = form.values[key];
      if (text !== '' && text != null) raw[key] = Number(text);
    } else if (kind === 'toggle') {
      if (form.values[key] !== undefined) raw[key] = form.values[key];
    } else if (kind === 'select') {
      if (form.values[key]) raw[key] = form.values[key];
    } else if (form.values[key] !== '' && form.values[key] != null) {
      raw[key] = form.values[key];
    }
  }
  return cleanInputs(rules, raw);
}

// 「图片」里选了出图工作流：提示词来自图片表单的主文本框（技能润色后传 promptOverride），
// 参考图按规则里的 image 槽顺序填，其余参数（宽高、种子、张数、机器档位）来自工作流的参数面板。
export function buildImageFlowInputs(rules: Record<string, InputRule>, image: Pick<ImageForm, 'prompt' | 'refs'>, form: FlowFormValues, primaryKey: string | null, promptOverride?: string): BuiltRequest {
  const values = { ...form.values };
  if (primaryKey) values[primaryKey] = String(promptOverride ?? image.prompt ?? '').trim();
  const slots = Object.keys(rules).filter((key) => rules[key].type === 'image');
  const picked = image.refs || [];
  if (picked.length > slots.length)
    return { payload: {}, problems: [slots.length ? `这个工作流最多支持 ${slots.length} 张参考图` : '这个工作流是文生图，不接受参考图'] };
  const refs = { ...form.refs };
  slots.forEach((key, index) => {
    refs[key] = picked[index] || null;
  });
  // 和别的 build*Request 一样给 payload：提交链路取的是 request.payload 当 inputs。
  const { inputs, problems } = buildFlowInputs(rules, { values, refs });
  return { payload: inputs, problems };
}

export function buildSpeechRequest(form: SpeechForm): BuiltRequest {
  const text = form.prompt.trim();
  const problems: string[] = [];
  if (!text) problems.push('请输入朗读文本');
  else if (!form.voiceId) problems.push('请选择音色');
  return { body: { text, voiceId: form.voiceId, voiceName: form.voiceName }, problems };
}

export function buildSfxRequest(form: SfxForm): BuiltRequest {
  const text = form.prompt.trim();
  const body: Record<string, unknown> = { text };
  // 时长选"自动"时不传，由模型决定。
  if (form.duration !== 'auto') body.duration = Number(form.duration);
  return { body, problems: text ? [] : ['请输入音效描述'] };
}

// 一段配乐最长这么多秒（模型的上限）。
export const MAX_MUSIC_SECONDS = 120;
// 配乐多长：给了视频就和视频一样长（超过上限的按上限），没给就用选的时长。
export const musicSeconds = (form: MusicForm) => (form.video ? Math.min(MAX_MUSIC_SECONDS, Math.max(1, Math.round(form.video.duration ?? 0))) : Number(form.duration));

export function buildMusicRequest(form: MusicForm): BuiltRequest {
  const text = form.prompt.trim();
  const video = form.video;
  const problems: string[] = [];
  if (!text) problems.push('请输入配乐描述');
  else if (video && !((video.duration ?? 0) > 0)) problems.push('无法获取视频时长，请重新选择');
  return { body: { text, duration: musicSeconds(form), ...(video ? { video: video.url } : {}) }, problems };
}
