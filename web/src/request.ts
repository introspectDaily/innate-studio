// 把创作表单转成发给本地服务的请求。纯函数，不碰页面和网络，可以单独测试。
// 视频的提示词是 prompt 字符串，首尾帧在 frame_images，参考素材在 input_references，本地服务把它换成平台（火山方舟、MiniMax）自己的格式再发出去。图片、语音、音效、配乐各有一个小函数。

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
  } else if (mode === 'reference') {
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
  const payload: Record<string, unknown> = { model: form.model, duration: Number(form.duration), resolution: form.resolution };
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
  } else {
    const refs = [...form.refs.image, ...form.refs.video, ...form.refs.audio];
    payload.input_references = refs.map(media);
    if (!text && !form.refs.image.length && !form.refs.video.length) {
      problems.push(form.refs.audio.length ? '仅有音频无法生成，请添加提示词、图片或视频' : '请输入提示词，或添加参考图片、视频');
    }
  }
  // 有的模型（MiniMax H3）只给素材不行，必须写提示词。
  if (spec.promptRequired && !text && !problems.length) problems.push('请输入提示词');
  // 有首帧时画面比例跟着图片走，其余情况才需要指定。
  if (form.mode !== 'frames') payload.aspect_ratio = form.ratio;

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
