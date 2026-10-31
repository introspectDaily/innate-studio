// 生成记录：任务进度、播放、下载、复用参数、详情。视频、图片、音频（语音、音效、配乐）都在这里。
// 有两处用到：创作页输入框下面的「最近生成」（只列最新几条），和单独的「创作记录」页（全部，带筛选和搜索）。

import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, state, emit, useStore, loadHistory, isPendingTask, isTimedOutTask, goTo, usesCredits } from './store.ts';
import { fmtTime, fmtDuration, fmtBytes, fmtCost, fmtCredits } from './format.ts';
import { stopPlaying } from './playback.ts';
import { VideoPlayer, AudioPlayer } from './player.tsx';
import { Thumb } from './assets.tsx';
import { Icon } from './ui/Icon.tsx';
import { Segmented, SearchBox, tip, clipTip } from './ui/controls.tsx';
import { toast, openModal, openMenu, confirmDialog, copyText } from './ui/layers.tsx';
import { openVideoEditor } from './editor/VideoEditor.tsx';
import { enter } from './ui/motion.ts';
import { FailureState, explainFailure, refundNote } from './ui/states.tsx';
import { setForm, setStudio, setFlow, submit, useImageForVideo, useVideoForMusic } from './composer/state.ts';
import { openCharacterEditor } from './characters.tsx';
import { IMAGE_QUALITY_LABELS, REFERENCE_MODE_LABEL, estimateCost } from '../../shared/models.ts';
import { ruleLabel } from '../../shared/autodl.ts';
import type { CreateType, HistoryItem, Ref } from './types.ts';

const MODE_LABELS: Record<string, string> = { text: '文生视频', frames: '首尾帧', edit: '编辑视频', extend: '延长视频' };
const STATUS_LABELS: Record<string, string> = { queued: '排队中', in_progress: '生成中', completed: '已完成', failed: '失败' };
const KIND_LABELS = { video: '视频', image: '图片', audio: '音频' };
// 五种内容，和创作页输入框上方的切换是同一组。工作流是 AutoDL.art 上跑的 ComfyUI 工作流。
const TYPE_LABELS: Record<CreateType, string> = { video: '视频', image: '图片', speech: '语音', sfx: '音效', music: '配乐', flow: '工作流' };

const message = (err: unknown) => (err as Error).message;

// 这条记录是哪种内容：工作流、视频、图片，或者音频里的语音、音效、配乐。
const typeOf = (item: HistoryItem): CreateType => (item.provider === 'autodl' ? 'flow' : item.kind === 'audio' ? item.tool! : item.kind);
const typeLabel = (item: HistoryItem) => TYPE_LABELS[typeOf(item)];
// 没有提示词的记录（配乐、只填了素材和参数的工作流）用它的类型或工作流的名字来称呼。
const nameOf = (item: HistoryItem) => item.prompt || (item.provider === 'autodl' ? item.model : '') || typeLabel(item);
const done = (item: HistoryItem) => item.status === 'completed' && Boolean(item.mediaUrl);

const RECENT_COUNT = 6;

// 在画布里生成的（提交时画布在表单里留了记号）。它们不进创作页的「最近生成」，记录页里单独看。
const fromCanvas = (item: HistoryItem) => item.form?.from === 'canvas';

// 表单里记着生成方式；很早的记录没存表单，看请求里的素材各是什么用途。
function modeOf(item: HistoryItem) {
  const roles: string[] = (item.payload?.content || []).map((c: { role?: string }) => c.role).filter(Boolean);
  const mode: string = item.form?.mode || (roles.some((r) => r === 'first_frame' || r === 'last_frame') ? 'frames' : roles.length ? 'reference' : 'text');
  return mode === 'reference' ? REFERENCE_MODE_LABEL : MODE_LABELS[mode];
}

function refsOf(item: HistoryItem): Ref[] {
  const f = item.form;
  if (item.provider === 'autodl') return Object.values((f?.refs || {}) as Record<string, Ref | null>).filter((ref): ref is Ref => Boolean(ref));
  if (!f || item.kind !== 'video') return [];
  if (f.mode === 'frames') return [f.frames?.first, f.frames?.last].filter(Boolean);
  if (f.mode === 'reference') return [...(f.refs?.image || []), ...(f.refs?.video || []), ...(f.refs?.audio || [])];
  return [];
}

// ---------- 对一条记录能做的事 ----------

async function removeItem(item: HistoryItem) {
  const ok = await confirmDialog({
    title: '删除这条记录？',
    message: '删除后无法恢复。',
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('DELETE', `/api/history/${encodeURIComponent(item.id)}`);
    await loadHistory();
  } catch (err) {
    toast(message(err), 'error');
  }
}

// 把这条记录的参数填回创作页的输入框。
function fill(item: HistoryItem) {
  // 画布的记号不跟着填回创作面板，不然下一次在创作页生成的也会被算成画布的。
  const { from: _from, ...rest } = item.form || {};
  const form = item.form && rest;
  if (item.provider === 'autodl') {
    // 工作流：选回同一条工作流，按记录里存的规则和参数把表单恢复出来。规则要现取，所以不等它。
    setFlow(item);
  } else if (item.kind !== 'video') {
    setStudio(typeOf(item) as 'image' | 'speech' | 'sfx' | 'music', form || { prompt: item.prompt });
  } else if (form) {
    setForm(form);
  } else {
    const p = item.payload || {};
    const basics = { mode: 'text', prompt: item.prompt || '', model: item.model, resolution: p.resolution, ratio: p.ratio };
    setForm(Object.fromEntries(Object.entries(basics).filter(([, value]) => value != null)));
  }
  goTo('create');
}

function reuse(item: HistoryItem) {
  fill(item);
  toast('已复用参数', 'success');
}

// 画布上生成的在画布里重跑，这里不给。
const canRetry = (item: HistoryItem) => item.status === 'failed' && !isTimedOutTask(item) && !item.form?.from;

// 失败的记录：用同样的参数再提交一次。结果是一条新记录，失败的那条留着，可以自己删。
function retry(item: HistoryItem) {
  fill(item);
  submit();
}

async function refresh(item: HistoryItem) {
  try {
    await api('POST', `/api/history/${encodeURIComponent(item.id)}/refresh`);
    await loadHistory();
  } catch (err) {
    toast(message(err), 'error');
  }
}

// 查询超时的任务：再向平台查一次，并说明这次查到了什么。
async function recheck(item: HistoryItem) {
  try {
    const next = await api<HistoryItem>('POST', `/api/history/${encodeURIComponent(item.id)}/refresh`);
    await loadHistory();
    if (next.status === 'completed') toast('任务已完成', 'success');
    else if (isTimedOutTask(next)) toast(next.pollError ? `状态查询失败：${next.pollError}` : '暂无结果', 'info');
  } catch (err) {
    toast(message(err), 'error');
  }
}

// 把一张生成的图片拿去生成视频。
async function animate(item: HistoryItem) {
  try {
    await useImageForVideo(item);
    toast('已添加为参考图', 'success');
  } catch (err) {
    toast(message(err), 'error', 6000);
  }
}

async function score(item: HistoryItem) {
  if (!item.savedLocally) return toast('视频保存中，请稍后重试', 'info');
  await useVideoForMusic(item);
  toast('已添加视频', 'success');
}

// 已经存到本机的直接下载，还没存下来的在新标签页打开原地址。
const downloadProps = (item: HistoryItem): { href?: string; download?: string; target?: string } => (item.savedLocally ? { href: `${item.mediaUrl}?download=1`, download: '' } : { href: item.mediaUrl, target: '_blank' });

function download(item: HistoryItem) {
  const link = document.createElement('a');
  link.rel = 'noopener';
  for (const [name, value] of Object.entries(downloadProps(item))) link.setAttribute(name, value);
  document.body.append(link);
  link.click();
  link.remove();
}

// 一次出了好几份结果（AutoDL 的工作流）：主文件和其余的逐个下载。浏览器可能把连着点的几个下载并成一个询问，换个方式也行。
function downloadAll(item: HistoryItem) {
  const files = [item.mediaUrl!, ...(item.extraFiles || []).map((extra) => fileUrl(item, extra.file))];
  files.forEach((href, index) => {
    window.setTimeout(() => {
      const link = document.createElement('a');
      link.rel = 'noopener';
      link.href = `${href}?download=1`;
      link.setAttribute('download', '');
      document.body.append(link);
      link.click();
      link.remove();
    }, index * 150);
  });
}

// 卡片右上角的「更多」。菜单内容按点开那一刻的状态来定：生成中的可以刷新，查询超时的可以重新查询，已完成的可以下载。
// 已完成的视频可以拿去配乐，已完成的图片可以拿去生成视频、存为角色。
function openCardMenu(button: HTMLElement, id: string, scope: Scope) {
  const item = state.history.find((i) => i.id === id);
  if (!item) return;
  const actions: Record<string, () => void> = {
    download: () => download(item),
    refresh: () => refresh(item),
    recheck: () => recheck(item),
    reuse: () => reuse(item),
    retry: () => retry(item),
    score: () => score(item),
    animate: () => animate(item),
    character: () => openCharacterEditor({ images: [item.mediaUrl!] }),
    detail: () => openDetail(item.id, scope),
    remove: () => removeItem(item),
  };
  openMenu(button, {
    label: '更多操作',
    align: 'end',
    items: [
      done(item) && { value: 'download', label: '下载' },
      // 图片、语音、音效没有任务可查，生成中只能等。
      isPendingTask(item) && !item.direct && { value: 'refresh', label: '刷新' },
      isTimedOutTask(item) && { value: 'recheck', label: '重新查询' },
      canRetry(item) && { value: 'retry', label: '重新生成' },
      { value: 'reuse', label: '复用参数' },
      done(item) && item.kind === 'video' && { value: 'score', label: '配乐' },
      done(item) && item.kind === 'image' && { value: 'animate', label: '生成视频' },
      done(item) && item.kind === 'image' && item.savedLocally && { value: 'character', label: '存为角色' },
      { value: 'detail', label: '详情' },
      { value: 'remove', label: '删除', danger: true },
    ].filter((entry) => Boolean(entry)) as { value: string; label: string; danger?: boolean }[],
    onSelect: (value) => actions[value](),
  });
}

// ---------- 画面 ----------

// 图片：比例和画框差不多就铺满，差得多（比如竖图）就完整显示、两边留底色，不裁画面。详情里总是完整显示。
function ImageView({ item, large }: { item: HistoryItem; large: boolean }) {
  const [cover, setCover] = useState(false);
  // 详情里：画框缩成图片的比例，四周不留底色。
  const [ratio, setRatio] = useState(0);
  return (
    <div className={`image-view${ratio ? ' fit' : ''}`} style={ratio ? ({ '--ratio': ratio } as CSSProperties) : undefined}>
      <img
        className={`media-image${cover ? ' cover' : ''}`}
        src={(!large && item.thumbUrl) || item.mediaUrl}
        alt={item.prompt || '生成的图片'}
        onLoad={large ? (e) => setRatio(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight) : (e) => setCover(Math.abs(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight / (16 / 9) - 1) < 0.03)}
      />
    </div>
  );
}

// 图片结果。工作流可能一次出好几张，第一张铺满画框，其余几张在详情里并排，每张都能单独保存。
function ImageBox({ item, large }: { item: HistoryItem; large: boolean }) {
  const extra = item.extraFiles || [];
  if (!extra.length) return <ImageView item={item} large={large} />;
  return (
    <div className={`image-set${large ? ' is-large' : ''}`}>
      <ImageView item={item} large={large} />
      {large && (
        <div className="image-set-more">
          {extra.map(({ file }) => (
            <a key={file} className="image-set-thumb" href={`${fileUrl(item, file)}?download=1`} download rel="noopener" {...tip('下载这张图')}>
              <Thumb thumb={fileUrl(item, file)} kind="image" />
            </a>
          ))}
        </div>
      )}
      {!large && extra.length > 0 && <span className="badge badge-pending image-set-badge">{`共 ${extra.length + 1} 张`}</span>}
    </div>
  );
}

// 结果里额外的文件（AutoDL 一次可能给一组结果）的地址：和主文件在同一个目录。
const fileUrl = (item: HistoryItem, file: string) => `${item.mediaUrl!.slice(0, item.mediaUrl!.lastIndexOf('/') + 1)}${encodeURIComponent(file)}`;

function AudioView({ item, large }: { item: HistoryItem; large: boolean }) {
  const voice = item.tool === 'speech' && item.payload?.voice_name;  // 详情里的配乐：原视频还在本机的话，画面和音乐一起放，才听得出配得怎么样。
  const source = item.tool === 'music' && item.form?.video?.url;
  if (large && source) return <VideoPlayer src={source} soundtrack={item.mediaUrl} autoplay fit label="配乐预览" />;
  // 配乐没有提示词，写上它是给多长的视频配的。
  const seconds = item.tool === 'music' && Math.round(item.payload?.duration_seconds || 0);
  const text = item.prompt || (seconds ? `${seconds} 秒视频配乐` : '');
  return <AudioPlayer src={item.mediaUrl} kind={voice ? `${typeLabel(item)} · ${voice}` : typeLabel(item)} text={text} label={nameOf(item)} />;
}

function MediaBox({ item, large = false }: { item: HistoryItem; large?: boolean }) {
  if (done(item)) {
    if (item.kind === 'image') return <ImageBox item={item} large={large} />;
    if (item.kind === 'audio') return <AudioView item={item} large={large} />;
    return <VideoPlayer src={item.videoUrl} poster={large ? null : item.thumbUrl} size={large ? undefined : item.media} autoplay={large} hoverPlay={!large} fit={large} frameRatio={large ? null : 16 / 9} showLength={!large} label={item.prompt || '生成的视频'} />;
  }
  if (item.status === 'failed') {
    // 标题带上类型，卡片上再写一行提示词：创作记录里各种失败排在一起时，才分得清是哪一条。详情里本来就有，不重复。
    const timedOut = isTimedOutTask(item);
    return (
      <div className="card-state is-failed">
        <FailureState
          title={timedOut ? '查询超时' : `${typeLabel(item)}生成失败`}
          reason={item.error?.message}
          extra={large ? null : nameOf(item)}
          note={timedOut ? null : refundNote(item)}
        />
      </div>
    );
  }
  if (item.status === 'completed') {
    return (
      <div className="card-state">
        <div className="state-title">已完成，但未获取到{KIND_LABELS[item.kind]}地址</div>
      </div>
    );
  }
  // 只有视频任务会报进度；其余的只知道还在生成。
  const video = item.kind === 'video';
  const progress = Math.max(0, Math.min(100, item.progress || 0));
  // 下面写上是哪一条、等了多久：一屏好几张生成中的卡片时分得开，等得久了也知道不是卡住了。详情里有提示词，不重复。
  return (
    <div className="card-state is-pending">
      <div className="state-chip cursor-text">{item.status === 'queued' ? '排队中' : video ? `生成中 ${progress}%` : '生成中'}</div>
      {item.pollError && <div className="small muted">状态查询失败：{item.pollError}</div>}
      {!large && (
        <div className="pending-info">
          {item.prompt && (
            <div className="pending-prompt" {...clipTip(item.prompt)}>
              {item.prompt}
            </div>
          )}
          <div className="pending-meta">
            {typeLabel(item)}
            {item.createdAt ? <Elapsed since={item.createdAt} /> : null}
          </div>
        </div>
      )}
    </div>
  );
}

// 等了多久，每秒走一下。只有生成中的卡片上有，自己走自己的，不带着整张卡片重画。
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span> · 已等待 {fmtDuration(now - since)}</span>;
}

// 画面要不要重画，看这几项有没有变。视频存到本机后地址会变，但画面不用重画：重画会打断正在播放的视频。
const mediaSignature = (i: HistoryItem) => JSON.stringify([i.status, i.progress, Boolean(i.mediaUrl), i.error?.message, i.pollError, i.prompt, i.credits?.charged]);
const CardMedia = memo(
  ({ item }: { item: HistoryItem; signature: string }) => <MediaBox item={item} />,
  (before, after) => before.signature === after.signature,
);

// 一张卡片只有画面。提示词、参数、时间都在详情里，点画面打开；
// 操作收在画面右上角的「更多」里，鼠标移上去才出现。
// index 是它在列表里排第几：一批卡片一起出现时，靠后的晚一点进场。新提交的任务排在最前，单独进场。
function Card({ item, index, scope }: { item: HistoryItem; index: number; scope: Scope }) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    enter(ref.current, { y: 8, duration: 260, delay: Math.min(index, 8) * 35 });
  }, []);
  return (
    <article ref={ref} className={`card status-${item.status}`} aria-label={nameOf(item)}>
      {/* 音频控制行和「更多」上的点击各管各的，不算在"点画面打开详情"里。 */}
      <div className="card-media" onClick={(e) => !(e.target as Element).closest('.audio-controls, .card-more') && openDetail(item.id, scope)}>
        <CardMedia item={item} signature={mediaSignature(item)} />
        <button className="icon-btn icon-btn-sm card-more" type="button" {...tip('更多')} aria-label="更多操作" aria-haspopup="menu" aria-expanded="false" onClick={(e) => openCardMenu(e.currentTarget, item.id, scope)}>
          <Icon name="more" size={16} />
        </button>
      </div>
    </article>
  );
}

// 把一组记录画成卡片网格。卡片按记录的 id 对应，进度更新时正在播放的视频不会被打断。
// 详情里的上一条、下一条就在这一组里走，所以把这一组当前的样子交给卡片。
// all 是只画出前几条时的完整一组：创作页只列最近几条，但在详情里可以一直往后翻。
function CardGrid({ list, all = list, empty }: { list: HistoryItem[]; all?: HistoryItem[]; empty: ReactNode }) {
  const latest = useRef(all);
  latest.current = all;
  const scope = useRef<Scope>(() => latest.current).current;
  // 全是音频的一组（语音、音效、配乐页，记录页筛到音频）：音频没有画面，16:9 的框下半截是空的，换成矮一点的卡片，一屏放得下更多。
  // 和视频、图片混在一起时仍是 16:9，一行的卡片才一样高。
  const audio = list.length > 0 && list.every((item) => item.kind === 'audio');
  return <div className={`card-grid${audio ? ' is-audio' : ''}`}>{list.length ? list.map((item, index) => <Card key={item.id} item={item} index={index} scope={scope} />) : empty}</div>;
}

// ---------- 详情 ----------

const SR_SCENE_LABELS: Record<string, string> = { aigc: 'AIGC 内容', short_series: '短剧', ugc: 'UGC', old_film: '老片' };

function describeSuperResolution(sr?: Record<string, any>) {
  if (!sr) return null;
  return [
    sr.resolution ? `目标 ${sr.resolution}` : sr.resolution_limit ? `短边 ${sr.resolution_limit} 像素` : null,
    sr.scene ? `场景：${SR_SCENE_LABELS[sr.scene] || sr.scene}` : null,
    sr.tool_version === 'professional' ? '专业模式' : '标准模式',
    sr.fps ? `${sr.fps} 帧/秒` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

type Entry = [name: string, value: ReactNode, wide?: boolean];
const present = ([, value]: Entry) => value != null && value !== '' && value !== false;

// 详情右边「生成参数」那一组：一格一项，名称在上、取值在下。第三个值为 true 的独占一行。
// 型号名长，挤在一格里会从中间断行，所以「模型」独占一行。
function paramsOf(item: HistoryItem): Entry[] {
  const p = item.payload || {};
  // 工作流的参数是按规则填的，名字也按规则写成人话；素材在「参考素材」里看。
  if (item.provider === 'autodl') {
    const rules = item.workflow?.rules || {};
    const fields = Object.entries(p)
      .filter(([key]) => !/^(image|video|audio)$/.test(rules[key]?.type || ''))
      .map(([key, value]): Entry => [ruleLabel(rules[key] || { type: 'string' }, key), typeof value === 'boolean' ? (value ? '开' : '关') : String(value)]);
    return [['工作流', item.model, true], ...fields];
  }
  // 用了技能的记录：提示词是扩写出来的，这里标出用的是哪个技能、用户原来写的是什么。
  const skill: Entry[] = item.form?.skill ? [['技能', item.form.skill.name], ['原始输入', item.form.prompt, true]] : [];
  if (item.kind === 'image') return [['模型', item.model, true], ['画面比例', p.aspect_ratio], ['分辨率', p.resolution], ['画质', p.quality ? IMAGE_QUALITY_LABELS[p.quality] || p.quality : null], ...skill];
  if (item.tool === 'speech') return [['模型', item.model, true], ['音色', p.voice_name || p.voice_id]];
  if (item.tool === 'sfx') {
    return [['模型', item.model, true], ['时长', p.duration_seconds ? `${p.duration_seconds} 秒` : '自动'], ['提示词相关性', p.prompt_influence]];
  }
  if (item.tool === 'music') return [['模型', item.model, true], ['时长', p.duration_seconds && `${Math.round(p.duration_seconds * 10) / 10} 秒`]];
  const ratio = p.ratio || p.aspect_ratio;
  return [
    ['模式', modeOf(item)],
    ['模型', item.model, true],
    ['分辨率', p.resolution],
    ['画面比例', ratio === 'adaptive' ? '自适应' : ratio],
    ['时长', p.duration === -1 ? '自动' : p.duration && `${p.duration} 秒`],
    ['生成有声视频', p.generate_audio === undefined ? null : p.generate_audio ? '开' : '关'],
    ['水印', p.watermark === undefined ? null : p.watermark ? '开' : '关'],
    ['随机种子', p.seed],
    ['联网搜索', p.web_search ? '开' : null],
    ['输入模式', p.input_type],
    ['画质超分', describeSuperResolution(p.super_resolution_config), true],
    ...skill,
  ];
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="detail-section">
      <header className="detail-section-head">
        <h3>{title}</h3>
        {action}
      </header>
      {children}
    </section>
  );
}

// 详情里上一条、下一条走的那一组记录：从哪个列表点开的，就在哪个列表里走。
type Scope = () => HistoryItem[];

// 详情弹窗里的内容。弹窗开着的时候可以直接换到上一条、下一条，不用关掉再点另一张。
function DetailView({ id, scope, close }: { id: string; scope: Scope; close: () => void }) {
  useStore('history');
  const [current, setCurrent] = useState(id);
  const list = scope();
  const index = list.findIndex((i) => i.id === current);
  const item = list[index] || state.history.find((i) => i.id === current);
  const step = (by: number) => {
    const next = list[index + by];
    if (index < 0 || !next) return;
    stopPlaying();
    setCurrent(next.id);
  };
  // 上下方向键也能换。正在输入框里、或者上面还盖着别的弹窗和菜单时不管。
  const stepRef = useRef(step);
  stepRef.current = step;
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as Element).closest?.('input, textarea, [contenteditable], [role=menu]')) return;
      const modals = document.querySelectorAll('.modal');
      if (modals[modals.length - 1] !== root.current?.closest('.modal') || document.querySelector('.menu')) return;
      e.preventDefault();
      stepRef.current(e.key === 'ArrowUp' ? -1 : 1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  // 这条记录被删掉了，详情也就没有可看的了。
  useEffect(() => {
    if (!item) close();
  }, [item]);
  if (!item) return null;
  const nav = (by: number, label: string) => (
    <button className={`icon-btn detail-nav-btn ${by < 0 ? 'is-prev' : ''}`} type="button" aria-label={label} disabled={index < 0 || !list[index + by]} onClick={() => step(by)} {...tip(label)}>
      <Icon name="chevron" size={18} />
    </button>
  );
  return (
    <div ref={root} className="detail">
      <Detail key={item.id} item={item} close={close} nav={<div className="detail-nav">{nav(-1, '上一条')}{nav(1, '下一条')}</div>} />
    </div>
  );
}

function Detail({ item, close, nav }: { item: HistoryItem; close: () => void; nav: ReactNode }) {
  const refs = refsOf(item);
  const kindLabel = KIND_LABELS[item.kind];
  const params = paramsOf(item).filter(present);
  // 任务信息：一行一项。
  const facts = (
    [
      ['状态', STATUS_LABELS[item.status] || item.status],
      ['失败原因', item.error && explainFailure(item.error.message)],
      // 平台的原话：排查、找平台客服时用。老记录没有单独存，原因里拼着的就是。
      ['平台返回', item.error && (item.error.detail || (explainFailure(item.error.message) !== item.error.message ? item.error.message : item.error.code))],
      [
        '任务 ID',
        <span className="mono copyable" {...tip('点击复制')} onClick={() => copyText(item.id, '已复制任务 ID')}>
          {item.id}
        </span>,
      ],
      ['提交时间', fmtTime(item.createdAt)],
      ['生成耗时', item.completedAt && item.createdAt ? fmtDuration(item.completedAt - item.createdAt) : null],
      // 成员看到的是这一条扣了多少积分，用量和折成元的费用只给管理员。
      ...(usesCredits()
        ? ([['积分', item.credits ? fmtCredits(item.credits.charged) : null]] as Entry[])
        : ([ 
            ['Token 用量', item.usage?.total_tokens != null ? String(item.usage.total_tokens) : null],
            ['计费字符', item.usage?.text_words != null ? String(item.usage.text_words) : null],
            ['费用', item.usage?.cost_usd != null ? `约 $${item.usage.cost_usd.toFixed(2)}` : fmtCost(estimateCost(item))],
          ] as Entry[])),
      [`${kindLabel}文件`, item.status !== 'completed' ? null : item.savedLocally ? `已保存${item.fileSize ? `（${fmtBytes(item.fileSize)}）` : ''}` : item.downloadError ? `保存失败：${item.downloadError}` : '保存中…'],
    ] as Entry[]
  ).filter(present);

  // 关掉详情再去做下一件事。
  const leaveTo = (label: string, action: (item: HistoryItem) => void) => (
    <button
      className="btn"
      onClick={() => {
        close();
        action(item);
      }}
    >
      {label}
    </button>
  );

  // 能对这条结果做的事，放在右边最下面。
  const actions = (
    <div className="detail-actions">
      {done(item) && (
        <a className="btn btn-primary" rel="noopener" {...downloadProps(item)}>
          下载{kindLabel}
        </a>
      )}
      {/* 失败的：「重新生成」是主按钮，占下载的位置。 */}
      {canRetry(item) && (
        <button className="btn btn-primary" type="button" onClick={() => (close(), retry(item))}>
          重新生成
        </button>
      )}
      {leaveTo('复用参数', reuse)}
      {done(item) && item.kind === 'video' && item.savedLocally && (
        <button className="btn" type="button" onClick={() => openVideoEditor(item.mediaUrl!, nameOf(item), { reload: () => loadHistory() })}>
          剪辑
        </button>
      )}
      {done(item) && item.kind === 'video' && (item.extraFiles?.length || 0) > 0 && (
        <button className="btn" type="button" onClick={() => downloadAll(item)}>
          下载全部（{(item.extraFiles?.length || 0) + 1} 个）
        </button>
      )}
      {done(item) && item.kind === 'video' && item.provider !== 'autodl' && leaveTo('配乐', score)}
      {done(item) && item.kind === 'image' && item.provider !== 'autodl' && leaveTo('生成视频', animate)}
      {isTimedOutTask(item) && leaveTo('重新查询', recheck)}
      {!item.savedLocally && item.status === 'completed' && !item.direct && (
        <button className="btn" onClick={() => refresh(item).then(() => toast('已重新尝试保存', 'info'))}>
          重新保存
        </button>
      )}
    </div>
  );

  return (
    <>
      {/* 左边：结果。这一块的大小是固定的；视频和图片在里面按自己的比例尽量放大，四周不垫底色。 */}
      <div className={`detail-media ${item.kind === 'audio' && done(item) ? 'is-audio' : ''}`}>
        <MediaBox item={item} large />
      </div>
      {nav}
      {/* 右边：上面是信息，分成几组，放不下就在这一栏里滚动；下面是能对它做的事。以前的配乐没有提示词，就没有第一组。 */}
      <div className="detail-side">
        <div className="detail-info">
          {(item.tool !== 'music' || item.prompt) && (
            <Section
              title={item.tool === 'speech' ? '朗读文本' : '提示词'}
              action={
                item.prompt && (
                  <button className="entry-action-btn" type="button" onClick={() => copyText(item.prompt!, '已复制')}>
                    复制
                  </button>
                )
              }
            >
              <p className="detail-prompt">{item.prompt || '（无提示词）'}</p>
            </Section>
          )}
          {refs.length > 0 && (
            <Section title="参考素材">
              <div className="card-refs">
                {refs.map((r) => (
                  <span key={r.uid} className="mini-thumb" {...tip(r.name)} aria-label={r.name}>
                    <Thumb thumb={r.thumb} kind={r.kind} />
                  </span>
                ))}
              </div>
            </Section>
          )}
          <Section title="生成参数">
            <dl className="param-grid">
              {params.map(([name, value, wide]) => (
                <div key={name} className={wide ? 'param wide' : 'param'}>
                  <dt>{name}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </Section>
          <Section title="任务信息">
            <dl className="kv">
              {facts.flatMap(([name, value]) => [<dt key={`${name}-name`}>{name}</dt>, <dd key={`${name}-value`}>{value}</dd>])}
            </dl>
          </Section>
        </div>
        {actions}
      </div>
    </>
  );
}

export function openDetail(id: string, scope: Scope = () => state.history) {
  if (!state.history.some((i) => i.id === id)) return;
  // 详情盖住了列表，先停掉列表里正在放的。详情是图片、或者自动播放被浏览器拦下时，没有新的播放来顶掉它。
  stopPlaying();
  const modal = openModal({ title: '生成详情', size: 'detail', content: <DetailView id={id} scope={scope} close={() => modal.close()} /> });
}

// ---------- 两处列表 ----------

// 创作页输入框下面：只列当前这种内容最新的几条，刚提交的任务在这里看进度。上面切换类型，这里跟着换。
export function Recent() {
  useStore('history', 'createType');
  const type = state.createType;
  const list = state.history.filter((item) => typeOf(item) === type && !fromCanvas(item));
  const feed = useRef<HTMLElement>(null);
  // 打开页面时排在问句、输入框之后进场。
  useLayoutEffect(() => {
    enter(feed.current, { y: 12, duration: 420, delay: 270 });
  }, []);
  return (
    <section ref={feed} className="feed">
      <header className="feed-head">
        <h2>最近生成</h2>
        <button
          className="entry-action-btn"
          type="button"
          hidden={list.length <= RECENT_COUNT}
          onClick={() => {
            state.recordsType = type;
            state.recordsSource = 'create';
            emit('recordsType');
            goTo('records');
          }}
        >
          查看全部 {list.length} 条
        </button>
      </header>
      <CardGrid
        list={list.slice(0, RECENT_COUNT)}
        all={list}
        empty={
          <div className="empty">
            <div className="empty-title">{state.historyLoaded ? `暂无${TYPE_LABELS[type]}` : '加载中…'}</div>
          </div>
        }
      />
    </section>
  );
}

// 记录页的类型筛选，和创作页输入框上方的切换是同一组。
const TYPE_FILTERS = [{ value: 'all' as const, label: '全部' }, ...(Object.keys(TYPE_LABELS) as CreateType[]).map((value) => ({ value, label: TYPE_LABELS[value] }))];

// 记录页的来源切换：创作页生成的和画布里生成的分开看。
const SOURCE_FILTERS = [
  { value: 'create' as const, label: '创作' },
  { value: 'canvas' as const, label: '画布' },
];

// 「创作记录」页：全部记录，可以按类型筛选、按提示词搜索。
export function Records() {
  useStore('history', 'recordsType', 'recordsSource');
  const [query, setQuery] = useState('');
  const type = state.recordsType;
  const source = state.recordsSource;
  const from = state.history.filter((item) => fromCanvas(item) === (source === 'canvas'));
  const list = from.filter((item) => (type === 'all' || typeOf(item) === type) && (!query || (item.prompt || '').toLowerCase().includes(query)));
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>创作记录</h1>
        </div>
      </header>
      <div className="page-tools">
        <div className="filter-group">
          <Segmented
            options={SOURCE_FILTERS}
            value={source}
            onChange={(next) => {
              state.recordsSource = next;
              emit('recordsSource');
            }}
            className="filters"
          />
          <Segmented
            options={TYPE_FILTERS}
            value={type}
            onChange={(next) => {
              state.recordsType = next;
              emit('recordsType');
            }}
            className="filters"
          />
        </div>
        {/* 一条都没有时没什么可搜的，不放搜索。 */}
        {(from.length > 0 || query) && <SearchBox label="搜索提示词" onQuery={setQuery} />}
      </div>
      <CardGrid
        list={list}
        empty={
          <div className="empty">
            <div className="empty-title">{!state.historyLoaded ? '加载中…' : from.length ? '无匹配记录' : source === 'canvas' ? '暂无画布记录' : '暂无创作记录'}</div>
          </div>
        }
      />
    </div>
  );
}
