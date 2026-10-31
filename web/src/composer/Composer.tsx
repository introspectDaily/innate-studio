// 创作输入框：上面选要生成什么（视频、图片、语音、音效、配乐），框里左边是素材、右边是提示词，下面一排工具栏，右下角提交。
// 状态和动作在 state.ts。

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { state, useStore, KINDS, goTo, loadCharacters, canManage, usesCredits, modelOption, loadFlows } from '../store.ts';
import { IMAGE_QUALITY_LABELS, modelLabel, modelNote, REFERENCE_MODE_LABEL, SPEECH_MODEL, AUDIO_MODEL } from '../../../shared/models.ts';
import { ruleKind, ruleLabel, type InputRule } from '../../../shared/autodl.ts';
import { musicSeconds } from '../request.ts';
import { Icon, type IconName } from '../ui/Icon.tsx';
import { Segmented, Slider, Toggle, Dropdown, FormRow, tip, clipTip } from '../ui/controls.tsx';
import { openPopover, openMenu, openModal, toast } from '../ui/layers.tsx';
import { enter, enterEach, reducedMotion, useOnChange, EASE_OUT } from '../ui/motion.ts';
import { Thumb, openAssetPicker } from '../assets.tsx';
import { MediaTile, AddTile } from '../ui/tiles.tsx';
import { openAdmin } from '../settings.tsx';
import { fmtCredits } from '../format.ts';
import { SkillPanel } from '../skills.tsx';
import type { FlowSummary, Kind, Ref, VideoForm } from '../types.ts';
import {
  composer, RATIOS,
  TYPES, typeOf, draftPrompt, specOf, hasLastFrame, imageRatios, imageSizes, imageQualities, imageRefLimit, currentCredits, submitProblem,
  update, setMode, swapFrames, updateStudio, setType, typePrompt, polish, undoPolish, submit, registerPrompt,
  voiceName, voiceNote, togglePreview, setVoiceFilter, pickVoice, stopPreview, useCharacter, activeSkill, setSkill,
  addableKinds, mediaRoom, usedMediaUrls, addMedia, addFiles, dismissSubmitError,
  flowDefinition, flowSlots, flowPrimaryKey, pickFlow, setFlowValue, setFlowRef, loadFlowDefinition,
} from './state.ts';

type Mode = { value: VideoForm['mode']; label: string; icon: IconName; note: string };
const REFERENCE_MODE: Mode = { value: 'reference', label: REFERENCE_MODE_LABEL, icon: 'layers', note: '参考素材可选' };
const FRAMES_MODE: Mode = { value: 'frames', label: '首尾帧', icon: 'frames', note: '尾帧可选' };
// 只能给首帧、不能给尾帧的模型，第二种方式叫「图生视频」。
const FIRST_FRAME_MODE: Mode = { value: 'frames', label: '图生视频', icon: 'frames', note: '以图片为首帧' };
// 当前模型能用的生成方式。默认是全能参考，它不加素材就是文生视频，所以不单列「文生视频」。
function modesFor() {
  const { frames } = specOf();
  return [REFERENCE_MODE, ...(frames.includes('first_frame') ? [frames.includes('last_frame') ? FRAMES_MODE : FIRST_FRAME_MODE] : [])];
}
// 和官方提示词里指代素材的叫法一致：图片1、视频1、音频1。缩略图上不写，鼠标停上去的提示里有。
const REF_PREFIX: Record<Kind, string> = { image: '图片', video: '视频', audio: '音频' };

const IMAGE_COUNTS = [1, 2, 3, 4];
const SFX_DURATIONS = [1, 2, 3, 5, 8, 10, 15, 20];
const MUSIC_DURATIONS = [15, 30, 60, 90, 120];

// ---------- 参考素材 ----------

// 输入框里的一份素材。name 是它在提示词里的叫法（图片1）或者它的位置（首帧），悬停时和文件名一起显示；tag 是写在底边的那行小字。
function RefTile({ item, name, tag, onRemove, depth, style }: { item: Ref; name?: string; tag?: string; onRemove: () => void; depth?: number; style?: CSSProperties }) {
  return (
    <MediaTile tag={tag} tipText={name ? `${name}：${item.name}` : item.name} onRemove={onRemove} style={style} data={{ 'data-ref': name, 'data-depth': depth }}>
      <Thumb thumb={item.thumb} kind={item.kind} />
    </MediaTile>
  );
}

// 张数不固定的素材（参考素材、参考图）叠成一摞，最新加的在最上面，「+」压在右下角；一份都没有时就是一个加号格子。鼠标停在这一摞上（或用键盘走到里面）就摊开，每份都能单独移除。
const STACK_COLS = 5;
const STACK_OPEN_DELAY = 120;
function RefStack({ items, add }: { items: { ref: Ref; label: string; onRemove: () => void }[]; add?: { label: string; tip: string; onClick: () => void } }) {
  const root = useRef<HTMLDivElement>(null);
  const timer = useRef(0);
  const [open, setOpen] = useState(false);
  const multi = items.length > 1;
  const expanded = open && multi;
  // 鼠标只是路过去点「+」时不摊开，所以等一小会儿。
  const openSoon = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), STACK_OPEN_DELAY);
  };
  const close = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // 触屏上没有「鼠标移开」，点别处收起。
  useEffect(() => {
    if (!expanded) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [expanded]);

  const slots = items.length + (add ? 1 : 0);
  const vars = {
    '--cols': Math.min(slots, STACK_COLS),
    '--rows': Math.ceil(slots / STACK_COLS),
    '--ax': items.length % STACK_COLS,
    '--ay': Math.floor(items.length / STACK_COLS),
  } as CSSProperties;
  return (
    <div
      ref={root}
      className={`ref-row ref-stack ${multi ? 'is-multi' : ''} ${expanded ? 'is-open' : ''}`}
      style={vars}
      onMouseLeave={close}
      onFocus={(e) => !e.target.closest('.ref-add') && setOpen(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && close()}
      onClick={(e) => (e.target as Element).closest('.ref-tile') && setOpen(true)}
    >
      {items.length === 0 && add && <AddTile label={add.label} tipText={add.tip} onClick={add.onClick} />}
      {items.map(({ ref, label, onRemove }, i) => (
        <div key={ref.uid} className="ref-stack-item" onMouseEnter={openSoon}>
          <RefTile
            item={ref}
            name={label}
            onRemove={onRemove}
            depth={Math.min(items.length - 1 - i, 3)}
            style={{ '--x': i % STACK_COLS, '--y': Math.floor(i / STACK_COLS), zIndex: i + 1 } as CSSProperties}
          />
        </div>
      ))}
      {items.length > 0 && add && <AddTile dot label={add.label} tipText={add.tip} onClick={add.onClick} />}
    </div>
  );
}

// 有固定位置的素材（首帧、尾帧、待配乐视频）：一个位置一个格子，和参考素材是同一种。有就显示缩略图，底边写着它是什么；没有就是加号，下面写着这里放什么。
function Slot({ item, name, tag, addLabel, onAdd, onRemove }: { item: Ref | null; name: string; tag?: string; addLabel?: string; onAdd: () => void; onRemove: () => void }) {
  return <div className="frame-slot">{item ? <RefTile item={item} name={name} tag={tag || name} onRemove={onRemove} /> : <AddTile label={addLabel || `添加${name}`} caption={name} onClick={onAdd} />}</div>;
}

function MediaBlock() {
  const { form, studio } = composer;
  const type = studio.type;
  if (type === 'flow') return <FlowMedia />;
  const imageRefs = type === 'image' ? imageRefLimit() : 0;
  const hidden = !(type === 'music' || (type === 'video' && form.mode !== 'text') || imageRefs > 0);
  // 加进来的素材都交给 addMedia：放哪、同一份加没加过、满没满，和拖入、粘贴是同一套规则。
  const pick = (ref: Ref, slot?: 'first' | 'last') => {
    const refused = addMedia(ref, slot);
    if (refused) toast(refused, 'info');
  };
  let content: ReactNode = null;

  if (hidden) {
    content = null;
  } else if (type === 'image') {
    // 图生图：这个模型收几张参考图，就能加几张。
    const refs = studio.image.refs || [];
    const setRefs = (next: Ref[]) => updateStudio('image', { refs: next });
    const addImage = () => openAssetPicker({ title: '添加参考图', kind: 'image', remaining: imageRefs - refs.length, usedUrls: usedMediaUrls(), onPick: pick });
    content = (
      <RefStack
        items={refs.map((ref, i) => ({ ref, label: `图片${i + 1}`, onRemove: () => setRefs(refs.filter((r) => r.uid !== ref.uid)) }))}
        add={refs.length < imageRefs ? { label: '添加参考图', tip: '添加参考图', onClick: addImage } : undefined}
      />
    );
  } else if (type === 'music') {
    const video = studio.music.video;
    // 要配的视频可以不给。给了，音乐就和它一样长，生成完在详情里和画面一起放。
    content = (
      <div className="frames-row">
        <Slot
          item={video}
          name="待配乐视频"
          addLabel="添加待配乐视频（可选）"
          tag={video?.duration ? `${Math.round(video.duration)} 秒` : '视频'}
          onAdd={() => openAssetPicker({ title: '添加待配乐视频', kind: 'video', sources: ['records', 'upload'], onPick: pick })}
          onRemove={() => updateStudio('music', { video: null })}
        />
      </div>
    );
  } else if (form.mode === 'frames') {
    const frame = (key: 'first' | 'last', name: string, addLabel: string) => (
      <Slot
        item={form.frames[key]}
        name={name}
        addLabel={addLabel}
        onAdd={() => openAssetPicker({ title: `添加${name}`, kind: 'image', remaining: 1, usedUrls: usedMediaUrls(), onPick: (ref) => pick(ref, key) })}
        onRemove={() => update({ frames: { ...composer.form.frames, [key]: null } })}
      />
    );
    // 有的模型只有首帧。
    content = (
      <div className="frames-row">
        {frame('first', '首帧', '添加首帧')}
        {hasLastFrame() && (
          <>
            <button className="icon-btn icon-btn-sm frames-swap" type="button" aria-label="互换首帧和尾帧" disabled={!form.frames.first && !form.frames.last} onClick={swapFrames} {...tip('互换首帧和尾帧')}>
              <Icon name="swap" />
            </button>
            {frame('last', '尾帧', '添加尾帧（可选）')}
          </>
        )}
      </div>
    );
  } else {
    const kinds = Object.keys(KINDS) as Kind[];
    const setList = (kind: Kind, next: Ref[]) => update({ refs: { ...composer.form.refs, [kind]: next } });
    // 三种素材共用一个「+」，不用先选类型：上传的、选中的是什么就放进哪一类。
    const addable = addableKinds();
    const addRef = () => openAssetPicker({ title: '添加参考素材', limits: mediaRoom(), usedUrls: usedMediaUrls(), onPick: pick });
    const full = addable.every((kind) => form.refs[kind].length >= KINDS[kind].max);
    content = (
      <RefStack
        items={kinds.flatMap((kind) =>
          form.refs[kind].map((ref, i) => ({ ref, label: `${REF_PREFIX[kind]}${i + 1}`, onRemove: () => setList(kind, composer.form.refs[kind].filter((r) => r.uid !== ref.uid)) })),
        )}
        add={full ? undefined : { label: '添加参考素材', tip: `添加参考素材：${addable.map((kind) => KINDS[kind].label).join('、')}`, onClick: addRef }}
      />
    );
  }

  return (
    <div className="media-block" hidden={hidden}>
      {content}
    </div>
  );
}

// ---------- 工具栏 ----------

// 比例的形状示意：按 "宽:高" 画一个小方框，写不成比例的（自适应）画虚线框。
function RatioShape({ value }: { value: string }) {
  const [w, h] = String(value).split(':').map(Number);
  if (!w || !h) return <span className="ratio-shape ratio-auto" />;
  const scale = 14 / Math.max(w, h);
  return <span className="ratio-shape" style={{ width: Math.max(6, Math.round(w * scale)), height: Math.max(6, Math.round(h * scale)) }} />;
}

// 工具栏上打开一块面板的按钮。面板贴着按钮显示，里面的内容自己跟着状态变。
function PanelButton({ name, label, ariaLabel, className, panel, onClose, children }: { name: string; label: string; ariaLabel?: string; className: string; panel: (close: () => void) => ReactNode; onClose?: () => void; children: ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={ref}
      className="dropdown dropdown-tool"
      type="button"
      data-control={name}
      aria-haspopup="dialog"
      aria-expanded="false"
      aria-label={ariaLabel || label}
      onClick={() => {
        const layer = openPopover(ref.current!, <div className="popover-body">{panel(() => layer?.close())}</div>, { className, label, onClose });
      }}
    >
      {children}
    </button>
  );
}

function VideoToolbar() {
  const { form } = composer;
  const modes = modesFor();
  const can = specOf();
  const mode = modes.find((m) => m.value === form.mode) || modes[0];
  const ratio = RATIOS.find((r) => r.value === form.ratio) || RATIOS[0];
  const models = state.models.includes(form.model) ? state.models : [form.model, ...state.models];
  const duration = form.durationAuto ? '时长自动' : `${form.duration} 秒`;
  return (
    <>
      <Dropdown
        key="mode"
        variant="tool"
        control="mode"
        icon={mode.icon}
        label="生成方式"
        value={form.mode}
        options={modes.map((m) => ({ value: m.value, label: m.label, note: m.note }))}
        onChange={(value) => setMode(value as VideoForm['mode'])}
      />
      <Dropdown key="model" variant="tool" control="model" icon="cube" label="模型" value={form.model} options={models.map((m) => modelOption(m, modelLabel(m), modelNote(m)))} onChange={(model) => update({ model })} />
      <PanelButton key="frame" name="frame" label="画面" ariaLabel={`画面：${ratio.label}，${form.resolution}`} className="frame-popover" panel={() => <FramePanel />}>
        <span className="ratio-box">
          <RatioShape value={form.ratio} />
        </span>
        <span>{`${ratio.label} · ${form.resolution}`}</span>
      </PanelButton>
      <PanelButton key="duration" name="duration" label="时长" ariaLabel={`时长：${duration}`} className="duration-popover" panel={() => <DurationPanel />}>
        <Icon name="clock" />
        <span>{duration}</span>
      </PanelButton>
      {/* 「更多」里的设置这个模型一项也用不上时，不显示入口。 */}
      {(can.audio || can.seed) && (
        <PanelButton key="more" name="more" label="更多设置" className="more-popover" panel={() => <MorePanel />}>
          <Icon name="sliders" />
          <span>更多</span>
        </PanelButton>
      )}
    </>
  );
}

// 图片的画面：模型分几档分辨率时，点开是一块面板，比例和分辨率放在一起；不分档时只是一个比例菜单。
function ImageRatioButton() {
  const ref = useRef<HTMLButtonElement>(null);
  // 只列当前模型收的比例；它一个都不收就不显示这个入口。
  const ratios = imageRatios().map((value) => ({ value, label: value }));
  const ratio = ratios.find((r) => r.value === composer.studio.image.ratio) || ratios[0];
  const { resolution } = composer.studio.image;
  if (!ratio) return null;
  const shape = (
    <span className="ratio-box">
      <RatioShape value={ratio.value} />
    </span>
  );
  if (imageSizes().length && resolution) {
    return (
      <PanelButton name="frame" label="画面" ariaLabel={`画面：${ratio.label}，${resolution}`} className="frame-popover" panel={() => <ImageFramePanel />}>
        {shape}
        <span>{`${ratio.label} · ${resolution}`}</span>
      </PanelButton>
    );
  }
  return (
    <button
      ref={ref}
      className="dropdown dropdown-tool"
      type="button"
      data-control="ratio"
      aria-haspopup="listbox"
      aria-expanded="false"
      aria-label={`画面比例：${ratio.label}`}
      onClick={() => openMenu(ref.current!, { label: '画面比例', items: ratios.map((r) => ({ ...r, selected: r === ratio })), onSelect: (value) => updateStudio('image', { ratio: value }) })}
    >
      {shape}
      <span>{ratio.label}</span>
    </button>
  );
}

function ImageFramePanel() {
  useStore('composer');
  const { ratio, resolution, quality } = composer.studio.image;
  const ratios = imageRatios();
  const qualities = imageQualities();
  return (
    <>
      <div className="popover-title">画面比例</div>
      <div className="ratio-grid" role="radiogroup" aria-label="画面比例">
        {ratios.map((r) => (
          <button key={r} type="button" className={`ratio-option ${ratio === r ? 'active' : ''}`} role="radio" aria-checked={ratio === r} onClick={() => updateStudio('image', { ratio: r })}>
            <span className="ratio-box">
              <RatioShape value={r} />
            </span>
            <span>{r}</span>
          </button>
        ))}
      </div>
      <div className="popover-title">分辨率</div>
      <Segmented options={imageSizes().map((r) => ({ value: r, label: r }))} value={resolution || ''} onChange={(next) => updateStudio('image', { resolution: next })} />
      {qualities.length > 0 && <div className="popover-title">画质</div>}
      {qualities.length > 0 && <Segmented options={qualities.map((q) => ({ value: q, label: IMAGE_QUALITY_LABELS[q] || q }))} value={quality || ''} onChange={(next) => updateStudio('image', { quality: next })} />}
    </>
  );
}

function ImageToolbar() {
  const sub = composer.studio.image;
  const known = state.catalog.image;
  const models = known.includes(sub.model) || !known.length ? known : [sub.model, ...known];
  return (
    <>
      <Dropdown key="image-model" variant="tool" control="model" icon="cube" label="模型" value={sub.model} options={(models.length ? models : [sub.model]).map((m) => modelOption(m, modelLabel(m)))} onChange={(model) => updateStudio('image', { model })} />
      <ImageRatioButton key="image-ratio" />
      <Dropdown key="count" variant="tool" control="count" icon="layers" label="数量" value={String(sub.count)} options={IMAGE_COUNTS.map((n) => ({ value: String(n), label: `${n} 张` }))} onChange={(value) => updateStudio('image', { count: Number(value) })} />
    </>
  );
}

// 语音、音效、配乐各只有一个模型，不能换，也照样写在工具栏里：点开是只有一项的菜单。
function FixedModel({ model }: { model: string }) {
  return <Dropdown key="fixed-model" variant="tool" control="model" icon="cube" label="模型" value={model} options={[{ value: model, label: modelLabel(model) }]} onChange={() => {}} />;
}

function SfxToolbar() {
  const sub = composer.studio.sfx;
  return (
    <>
      <FixedModel model={AUDIO_MODEL} />
      <Dropdown
        key="sfx-duration"
        variant="tool"
        control="duration"
        icon="clock"
        label="时长"
        value={String(sub.duration)}
        options={[{ value: 'auto', label: '自动', display: '时长自动' }, ...SFX_DURATIONS.map((d) => ({ value: String(d), label: `${d} 秒` }))]}
        onChange={(duration) => updateStudio('sfx', { duration })}
      />
    </>
  );
}

// 配乐多长：给了视频就跟着视频，不用选；没给就选一个。
function MusicToolbar() {
  const sub = composer.studio.music;
  if (sub.video) {
    return (
      <>
        <FixedModel model={AUDIO_MODEL} />
        <span className="composer-hint">{`时长跟随视频 · ${musicSeconds(sub)} 秒`}</span>
      </>
    );
  }
  return (
    <>
      <FixedModel model={AUDIO_MODEL} />
      <Dropdown key="music-duration" variant="tool" control="duration" icon="clock" label="时长" value={String(sub.duration)} options={MUSIC_DURATIONS.map((d) => ({ value: String(d), label: `${d} 秒` }))} onChange={(duration) => updateStudio('music', { duration: Number(duration) })} />
    </>
  );
}

function Toolbar() {
  const { studio } = composer;
  if (studio.type === 'flow') return <FlowToolbar />;
  if (studio.type === 'image') return <ImageToolbar />;
  if (studio.type === 'sfx') return <SfxToolbar />;
  if (studio.type === 'music') return <MusicToolbar />;
  if (studio.type === 'speech') {
    const name = studio.speech.voiceName;
    return (
      <>
      <FixedModel model={SPEECH_MODEL} />
      <PanelButton name="voice" label="音色" ariaLabel={`音色：${name || '未选择'}`} className="voice-popover" panel={(close) => <VoicePanel close={close} />} onClose={stopPreview}>
        <Icon name="user" />
        <span>{name || '选择音色'}</span>
      </PanelButton>
      </>
    );
  }
  return <VideoToolbar />;
}

// 「画面」面板：比例和分辨率放在一起。
function FramePanel() {
  useStore('composer');
  const { form } = composer;
  // 各模型的档位不一样（有的到 4k），直接列它支持的。
  const { resolutions, ratios } = specOf();
  return (
    <>
      <div className="popover-title">画面比例</div>
      <div className="ratio-grid" role="radiogroup" aria-label="画面比例">
        {RATIOS.map((r) => (
          <button key={r.value} type="button" className={`ratio-option ${form.ratio === r.value ? 'active' : ''}`} role="radio" aria-checked={form.ratio === r.value} disabled={!ratios.includes(r.value)} onClick={() => update({ ratio: r.value })}>
            <span className="ratio-box">
              <RatioShape value={r.value} />
            </span>
            <span>{r.label}</span>
          </button>
        ))}
      </div>
      <div className="popover-title">分辨率</div>
      <Segmented options={resolutions.map((r) => ({ value: r, label: r }))} value={form.resolution} onChange={(resolution) => update({ resolution })} />
      {form.mode === 'frames' && <div className="small muted">画面比例跟随首帧</div>}
    </>
  );
}

// 「时长」面板：一条带刻度的滑杆加一个数字框。有的模型能选 4 到 30 秒，一秒一项列成菜单太长。
function DurationPanel() {
  useStore('composer');
  const { form } = composer;
  const { durations, autoDuration } = specOf();
  const min = durations[0];
  const max = durations[durations.length - 1];
  // 槽从 0 画起，每 5 秒一个刻度。
  const marks = Array.from({ length: Math.floor(max / 5) + 1 }, (_, i) => i * 5);
  // 数字框里正在打的字。打到一半的（比如想输 12 先打了 1）不在范围里，先留在框里不生效。
  const [draft, setDraft] = useState<string | null>(null);
  const type = (text: string) => {
    setDraft(text);
    const seconds = Number(text);
    if (Number.isInteger(seconds) && seconds >= min && seconds <= max) update({ durationAuto: false, duration: seconds });
  };
  return (
    <>
      <div className="popover-title">时长</div>
      <div className="duration-row">
        <Slider label="时长" from={0} min={min} max={max} marks={marks} value={form.duration} disabled={form.durationAuto} onChange={(duration) => (setDraft(null), update({ duration }))} />
        <label className="input duration-field">
          <input type="number" inputMode="numeric" min={min} max={max} step="1" value={draft ?? String(form.duration)} disabled={form.durationAuto} aria-label="时长（秒）" onChange={(e) => type(e.target.value)} onBlur={() => setDraft(null)} />
          <span>秒</span>
        </label>
      </div>
      {autoDuration && (
        <FormRow label="自动时长">
          <Toggle checked={form.durationAuto} onChange={(durationAuto) => update({ durationAuto })} label="时长由模型决定" />
        </FormRow>
      )}
    </>
  );
}

// 面板里的数字输入框。值由用户打字决定，所以只给初始值，不在重画时覆盖。
function NumberInput({ value, onInput, inputRef, ...attrs }: { value: string | number; onInput: (value: string) => void; inputRef?: React.Ref<HTMLInputElement> } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onInput' | 'value'>) {
  return <input ref={inputRef} className="input" type="number" inputMode="numeric" defaultValue={String(value ?? '')} onInput={(e) => onInput(e.currentTarget.value)} {...attrs} />;
}

// 「更多」面板：不常改的设置都收在这里。
function MorePanel() {
  useStore('composer');
  const { form } = composer;
  const can = specOf();
  const seedInput = useRef<HTMLInputElement>(null);
  const randomSeed = () => {
    const seed = String(Math.floor(Math.random() * 2147483647));
    seedInput.current!.value = seed;
    update({ seed });
  };
  return (
    <>
      {can.audio && <div className="popover-title">输出</div>}
      {can.audio && (
        <FormRow label="生成有声视频">
          <Toggle checked={form.generateAudio} onChange={(generateAudio) => update({ generateAudio })} label="生成有声视频" />
        </FormRow>
      )}
      {can.seed && <div className="popover-title">高级</div>}
      {can.seed && (
        <FormRow label="随机种子">
          <div className="row">
            <NumberInput inputRef={seedInput} value={form.seed} onInput={(seed) => update({ seed })} placeholder="留空则每次随机" step="1" aria-label="随机种子" />
            <button className="btn" type="button" onClick={randomSeed}>
              随机
            </button>
          </div>
        </FormRow>
      )}
    </>
  );
}

// 「音色」面板：按语言筛一下，每个音色可以先试听再选。
function VoicePanel({ close }: { close: () => void }) {
  useStore('composer');
  if (!state.voices) return <div className="empty small-empty">{composer.voicesError ? `音色加载失败：${composer.voicesError}` : '加载中…'}</div>;
  const match = { all: () => true, zh: (language: string) => language === 'zh', en: (language: string) => language === 'en', other: (language: string) => language !== 'zh' && language !== 'en' };
  // 有的平台只给音色的名字，不知道是什么语言，这时不显示按语言筛选的那一排。
  const languages = state.voices.some((voice) => voice.language);
  return (
    <>
      {/* 没有筛选的那一排时，补一个和其他菜单一样的小标题。 */}
      {!languages && <div className="popover-title voice-title">音色</div>}
      {languages && <Segmented
        options={[
          { value: 'all', label: '全部' },
          { value: 'zh', label: '中文' },
          { value: 'en', label: '英语' },
          { value: 'other', label: '其他' },
        ]}
        value={composer.voiceFilter}
        onChange={setVoiceFilter}
      />}
      <div className="voice-list" role="listbox" aria-label="音色">
        {state.voices
          .filter((voice) => !languages || match[composer.voiceFilter](voice.language))
          .map((voice) => {
            const selected = voice.id === composer.studio.speech.voiceId;
            return (
              <div key={voice.id} className={`voice-row ${selected ? 'selected' : ''}`}>
                <button
                  className="voice-pick"
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    pickVoice(voice);
                    close();
                  }}
                >
                  <span className="voice-name">{voiceName(voice)}</span>
                  <span className="voice-note ellipsis" {...clipTip(voiceNote(voice))}>
                    {voiceNote(voice)}
                  </span>
                </button>
                {voice.previewUrl && (
                  <button className="entry-action-btn" type="button" onClick={() => togglePreview(voice)}>
                    {composer.previewing === voice.id ? '停止' : '试听'}
                  </button>
                )}
                <span className="menu-item-check">{selected && <Icon name="check" size={14} />}</span>
              </div>
            );
          })}
      </div>
    </>
  );
}

// 右下角：润色（有提示词的类型才有）和发送键。发送键不能提交时变淡，鼠标停上去或点一下都会说明原因。
// 输入框右下角的「角色」：点开是一张清单，选中就把这个角色的参考图带进输入框。清单每次点开时现读，在别的页面刚存的也在里面。
const MANAGE = '__manage';

async function pickCharacter(button: HTMLElement, type: 'image' | 'video') {
  const list = await loadCharacters().catch(() => []);
  const usable = list.filter((c) => c.images.length);
  openMenu(button, {
    label: '角色',
    align: 'end',
    items: [...usable.map((c) => ({ value: c.id, label: c.name, note: `${c.images.length} 张图` })), { value: MANAGE, label: usable.length ? '管理角色' : '新建角色' }],
    onSelect: (value) => {
      const character = usable.find((c) => c.id === value);
      if (!character) return goTo('characters');
      try {
        useCharacter(character, type);
        toast(`已添加角色「${character.name}」`, 'success');
      } catch (err) {
        toast((err as Error).message, 'error', 6000);
      }
    },
  });
}

// ---------- 工作流（AutoDL.art）----------
// 工作流沿用输入框里熟悉的样子：主文本（多数是提示词）写在中间的大文本框里，素材放左边的格子，
// 其余参数（时长、分辨率、模式、开关、数字）收进下面工具栏的「参数」面板，和视频的参数放法一致。
// 换工作流时主文本和素材留着（不同工作流大多是一套参数），只有规矩不同的那些按新规则重新对一遍。

const FLOW_KINDS: Record<string, Kind> = { image: 'image', video: 'video', audio: 'audio' };

// 挑选工作流：弹窗里列出目录（按最近一周的用量排），每个带封面、说明、必填的素材和起价。load=true 时先刷新一遍目录。
function pickWorkflow(load = false) {
  if (load) loadFlows(true);
  const list = state.flows.items;
  const body = (
    <div className="flow-picker">
      {list.length ? (
        <div className="pick-grid is-flows">
          {list.map((item: FlowSummary) => {
            const needs = (item.media || []).map((kind) => KINDS[kind].label).join('、');
            return (
              <button
                key={item.uuid}
                className={`pick-card ${composer.studio.flow.workflow?.uuid === item.uuid ? 'is-current' : ''}`}
                type="button"
                onClick={() => {
                  modal.close();
                  pickFlow(item.uuid);
                }}
              >
                <div className="pick-thumb">{item.cover ? <img className="thumb-img" src={item.cover} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <div className="thumb-fallback">{needs || '工作流'}</div>}</div>
                <div className="pick-name ellipsis">{item.name}</div>
                {item.description && <div className="pick-desc">{item.description}</div>}
                <div className="pick-badges">
                  <span className="badge badge-pending">{item.fromCredits != null ? `起 ${item.fromCredits} 积分` : '按量计费'}</span>
                  {needs && <span className="badge badge-ok">{needs}</span>}
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="empty small-empty">{state.flows.error || (state.flows.loaded ? '平台上还没有可用的工作流' : '读取工作流目录…')}</div>
      )}
    </div>
  );
  const modal = openModal({ title: state.flows.total ? `选择工作流（${state.flows.total} 个）` : '选择工作流', size: 'lg', content: body });
}

// 左边的素材：规则里每一条 image / video / audio 是一个格子。加一份、去掉一份都按字段名记。
function FlowMedia() {
  const { flow } = composer.studio;
  const media = (['image', 'audio', 'video'] as Kind[]).flatMap((kind) => flowSlots(kind));
  if (!media.length) return null;
  return (
    <div className="frames-row flow-media">
      {media.map(({ key, rule }) => {
        const kind = FLOW_KINDS[rule.type] || 'image';
        const ref = flow.refs[key] || null;
        const name = ruleLabel(rule, key);
        return (
          <Slot
            key={key}
            item={ref}
            name={name}
            tag={ref?.duration ? `${Math.round(ref.duration)} 秒` : KINDS[kind].label}
            addLabel={`添加${name}${rule.required ? '' : '（可选）'}`}
            onAdd={() => openAssetPicker({ title: `添加${name}`, kind, remaining: 1, usedUrls: usedMediaUrls(), onPick: (picked) => setFlowRef(key, picked) })}
            onRemove={() => setFlowRef(key, null)}
          />
        );
      })}
    </div>
  );
}

// 参数面板里的一行：左边名称和范围，右边控件。开关、下拉、数字、短文字各是一种。
function FlowRow({ fieldKey, name, rule, value }: { fieldKey: string; name: string; rule: InputRule; value: unknown }) {
  const kind = ruleKind(rule);
  const range = rule.type === 'integer' || rule.type === 'number' ? (rule.min !== undefined && rule.max !== undefined ? `${rule.min}–${rule.max}` : null) : rule.max_length && rule.max_length <= 64 ? `最多 ${rule.max_length} 字` : null;
  const desc = [rule.description, range].filter(Boolean).join(' · ') || undefined;
  if (kind === 'toggle') return <FormRow label={name} desc={desc}><Toggle checked={value === true} label={name} onChange={(checked) => setFlowValue(fieldKey, checked)} /></FormRow>;
  if (kind === 'select') {
    return (
      <FormRow label={name} desc={desc}>
        <Dropdown label={name} value={String(value ?? '')} options={(rule.options || []).map((option) => ({ value: option.label, label: option.label }))} onChange={(next) => setFlowValue(fieldKey, next)} chevron />
      </FormRow>
    );
  }
  if (kind === 'number') {
    return (
      <FormRow label={name} desc={desc}>
        <NumberInput value={String(value ?? '')} onInput={(text) => setFlowValue(fieldKey, text)} min={rule.min} max={rule.max} step={rule.step || (rule.type === 'integer' ? 1 : 0.01)} aria-label={name} />
      </FormRow>
    );
  }
  return (
    <FormRow label={name} desc={desc}>
      <input className="input" type="text" defaultValue={value == null ? '' : String(value)} maxLength={rule.max_length} aria-label={name} onInput={(e) => setFlowValue(fieldKey, e.currentTarget.value)} />
    </FormRow>
  );
}

// 页面刚打开、目录刚到：把上次选的工作流的规则取回来。
function useFlowDefinition() {
  const uuid = composer.studio.flow.workflow?.uuid || '';
  useEffect(() => {
    if (uuid && !flowDefinition()) loadFlowDefinition();
  }, [uuid]);
  useEffect(() => {
    loadFlows();
  }, []);
}

// 工具栏上的工作流菜单和三样常用参数：时长、分辨率、参数面板。参数按平台给的规则画，没选工作流时只有挑选入口。
function FlowToolbar() {
  useStore('flows');
  useFlowDefinition();
  const { flow } = composer.studio;
  const definition = flowDefinition();
  if (!flow.workflow) {
    const ready = state.flows.loaded || state.flows.hasKey === false;
    return (
      <>
        <button className="dropdown dropdown-tool" type="button" disabled={!state.app.autodl?.hasKey || !ready} onClick={() => pickWorkflow()}>
          <Icon name="workflow" />
          <span>{state.app.autodl?.hasKey ? (state.flows.loaded ? `工作流 · 共 ${state.flows.total} 个` : '读取工作流…') : '未配置 AutoDL.art 令牌'}</span>
        </button>
        {!state.app.autodl?.hasKey && canManage() && (
          <button className="entry-action-btn" type="button" onClick={openAdmin}>
            去配置
          </button>
        )}
      </>
    );
  }
  const items = state.flows.items;
  const known = items.some((item) => item.uuid === flow.workflow?.uuid);
  const options = [...(flow.workflow && !known ? [{ value: flow.workflow.uuid, label: flow.workflow.name }] : []), ...items.map((item) => ({ value: item.uuid, label: item.name, note: item.fromCredits != null ? `起 ${item.fromCredits} 积分` : undefined }))];
  const rules = definition?.input_rules || {};
  // 工具栏上只放时长和分辨率这种常改的；其余（模式、开关、种子、数字）在「参数」面板里。
  const durationKey = Object.keys(rules).find((key) => (key === 'duration' || key === 'audio_duration') && (rules[key].type === 'integer' || rules[key].type === 'number'));
  const resolutionKey = Object.keys(rules).find((key) => key === 'resolution' && rules[key].type === 'enum');
  const more = Object.entries(rules).filter(([key, rule]) => ruleKind(rule) !== 'media' && key !== durationKey && key !== resolutionKey && flowPrimaryKey() !== key);
  return (
    <>
      <Dropdown variant="tool" control="workflow" icon="workflow" label="工作流" value={flow.workflow.uuid} options={options.length ? options : [{ value: flow.workflow.uuid, label: flow.workflow.name }]} onChange={(uuid) => uuid && pickFlow(uuid)} />
      <button className="entry-action-btn" type="button" onClick={() => pickWorkflow(true)}>
        更换
      </button>
      {durationKey && (
        <PanelButton name="duration" label="时长" ariaLabel={`时长：${flow.values[durationKey] ?? ''}${rules[durationKey].max && rules[durationKey].max <= 15 ? ' 秒' : ''}`} className="duration-popover" panel={() => <FlowNumberPanel ruleKey={durationKey} />}>
          <Icon name="clock" />
          <span>{`${flow.values[durationKey] ?? ''}${rules[durationKey].max && rules[durationKey].max <= 15 ? ' 秒' : ''}`}</span>
        </PanelButton>
      )}
      {resolutionKey && <FlowSelectButton ruleKey={resolutionKey} />}
      {more.length > 0 && (
        <PanelButton name="more" label="参数" className="more-popover" panel={() => <FlowMorePanel fields={more} />}>
          <Icon name="sliders" />
          <span>参数</span>
        </PanelButton>
      )}
    </>
  );
}

// 「时长」面板：滑杆加数字框，范围和步长按规则来。
function FlowNumberPanel({ ruleKey }: { ruleKey: string }) {
  useStore('composer');
  const rule = flowDefinition()?.input_rules?.[ruleKey];
  const value = Number(composer.studio.flow.values[ruleKey]);
  if (!rule) return null;
  const min = rule.min ?? 0;
  const max = rule.max ?? min + 60;
  const name = ruleLabel(rule, ruleKey);
  const integer = rule.type === 'integer';
  const marks = Array.from({ length: Math.min(Math.floor(max - min) + 1, 16) }, (_, i) => Math.round(min + ((max - min) * i) / 15));
  return (
    <>
      <div className="popover-title">{name}</div>
      <div className="duration-row">
        <Slider label={name} min={min} max={max} marks={integer ? marks : []} value={value} onChange={(next) => setFlowValue(ruleKey, next)} />
        <label className="input duration-field">
          <input type="number" inputMode={integer ? 'numeric' : 'decimal'} min={min} max={max} step={rule.step || (integer ? 1 : 0.01)} value={String(composer.studio.flow.values[ruleKey] ?? '')} aria-label={name} onChange={(e) => setFlowValue(ruleKey, e.currentTarget.value)} />
          {rule.max != null && rule.max <= 15 && <span>秒</span>}
        </label>
      </div>
    </>
  );
}

// 分辨率这类枚举：工具栏上一个下拉，直接选。
function FlowSelectButton({ ruleKey }: { ruleKey: string }) {
  useStore('composer');
  const rule = flowDefinition()?.input_rules?.[ruleKey];
  if (!rule) return null;
  const name = ruleLabel(rule, ruleKey);
  return (
    <Dropdown
      variant="tool"
      control={ruleKey}
      icon="frames"
      label={name}
      value={String(composer.studio.flow.values[ruleKey] ?? '')}
      options={(rule.options || []).map((option) => ({ value: option.label, label: option.label }))}
      onChange={(next) => setFlowValue(ruleKey, next)}
    />
  );
}

// 「参数」面板：其余的参数一行一项，说明写在名称下面。
function FlowMorePanel({ fields }: { fields: [string, InputRule][] }) {
  useStore('composer');
  const { values } = composer.studio.flow;
  if (!fields.length) return <div className="muted small">这个工作流不用改别的参数。</div>;
  return (
    <>
      {fields.map(([key, rule]) => (
        <FlowRow key={key} fieldKey={key} name={ruleLabel(rule, key)} rule={rule} value={values[key]} />
      ))}
    </>
  );
}

function SendArea() {
  // 工作流用的是 AutoDL.art 的令牌，其余内容用的是火山方舟的 Key。
  const needsKey = composer.studio.type === 'flow' ? !state.app.autodl?.hasKey : !state.app.hasKey;
  if (needsKey) {
    // 多人模式下 Key 由管理员配，成员只能等。
    if (!canManage()) return <span className="composer-hint">服务暂未开通</span>;
    return (
      <button className="btn btn-primary btn-sm" type="button" onClick={openAdmin}>
        {composer.studio.type === 'flow' ? '设置 AutoDL.art 令牌' : '设置 API Key'}
      </button>
    );
  }
  const type = typeOf();
  const blocked = submitProblem();
  const { beforePolish, polishing, submitting, submitError } = composer;
  const canSkill = type.value === 'image' || type.value === 'video';
  const skill = activeSkill();
  const credits = currentCredits();
  return (
    <>
      {(type.value === 'image' || type.value === 'video') && (
        <button key="character" className="entry-action-btn" type="button" data-control="character" aria-haspopup="menu" aria-expanded="false" {...tip('使用角色')} onClick={(e) => pickCharacter(e.currentTarget, type.value as 'image' | 'video')}>
          角色
        </button>
      )}
      {canSkill && (
        <button
          key="skill"
          className={`entry-action-btn ${skill ? 'active' : ''}`}
          type="button"
          data-control="skill"
          aria-haspopup="dialog"
          aria-expanded="false"
          {...tip('按技能扩写提示词')}
          onClick={(e) => {
            const layer = openPopover(e.currentTarget, <div className="popover-body">{<SkillPanel close={() => layer?.close()} />}</div>, { className: 'skill-popover', label: '技能', align: 'end' });
          }}
        >
          技能
        </button>
      )}
      {/* 选了技能就不再润色：两件事都是让文本模型改写提示词。 */}
      {type.polish &&
        !skill &&
        state.catalog.polish.length > 0 &&
        (beforePolish !== null ? (
          <button key="undo" className="entry-action-btn" type="button" data-control="polish" onClick={undoPolish}>
            撤销润色
          </button>
        ) : (
          <button key="polish" className="entry-action-btn" type="button" data-control="polish" {...tip(type.value === 'speech' ? '润色朗读文本' : '润色提示词')} disabled={polishing} onClick={polish}>
            {polishing && <span className="spinner" />}
            润色
          </button>
        ))}
      {usesCredits() && credits != null && !blocked && <span key="credits" className="composer-hint">{`${type.value === 'video' ? '约 ' : ''}${fmtCredits(credits)}`}</span>}
      <button key="send" className={`send-btn ${blocked ? 'blocked' : ''}`} type="button" {...tip(blocked || submitError || `${type.action}（⌘ Enter）`)} aria-label={type.action} aria-disabled={blocked ? 'true' : undefined} disabled={submitting} onClick={submit}>
        <span className="icon-swap">
          <Icon name="arrowUp" size={18} shown={!submitting} />
          <span className="spinner" data-shown={submitting ? '' : undefined} />
        </span>
      </button>
    </>
  );
}

// 提交时被拒绝的原因：没有生成记录可以挂，就写在输入框下面。上面一行中文原因，下面一行平台的原话。
function SubmitNotice() {
  const ref = useRef<HTMLDivElement>(null);
  const { submitError, submitDetail } = composer;
  useOnChange(submitError, () => submitError && enter(ref.current, { y: -4, duration: 200 }));
  if (!submitError) return null;
  return (
    <div ref={ref} className="submit-notice" role="alert">
      <Icon name="alert" size={16} />
      <div className="submit-notice-body">
        <div>{submitError}</div>
        {submitDetail && <div className="submit-notice-detail">{submitDetail}</div>}
      </div>
      <button className="icon-btn icon-btn-sm" type="button" aria-label="关闭" {...tip('关闭')} onClick={dismissSubmitError}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

export function Composer() {
  useStore('composer', 'app', 'balance');
  const { studio } = composer;
  const type = typeOf();
  // 工作流的主文本（提示词、朗读文本）也写在大文本框里；没有文字参数的工作流不显示它。
  const flowPrimary = studio.type === 'flow' ? flowDefinition()?.input_rules?.[flowPrimaryKey() || ''] : undefined;
  const flowKey = studio.type === 'flow' && flowPrimary ? flowPrimaryKey() : null;
  const text = studio.type === 'flow' && !flowPrimary ? '' : draftPrompt();
  const skill = activeSkill();
  const prompt = useRef<HTMLTextAreaElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const types = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const params = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLDivElement>(null);
  const resizing = useRef<Animation | null>(null);
  // 有文件正拖在输入框上面。拖进子元素时也会触发离开，所以数进出的次数。
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');
  const settledHeight = useRef(0);
  useStore('flows');

  // 文本框里的字由用户打，不由这里逐字回写；只有换类型、润色、复用这些从外面改了文字的时候才写回去。
  // 高度跟着内容长，最高 280。工作流没有提示词框，这时不量。
  useLayoutEffect(() => {
    const el = prompt.current;
    if (!el) return;
    if (el.value !== text) el.value = text;
    // 选着技能时，第一行让出技能名的位置，字接在它后面。
    el.style.textIndent = chip.current ? `${chip.current.offsetWidth - 12}px` : '';
    el.style.height = 'auto';
    el.style.height = `${Math.min(280, Math.max(72, el.scrollHeight))}px`;
  });
  useEffect(() => {
    registerPrompt(prompt.current);
    return () => registerPrompt(null);
  }, []);

  // 打开页面时：问句、类型切换、输入框依次进场。
  useLayoutEffect(() => {
    enter(title.current, { y: 12, blur: 4, duration: 420 });
    enter(types.current, { y: 12, duration: 420, delay: 90 });
    enter(card.current, { y: 12, duration: 420, delay: 180 });
  }, []);

  // 换了一种内容：问句换一句，工具栏的入口依次出现。
  useOnChange(studio.type, () => {
    enter(title.current, { y: 6, blur: 3, duration: 200 });
    enterEach(params.current!.children, { y: 4, duration: 180, stagger: 30 });
  });

  // 类型、生成方式、模型家族变了，输入框里的东西就不一样高。高度滑过去，下面的记录跟着挪，不是跳一下。
  // 只管这几种变化：打字撑高文本框时不做动效。
  // 工作流的参数全部在表单里，这时不放提示词框；素材和参数都是按规则画的，高度变化跟着参数的多少走。
  const flowFields = studio.type === 'flow' ? Object.keys(flowDefinition()?.input_rules || {}).length : 0;
  const shape = `${studio.type}:${composer.form.mode}:${modesFor().length}:${hasLastFrame()}:${studio.type === 'image' && imageRefLimit() > 0}:${Boolean(skill)}:${flowFields}`;
  useLayoutEffect(() => {
    const el = card.current!;
    // 上一次还没滑完就又变了，从现在停着的高度接着滑。
    const from = resizing.current?.playState === 'running' ? el.offsetHeight : settledHeight.current;
    resizing.current?.cancel();
    const to = el.offsetHeight;
    if (!from) return;
    enter(el.querySelector('.media-block:not([hidden])'), { y: 4, duration: 200 });
    if (Math.abs(to - from) > 1 && !reducedMotion()) resizing.current = el.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 240, easing: EASE_OUT });
  }, [shape]);
  useLayoutEffect(() => {
    if (resizing.current?.playState !== 'running') settledHeight.current = card.current!.offsetHeight;
  });

  // 读到模型列表后，没有可用模型的类型不能选。工作流看的是 AutoDL.art 的令牌和工作流目录。
  const { known, image } = state.catalog;
  const missing: Record<string, boolean> = {
    image: Boolean(known && !image.length),
    flow: !state.app.autodl?.hasKey || Boolean(state.flows.loaded && (state.flows.error || !state.flows.items.length)),
  };

  return (
    <section className="composer">
      <h1 ref={title} className="composer-title">
        {studio.type === 'flow' && studio.flow.workflow ? studio.flow.workflow.name : type.title}
      </h1>
      <div ref={types} className="composer-types">
        <Segmented
          options={TYPES.map((t) => ({ value: t.value, label: t.label, disabled: missing[t.value] && t.value !== studio.type, title: missing[t.value] ? '暂无可用模型' : null }))}
          value={studio.type}
          onChange={setType}
          className="type-switch"
        />
      </div>
      {/* 文件可以直接拖到输入框上，或者在提示词里粘贴；加到哪、能不能加，和点加号是同一套规则。 */}
      <div
        ref={card}
        className={`composer-card ${dropping ? 'is-drop' : ''}`}
        onDragEnter={(e) => {
          if (!hasFiles(e)) return;
          dragDepth.current += 1;
          setDropping(true);
        }}
        onDragOver={(e) => hasFiles(e) && e.preventDefault()}
        onDragLeave={(e) => {
          if (!hasFiles(e)) return;
          dragDepth.current -= 1;
          if (dragDepth.current <= 0) setDropping(false);
        }}
        onDrop={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth.current = 0;
          setDropping(false);
          addFiles([...e.dataTransfer.files]);
        }}
      >
        <MediaBlock />
        {/* 选着的技能：写在提示词第一行的开头。点叉取消，光标在最前面时按退格也取消。 */}
        {skill && (
          <div ref={chip} className="skill-chip-row">
            <span className="skill-chip">
              <Icon name="wand" />
              <span className="ellipsis">{skill.name}</span>
              <button type="button" aria-label={`取消技能「${skill.name}」`} onClick={() => setSkill(null)}>
                <Icon name="x" size={12} stroke={2} />
              </button>
            </span>
          </div>
        )}
        <textarea
          ref={prompt}
          className="prompt"
          rows={3}
          defaultValue={text}
          hidden={!type.placeholder && !flowKey}
          placeholder={skill ? '输入简要描述，发送时自动扩写' : flowKey && flowPrimary ? flowPrimary.description || `输入${ruleLabel(flowPrimary, flowKey)}` : type.placeholder || ''}
          aria-label={type.value === 'speech' ? '朗读文本' : '提示词'}
          onInput={(e) => typePrompt(e.currentTarget.value)}
          onPaste={(e) => {
            // 粘贴的是文件（截图、复制的图片或视频）就当素材加进来；带着文字的（从文档里复制的一段）照常粘贴文字。
            const files = [...e.clipboardData.files];
            if (!files.length || e.clipboardData.getData('text/plain')) return;
            e.preventDefault();
            addFiles(files);
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              if (state.app.hasKey && !composer.submitting) submit();
            } else if (e.key === 'Backspace' && skill && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) {
              e.preventDefault();
              setSkill(null);
            }
          }}
          onScroll={(e) => {
            // 提示词长到要滚动时，技能名跟着第一行一起滚上去。
            if (chip.current) chip.current.style.translate = `0 ${-e.currentTarget.scrollTop}px`;
          }}
        />
        <div className="composer-bar">
          <div ref={params} className="composer-params">
            <Toolbar />
          </div>
          <div className="composer-send">
            <SendArea />
          </div>
        </div>
      </div>
      <SubmitNotice />
    </section>
  );
}
