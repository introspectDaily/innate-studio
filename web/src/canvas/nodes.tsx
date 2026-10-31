// 画布上的四种节点和连线。
// 节点本身只是一块内容：上面一行名字，下面一个框放结果。选中它之后，下方才出现输入面板：参考素材、提示词、模型和参数、生成键。
// 左右两个加号是连接点：拖出去连到别的节点，点一下是在那一侧接一个新节点。
// 跟着画布缩放的只有框和里面的内容；名字、加号、操作条、输入面板在屏幕上的大小不变，缩得再小也看得清、点得到。

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BaseEdge, Handle, NodeToolbar, Position, getBezierPath, useConnection, useEdges, useInternalNode, useReactFlow, useStore as useFlowStore, useUpdateNodeInternals, type ConnectionLineComponentProps, type EdgeProps, type Node, type NodeProps } from '@xyflow/react';
import { state, useStore, loadVoices, isPendingTask, polishModel, modelOption, flowModelsOf, flowModelLabel, flowSummary, flowReady, canvasPlace, KINDS as MEDIA } from '../store.ts';
import { RATIOS, fitImageQuality, fitImageSize, hasLastFrame, imageQualities, imageRatios, imageRefLimit, imageSizes, specOf, voiceName } from '../composer/state.ts';
import { refLimitsOf } from '../../../shared/models.ts';
import { IMAGE_QUALITY_LABELS, modelLabel, modelNote } from '../../../shared/models.ts';
import { flowMediaKeys, isFlowModel, ruleDefault, ruleLabel } from '../../../shared/autodl.ts';
import { recordName, uploadLocalFile } from '../media.ts';
import { openAssetPicker } from '../assets.tsx';
import { Icon, type IconName } from '../ui/Icon.tsx';
import { FailureState, refundNote } from '../ui/states.tsx';
import { Dropdown, Slider, Toggle, tip } from '../ui/controls.tsx';
import { MediaTile, AddTile } from '../ui/tiles.tsx';
import { openMenu, openModal, openPopover, toast } from '../ui/layers.tsx';
import { VideoPlayer, AudioPlayer } from '../player.tsx';
import { openDetail } from '../history.tsx';
import type { Kind, Ref } from '../types.ts';
import { BOX_HEIGHT, IMAGE_PRESETS, NODE_LABELS, OUTPAINT_PROMPT, ROLE_LABELS, canLink, keepBefore, keptOf, makeRoom, nodeWidth, linkLabel, PINS, PIN_LABELS, type AudioData, type FrameRole, type Generated, type GroupData, type ImageData, type Pin, type Preset, type StackData, type LinkData, type NodeKind, type TextData, type VideoData } from './model.ts';
import { fitVideo, generate, isFilled, nameOf, outputOf, recordOf, runAll } from './run.ts';
import { openKept } from './kept.tsx';
import { Cropper, cropImage, grabFrame, padImage, splitGrid, type Made } from './edit.tsx';
import { reducedMotion } from '../ui/motion.ts';

// 画布页交给节点用的几件事。snap：会改动画布结构的操作，动手之前调一下，撤销时回到这一刻。
// addInput：在某个节点左边加一个节点并连进它，extra 是新节点一出来就带着的内容（上传的文件）。
// ungroup：解散一个分组（只去掉框，里面的节点留着）。saveWorkflow：把一个分组存成工作流。
// unstack：把一叠摊开；只给一个成员就只取回它。
// addBeside：把几份做好的产物（裁剪、切分、截帧、剪辑的结果）各变成一个节点，摆在某个节点右边；columns 是一行摆几个。
// 产物是图就是图节点，是视频就把 kind 传 'video'，这样切出来的片段还能接着往下用。
export const CanvasActions = createContext<{
  snap: () => void;
  addInput: (targetId: string, kind: NodeKind, extra?: Record<string, unknown>, role?: FrameRole) => void;
  ungroup: (groupId: string) => void;
  saveWorkflow: (groupId: string) => void;
  unstack: (stackId: string, memberId?: string) => void;
  addBeside: (sourceId: string, made: Made[], columns?: number, kind?: NodeKind) => void;
  // addNodeBeside：在某个节点右边加一个同类的空节点，返回它的 id（扩图的结果放进它）。continueVideo：接着一段视频往后拍，frame 是它的最后一帧。
  addNodeBeside: (sourceId: string, data: Record<string, unknown>) => string;
  continueVideo: (sourceId: string, frame: Made, targetAt?: { x: number; y: number }) => void;
  jumpTo: (nodeId: string) => void;
  hoverNode: (nodeId: string | null) => void;
}>({ snap() {}, addInput() {}, ungroup() {}, saveWorkflow() {}, unstack() {}, addBeside() {}, addNodeBeside: () => '', continueVideo() {}, jumpTo() {}, hoverNode() {} });

export const NODE_ICONS: Record<NodeKind, IconName> = { text: 'type', image: 'image', video: 'video', audio: 'music' };

// React Flow 认这几个类名：nodrag 是在它上面按住拖动不会挪节点，nowheel 是在它上面滚动不会移动画布。
const INERT = 'nodrag nowheel';

type MediaData = Partial<ImageData & VideoData & AudioData>;
type AnyData = Partial<ImageData & VideoData & AudioData & TextData & { autofocus?: boolean; ignoreSelfRef?: boolean }>;

// 只选中了这一个节点时才显示它的工具条和输入面板；框选了一片时都不显示，免得叠成一堆。
function useAlone(selected?: boolean) {
  const count = useFlowStore((s) => {
    let n = 0;
    for (const node of s.nodeLookup.values()) if (node.selected) n++;
    return n;
  });
  return Boolean(selected) && count === 1;
}

// dragging：正被拖着走。这时候不显示输入面板和名字行右端的操作，松手再出来，拖起来才轻。
function Frame({ id, kind, no, pins = [], selected, dragging, width, tools, panel, children }: { id: string; kind: NodeKind; no?: number; pins?: Pin[]; selected?: boolean; dragging?: boolean; width: number; tools?: ReactNode; panel: ReactNode; children: ReactNode }) {
  const flow = useReactFlow();
  const { jumpTo } = useContext(CanvasActions);
  // 这个节点是从别的节点截出来的（接着拍截的尾帧）：标题旁写上来自哪里，点一下跳过去。它们之间连不了线（视频不能连给图片），只能这样标出来。
  const derived = (flow.getNode(id)?.data as { derivedFrom?: string } | undefined)?.derivedFrom;
  const origin = derived ? flow.getNode(derived) : undefined;
  const alone = useAlone(selected) && !dragging;
  // 正从别的节点拉一条线过来：这个节点接得住，就把整个框变成落点，不用对准小加号。
  // 从右边的加号拉出来的线要找下游，从左边的加号拉出来的要找上游。
  const link = useConnection();
  const other = link.inProgress && link.fromNode.id !== id ? (link.fromNode.type as NodeKind) : null;
  const wants = other && link.fromHandle?.type === 'source' ? 'target' : 'source';
  const fits = Boolean(other) && (wants === 'target' ? canLink(other!, kind) : canLink(kind, other!));
  // 落点是拉线时才加进来的，要让 React Flow 重新量一遍这个节点，它才认得这个落点（线拖上来时才会把它标成可以连）。
  const remeasure = useUpdateNodeInternals();
  useEffect(() => remeasure(id), [fits, wants]);
  // 输入面板长高了（多连了素材、提示词写长了），底部的发送键可能被挤到窗口外面：视野往上挪刚好够的距离。
  // 只看它自己长高，不管视野怎么动：用户拖着看别处时不去抢视野。
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = panelRef.current;
    if (!alone || !el) return;
    let height = el.offsetHeight;
    const observer = new ResizeObserver(() => {
      const grew = el.offsetHeight > height + 1;
      height = el.offsetHeight;
      const over = el.getBoundingClientRect().bottom - (window.innerHeight - 24);
      if (!grew || over <= 0) return;
      const view = flow.getViewport();
      flow.setViewport({ ...view, y: view.y - over }, { duration: reducedMotion() ? 0 : 200 });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [alone, flow]);
  return (
    <div className={`cnode cnode-${kind} ${selected ? 'selected' : ''}`} style={{ width }}>
      {/* 名字在左，只选中这一个节点时右端是它的几个操作（上传、看详情）。删除用键盘或右键菜单。 */}
      <div className="cnode-title">
        <span className="cnode-name">
          <Icon name={NODE_ICONS[kind]} size={14} />
          <span>{no ? `${NODE_LABELS[kind]} ${no}` : NODE_LABELS[kind]}</span>
          {pins.map((pin) => (
            <span key={pin} className={`cpin is-${pin}`} role="img" aria-label={`${PIN_LABELS[pin]}标记`} />
          ))}
          {origin && (
            <button type="button" className="cnode-origin nodrag" {...tip(`定位 ${nameOf(origin)}`)} onClick={() => jumpTo(origin.id)}>
              {nameOf(origin)} 的尾帧
            </button>
          )}
        </span>
        {alone && (
          <span className="cnode-acts nodrag">
            <button className="icon-btn icon-btn-sm cnode-btn" type="button" {...tip('颜色标记')} aria-label="颜色标记" aria-haspopup="dialog" aria-expanded="false" onClick={(e) => openPopover(e.currentTarget, <PinSheet value={pins} onChange={(pin) => flow.updateNodeData(id, { pin })} />, { label: '颜色标记' })}>
              <span className={`cpin ${pins.length ? `is-${pins[0]}` : 'is-none'}`} />
            </button>
            {tools}
          </span>
        )}
      </div>
      <div className="cnode-box">{children}</div>
      <Port side="target" />
      <Port side="source" />
      {fits && <Handle id="body" type={wants} position={wants === 'target' ? Position.Left : Position.Right} className="cnode-drop" isConnectableStart={false} />}
      {/* 输入面板画在画布的缩放之外，所以大小不变；位置仍然贴着节点。 */}
      <NodeToolbar isVisible={alone} position={Position.Bottom} offset={20}>
        <div ref={panelRef} className="cnode-panel nowheel" onKeyDown={sendOnShortcut}>
          {panel}
        </div>
      </NodeToolbar>
    </div>
  );
}

// 选颜色标记：几个色点，点一下标上、再点一下去掉，可以同时标几种；最后是「无」，一次清掉。它画在画布外面的浮层里，所以自己记着选了什么。
function PinSheet({ value, onChange }: { value: Pin[]; onChange: (pins: Pin[]) => void }) {
  const [picked, setPicked] = useState(value);
  const set = (next: Pin[]) => {
    setPicked(next);
    onChange(next);
  };
  return (
    <div className="popover-body cpins" role="group" aria-label="颜色标记">
      {PINS.map((pin) => (
        <button key={pin} type="button" className={`cpins-item ${picked.includes(pin) ? 'active' : ''}`} aria-pressed={picked.includes(pin)} aria-label={PIN_LABELS[pin]} {...tip(PIN_LABELS[pin])} onClick={() => set(picked.includes(pin) ? picked.filter((p) => p !== pin) : PINS.filter((p) => p === pin || picked.includes(p)))}>
          <span className={`cpin is-${pin}`} />
        </button>
      ))}
      <button type="button" className="cpins-none" disabled={!picked.length} onClick={() => set([])}>
        无
      </button>
    </div>
  );
}

// 连接点：框的左右两边各有一块看不见的感应区（屏幕上 52 见方，贴着框边），里面一个小加号。
// 鼠标进了感应区，加号就吸到鼠标的位置并放大一点；在感应区里任何地方按下都能拉线，点一下是在这一侧接一个新节点。
// 加号平时藏着，鼠标移到节点上或选中节点时才出现；感应区一直在。
const PORT_ZONE = 52;
function Port({ side }: { side: 'target' | 'source' }) {
  const dot = useRef<HTMLSpanElement>(null);
  // 加号挪到鼠标的位置。感应区在屏幕上的大小不变（样式里把画布的缩放抵消了），所以按它量出来的大小换算成它自己的 52 像素。
  const follow = (e: React.PointerEvent<HTMLDivElement>) => {
    const zone = e.currentTarget.getBoundingClientRect();
    const at = (client: number, start: number, size: number) => Math.min(PORT_ZONE - 9, Math.max(9, ((client - start) / size) * PORT_ZONE));
    dot.current!.style.left = `${at(e.clientX, zone.left, zone.width)}px`;
    dot.current!.style.top = `${at(e.clientY, zone.top, zone.height)}px`;
  };
  const rest = () => {
    dot.current!.style.left = '';
    dot.current!.style.top = '';
  };
  return (
    <Handle type={side} position={side === 'target' ? Position.Left : Position.Right} className="cnode-port" onPointerMove={follow} onPointerLeave={rest}>
      <span ref={dot} className="cnode-plus">
        <Icon name="plus" size={10} />
      </span>
    </Handle>
  );
}

// 连进这个节点的线，连同线那头的节点。
function useInputs(id: string) {
  const flow = useReactFlow();
  const found: { edgeId: string; link: LinkData; node: Node }[] = [];
  for (const edge of useEdges()) {
    const node = edge.target === id ? flow.getNode(edge.source) : undefined;
    if (node) found.push({ edgeId: edge.id, link: edge.data as unknown as LinkData, node });
  }
  return found;
}

// 输入框自己留一份正在打的字，再抄一份给节点。
// 不能直接拿节点里存的字当输入框的内容：节点的数据要过一拍才更新，这一拍里 React 会把输入框改回旧的内容，
// 输入法正在拼的那段就被打断了，结果是候选框出不来、只能打上英文字母。
// 光标在输入框里的时候不从节点往回抄，免得把正在打的字冲掉；不在的时候跟着节点走（比如模型写好了新内容）。
function useDraft(value: string, commit: (next: string) => void) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  return {
    value: draft,
    // 不经过输入事件、直接换成一段新的字（插入 @ 引用时用）。
    set: (next: string) => {
      setDraft(next);
      commit(next);
    },
    onChange: (e: { target: { value: string } }) => {
      setDraft(e.target.value);
      commit(e.target.value);
    },
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
    },
  };
}

// 提示词输入框。打一个 @，会列出连进这个节点的节点，选一个就插进一段「@图片 1」，在框里标出底色；生成时它会被换成模型看得懂的说法。
// 定位、高亮连着的节点在上面那排参考格上做（格子上写着节点名），提示词里不另放一排胶囊。
// 面板右下角的 @ 按钮是同一件事，插在光标的位置。
// presets：这个节点有斜杠预设（图片节点）。提示词还空着的时候打一个 /，或点右下角的 /，列出这些预设。
// 选了之后提示词换成预设的那一段；节点已经连了东西就直接开始生成，否则先停下等着补内容。
function Prompt({ id, value, placeholder, presets }: { id: string; value: string; placeholder: string; presets?: { refs: number; limit: number; run: (prompt: string) => void } }) {
  const flow = useReactFlow();
  const inputs = useInputs(id);
  const area = useRef<HTMLTextAreaElement>(null);
  const { set, ...draft } = useDraft(value, (prompt) => flow.updateNodeData(id, { prompt }));

  const mentions = useMemo(() => {
    const list: { label: string; no: string; name: string; node?: Node; kind: NodeKind }[] = [];
    const regex = /@(文本|图片|视频|音频)\s*(\d+)/g;
    let m: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((m = regex.exec(draft.value)) !== null) {
      const label = m[1];
      const no = m[2];
      const name = `${label} ${no}`;
      if (seen.has(name)) continue;
      seen.add(name);
      const input = inputs.find((inp) => nameOf(inp.node) === name);
      const kind = (input?.node.type as NodeKind) || (label === '图片' ? 'image' : label === '视频' ? 'video' : label === '音频' ? 'audio' : 'text');
      list.push({
        label,
        no,
        name,
        node: input?.node,
        kind,
      });
    }
    return list;
  }, [draft.value, inputs]);

  useEffect(() => {
    const rawData = flow.getNode(id)?.data as AnyData | undefined;
    if (rawData?.autofocus) {
      flow.updateNodeData(id, { autofocus: undefined });
      requestAnimationFrame(() => area.current?.focus());
    }
  }, [id, flow]);

  // typed：菜单是打 @ 打出来的，选了之后要把那个 @ 一起换掉。
  function mention(typed: boolean) {
    const el = area.current!;
    if (!inputs.length) return typed ? undefined : toast('请先连接上游节点', 'info');
    const at = el.selectionStart ?? el.value.length;
    openMenu(el, {
      label: '引用上游节点',
      items: inputs.map((input) => ({ value: nameOf(input.node), label: nameOf(input.node), note: input.link.kind === 'text' ? ((input.node.data as unknown as TextData).text || '').slice(0, 12) : linkLabel(input.link) })),
      onSelect: (name) => {
        const text = el.value;
        const from = typed && text[at - 1] === '@' ? at - 1 : at;
        const insert = `@${name} `;
        set(text.slice(0, from) + insert + text.slice(at));
        requestAnimationFrame(() => {
          el.focus();
          el.setSelectionRange(from + insert.length, from + insert.length);
        });
      },
    });
  }

  function preset(typed: boolean) {
    const el = area.current!;
    const why = (item: Preset) => (!item.needsRef ? null : !presets!.limit ? '模型不支持参考图' : !presets!.refs ? '未连接参考图' : null);
    openMenu(el, {
      label: '预设',
      items: IMAGE_PRESETS.map((item) => ({ value: item.id, label: item.label, note: item.note, disabled: Boolean(why(item)), title: why(item) })),
      onSelect: (pick) => {
        const item = IMAGE_PRESETS.find((p) => p.id === pick)!;
        // 是打 / 打出来的，把那个 / 换掉；点按钮来的，接在已经写的后面（已经写的当作补充说明）。
        const own = typed ? '' : el.value.trim();
        set(own ? `${item.prompt}\n${own}` : item.prompt);
        // 有输入可用就直接开始；没有（比如故事板还没写剧情）就把光标放到最后，等着补。
        if (inputs.length || presets?.refs || own) return presets!.run(own ? `${item.prompt}\n${own}` : item.prompt);
        requestAnimationFrame(() => {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        });
      },
    });
  }

  // 引用的节点直接在提示词里标出来：输入框底下垫一层同样的字，只给「@文本 1」这几个字垫上底色，字本身还是输入框里的。
  // 连进来的是蓝底；写了但没连进来的（连线删了、编号写错）是红底，生成时不会被换成节点的内容。
  const mirror = useRef<HTMLDivElement>(null);
  const marked = useMemo(() => {
    const parts: ReactNode[] = [];
    let last = 0;
    const regex = /@(文本|图片|视频|音频)\s*(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(draft.value)) !== null) {
      parts.push(draft.value.slice(last, m.index));
      const linked = mentions.find((item) => item.name === `${m![1]} ${m![2]}`)?.node;
      parts.push(
        <mark key={m.index} className={linked ? 'is-linked' : 'is-missing'}>
          {m[0]}
        </mark>,
      );
      last = m.index + m[0].length;
    }
    // 末尾是换行时补一个字，不然垫的这一层比输入框矮一行。
    parts.push(`${draft.value.slice(last)} `);
    return parts;
  }, [draft.value, mentions]);

  return (
    <>
      <div className="cnode-prompt-wrap">
        {mentions.length > 0 && (
          <div ref={mirror} className="cnode-prompt cnode-prompt-mirror" aria-hidden="true">
            {marked}
          </div>
        )}
      <textarea
        ref={area}
        className="cnode-prompt"
        placeholder={placeholder}
        {...draft}
        onChange={(e) => {
          draft.onChange(e);
          // 刚打出来的是 @（输入法拼字的时候不算）。
          const typed = (e.nativeEvent as InputEvent).data === '@' && !(e.nativeEvent as InputEvent).isComposing;
          if (typed) requestAnimationFrame(() => mention(true));
          // 提示词还空着时打的 /：出预设。写到一半的 / 只是个斜杠。
          if (presets && e.target.value === '/' && !(e.nativeEvent as InputEvent).isComposing) requestAnimationFrame(() => preset(true));
        }}
        onScroll={(e) => mirror.current && (mirror.current.scrollTop = e.currentTarget.scrollTop)}
      />
      </div>
      {presets && (
        <button className="cnode-at is-slash" type="button" {...tip('预设')} aria-label="预设" aria-haspopup="menu" onClick={() => preset(false)}>
          /
        </button>
      )}
      <button className="cnode-at" type="button" data-mention {...tip('引用上游节点')} aria-label="引用上游节点" aria-haspopup="menu" onClick={() => mention(false)}>
        @
      </button>
    </>
  );
}

// 和创作页的输入框一样，⌘ Enter（Windows 上是 Ctrl Enter）就是点生成键；生成键不能点时不发。
function sendOnShortcut(e: React.KeyboardEvent<HTMLElement>) {
  if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter' || e.nativeEvent.isComposing || !(e.target as Element).closest('textarea')) return;
  e.preventDefault();
  e.currentTarget.querySelector<HTMLButtonElement>('.cnode-bar .send-btn:not(:disabled)')?.click();
}

// 输入面板最下面一行：左边是模型和参数，右边是生成键。ready：有没有东西可以发（写了提示词，或者连了能用的节点），没有就是灰的。
function Bar({ working, ready, action, onSend, children }: { working: boolean; ready: boolean; action: string; onSend: () => void; children: ReactNode }) {
  return (
    <div className="cnode-bar">
      <div className="cnode-params">{children}</div>
      <button className="send-btn" type="button" {...tip(working ? '正在生成' : `${action}（⌘ Enter）`)} aria-label={action} disabled={working || !ready} onClick={onSend}>
        {working ? <span className="spinner" /> : <Icon name="arrowUp" size={18} />}
      </button>
    </div>
  );
}

interface ParamGroup {
  label: string;
  value: string;
  // 枚举取值列成一排小方块。note 是选项下的小字说明（模型的档位差异）。
  options?: { value: string; label: string; note?: string }[];
  // 连续取值（时长）不列按钮，画滑杆；value 是 'auto' 时滑杆不可用。
  range?: { min: number; max: number };
  // 有这一项就显示「时长由模型决定」开关（模型支持自动时长时才传）。
  onAuto?: (auto: boolean) => void;
  // 按钮摘要里这一组显示什么。不写就用选中的选项名。
  display?: string;
  // 只在浮层里出现、不进按钮摘要的组（模型：按钮旁边就是模型菜单）。
  quiet?: boolean;
  onChange: (value: string) => void;
}

// 参数里的一段自由输入（随机种子这类）。numeric 是纯数字。
interface ParamText {
  label: string;
  value: string;
  placeholder?: string;
  numeric?: boolean;
  onChange: (value: string) => void;
}

// 点开之后的那一页：每组参数一行小方块（时长是滑杆），文字参数一行输入框。它画在画布外面的浮层里，所以自己记着选了什么。
function ParamSheet({ groups, texts = [] }: { groups: ParamGroup[]; texts?: ParamText[] }) {
  const [picked, setPicked] = useState(() => groups.map((group) => group.value));
  // 滑杆的刻度：每 5 秒一格，从 0 画到上限。
  const marks = (max: number) => Array.from({ length: Math.floor(max / 5) + 1 }, (_, i) => i * 5);
  return (
    <div className="popover-body cnode-sheet">
      {groups.map((group, index) => (
        <div key={group.label} className="cnode-sheet-group" role={group.range ? undefined : 'radiogroup'} aria-label={group.label}>
          <div className="popover-title">{group.label}</div>
          {group.range ? (
            <>
              <div className="duration-row">
                <Slider
                  label={group.label}
                  min={group.range.min}
                  max={group.range.max}
                  marks={marks(group.range.max)}
                  // 浮层不会跟着外面重画，滑杆的位置取本地的 picked，拖动才跟手。
                  value={Number(picked[index]) || group.range.min}
                  disabled={picked[index] === 'auto'}
                  onChange={(value) => {
                    setPicked((now) => now.map((v, n) => (n === index ? String(value) : v)));
                    group.onChange(String(value));
                  }}
                />
              </div>
              {group.onAuto && (
                <div className="cnode-auto">
                  <Toggle
                    checked={picked[index] === 'auto'}
                    onChange={(auto) => {
                      setPicked((now) => now.map((v, n) => (n === index ? (auto ? 'auto' : String(group.range!.min)) : v)));
                      group.onAuto!(auto);
                    }}
                    label="时长由模型决定"
                  />
                  <span>由模型决定</span>
                </div>
              )}
            </>
          ) : (
            <div className="cnode-opts">
              {(group.options || []).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={picked[index] === option.value}
                  className={`cnode-opt ${picked[index] === option.value ? 'active' : ''}`}
                  onClick={() => {
                    setPicked((now) => now.map((value, n) => (n === index ? option.value : value)));
                    group.onChange(option.value);
                  }}
                >
                  {option.label}
                  {option.note && <span className="cnode-opt-note">{option.note}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      {texts.map((field) => (
        <div key={field.label} className="cnode-sheet-group">
          <div className="popover-title">{field.label}</div>
          <input
            className="cnode-text"
            type="text"
            inputMode={field.numeric ? 'numeric' : undefined}
            value={field.value}
            placeholder={field.placeholder}
            aria-label={field.label}
            onChange={(e) => field.onChange(field.numeric ? e.currentTarget.value.replace(/[^\d-]/g, '') : e.currentTarget.value)}
          />
        </div>
      ))}
    </div>
  );
}

// 几个参数合成一项：按钮上把当前的值用圆点隔开写成一行（9:16 · 720p · 5 秒），点开一起改。
function Params({ label, groups, texts = [] }: { label: string; groups: ParamGroup[]; texts?: ParamText[] }) {
  const ref = useRef<HTMLButtonElement>(null);
  const shown = groups.filter((group) => (group.options?.length ?? 0) > 0 || group.range);
  if (!shown.length && !texts.length) return null;
  const summary = [...shown.filter((group) => !group.quiet).map((group) => group.display || group.options?.find((option) => option.value === group.value)?.label || group.value), ...texts.filter((field) => field.value).map((field) => field.value)];
  return (
    <button ref={ref} type="button" className="dropdown dropdown-tool cnode-param" aria-haspopup="dialog" aria-expanded="false" aria-label={`${label}：${summary.join('，')}`} onClick={() => openPopover(ref.current!, <ParamSheet groups={shown} texts={texts} />, { label })}>
      <span className="dropdown-value">
        {summary.map((text, index) => (
          <span key={index}>{text}</span>
        ))}
      </span>
      <Icon name="chevron" size={12} />
    </button>
  );
}

// 图片、视频、音频节点的框里放什么：正在做什么、生成到哪了、结果或失败原因；什么都没有时是一个淡淡的图标。
// onShape：图片、视频读出来之后报告它实际的宽高比，节点的框跟着它定宽度。
function Result({ kind, data, onShape }: { kind: NodeKind; data: MediaData; onShape?: (aspect: number) => void }) {
  useStore('history');
  const record = recordOf(data);
  const measure = (e: { currentTarget: HTMLImageElement }) => e.currentTarget.naturalHeight > 0 && onShape?.(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight);
  const blank = (content: ReactNode, failed = false) => <div className={`cnode-state ${failed ? 'is-failed' : ''}`}>{content}</div>;
  const waiting = (text: string) => (
    <div className="cnode-state is-pending">
      <span className="state-chip">{text}</span>
    </div>
  );
  if (data.busy) return waiting(data.busy);
  if (data.upload && kind === 'image') return <img className="cnode-pic" src={data.upload.url} alt={data.upload.name} draggable={false} onLoad={measure} />;
  if (data.upload && kind === 'audio') {
    return (
      <Grabbable className="cnode-sound">
        <AudioPlayer src={data.upload.url} kind="上传的音频" text={data.upload.name} />
      </Grabbable>
    );
  }
  if (data.upload) return <Clip src={data.upload.url} label={data.upload.name} onShape={onShape} />;
  if (!record) return blank(data.recordId && state.historyLoaded ? '生成记录已删除' : <Icon name={NODE_ICONS[kind]} size={28} stroke={1.2} />);
  if (isPendingTask(record)) return waiting(record.status === 'queued' ? '排队中' : record.progress ? `生成中 ${Math.round(record.progress)}%` : '生成中');
  // 和创作页的失败卡片同一个样子。节点标题已经写着是什么，这里不再带提示词；重新生成就点输入面板的发送键。
  if (record.status === 'failed') return blank(<FailureState title="生成失败" reason={record.error?.message} note={refundNote(record)} />, true);
  if (!record.mediaUrl) return waiting('已生成，保存中…');
  if (kind === 'image') return <img className="cnode-pic" src={record.mediaUrl} alt={record.prompt || '生成的图片'} draggable={false} onLoad={measure} />;
  if (kind === 'video') return <Clip src={record.mediaUrl} label={record.prompt || '生成的视频'} onShape={onShape} />;
  return (
    <Grabbable className="cnode-sound">
      <AudioPlayer src={record.mediaUrl} kind={record.tool === 'sfx' ? '音效' : `语音 · ${record.payload?.voice_name || ''}`} text={record.prompt} />
    </Grabbable>
  );
}

// 视频读到尺寸之后报告它实际的宽高比。播放器是现成的组件，这里从它外面去听那个视频元素。
// 视频、音频的播放器放在这里面。整块可以抓着拖动节点；只有进度条和按钮那一条不拖（在上面按住是调进度、点按钮）。
// 拖完松手时浏览器还会补一个点击，会被播放器当成「点一下播放」；这里把拖动之后的那一下点击吃掉。
function Grabbable({ className, children, boxRef }: { className: string; children: ReactNode; boxRef?: React.RefObject<HTMLDivElement | null> }) {
  const own = useRef<HTMLDivElement>(null);
  const box = boxRef || own;
  const from = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  useEffect(() => {
    for (const bar of box.current?.querySelectorAll('.player-bar, .audio-controls') || []) bar.classList.add('nodrag');
  });
  return (
    <div
      ref={box}
      className={`${className} nowheel`}
      onPointerDownCapture={(e) => {
        from.current = { x: e.clientX, y: e.clientY };
        moved.current = false;
      }}
      onPointerMoveCapture={(e) => {
        if (from.current && Math.hypot(e.clientX - from.current.x, e.clientY - from.current.y) > 4) moved.current = true;
      }}
      onPointerUpCapture={() => {
        from.current = null;
      }}
      onClickCapture={(e) => {
        if (!moved.current) return;
        moved.current = false;
        e.stopPropagation();
        e.preventDefault();
      }}
    >
      {children}
    </div>
  );
}

function Clip({ src, label, onShape }: { src: string; label: string; onShape?: (aspect: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const video = box.current?.querySelector('video');
    if (!video) return;
    const measure = () => video.videoHeight > 0 && onShape?.(video.videoWidth / video.videoHeight);
    measure();
    video.addEventListener('loadedmetadata', measure);
    return () => video.removeEventListener('loadedmetadata', measure);
  }, [src]);
  return (
    <Grabbable boxRef={box} className="cnode-clip">
      <VideoPlayer src={src} label={label} />
    </Grabbable>
  );
}

// 名字行右端的操作：有内容时一个「全屏查看」，再加一个「更多」（下载、替换图片）。
// onUpload：图片节点可以上传一张图放进来；节点还空着的时候只有这一个按钮。
function NodeTools({ id, kind, data, onUpload }: { id: string; kind: Kind; data: MediaData; onUpload?: () => void }) {
  const flow = useReactFlow();
  const { addBeside, addNodeBeside, continueVideo, snap } = useContext(CanvasActions);
  useStore('history', 'app', 'prefs');
  const record = recordOf(data);
  // 这个节点里现在放着的东西：生成的结果，或者上传的文件。
  const done = record?.status === 'completed' && record.mediaUrl ? record : null;
  const file = done ? { url: done.mediaUrl!, name: recordName(done), local: Boolean(done.savedLocally) } : data.upload ? { ...data.upload, local: true } : null;

  function view() {
    if (done) return openDetail(done.id);
    const url = data.upload?.url;
    if (!url) return;
    openModal({ title: data.upload?.name || MEDIA[kind].label, size: 'detail', content: <div className="cnode-view">{kind === 'image' ? <img src={url} alt="" /> : kind === 'video' ? <VideoPlayer src={url} label={MEDIA[kind].label} /> : <AudioPlayer src={url} />}</div> });
  }

  function download() {
    if (!file) return;
    const link = document.createElement('a');
    // 存在本机的文件让服务按附件给出；还在平台上的就在新标签页里打开。
    link.href = file.local ? `${file.url}?download=1` : file.url;
    if (file.local) link.download = file.name;
    else link.target = '_blank';
    link.rel = 'noopener';
    link.click();
  }

  // 裁剪、切分、截帧都在浏览器里做，要读得到文件本身，所以只对存在本机的内容开放。结果是新的图片节点，摆在这个节点右边。

  async function make(what: string, job: () => Promise<Made[]>, columns = 1) {
    toast(`正在${what}…`, 'info', 1800);
    try {
      addBeside(id, await job(), columns);
    } catch (err) {
      toast((err as Error).message, 'error', 6000);
    }
  }
  function crop() {
    const modal = openModal({
      title: '裁剪',
      size: 'lg',
      content: (
        <Cropper
          url={file!.url}
          onCancel={() => modal.close()}
          onDone={(area) => {
            modal.close();
            make('裁剪', async () => [await cropImage(file!.url, area, `${file!.name}-裁剪`)]);
          }}
        />
      ),
    });
  }
  const playhead = () => document.querySelector<HTMLVideoElement>(`.react-flow__node[data-id="${id}"] video`)?.currentTime || 0;
  const local = Boolean(file?.local);
  // 扩图：把画面往外补成另一个比例。先在本地做一张放大了画布的底图，再让这个节点的模型去补；结果放进右边一个新的图片节点。
  async function outpaint(ratio: string) {
    const model = (data as ImageData).model;
    if (!imageRefLimit(model)) return toast(`${modelLabel(model)} 不支持参考图，请更换模型`, 'info');
    toast('正在准备扩图…', 'info', 1800);
    try {
      const [w, h] = ratio.split(':').map(Number);
      const padded = await padImage(file!.url, w / h, `${file!.name}-扩图底图`);
      if (!padded) return toast(`图片已是 ${ratio}`, 'info');
      const made = addNodeBeside(id, { prompt: `扩图成 ${ratio}`, ratio, count: 1 });
      // 等新节点真的上了画布再让它生成。
      let tries = 0;
      while (!flow.getNode(made) && tries++ < 20) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      generate(flow, made, snap, { prompt: OUTPAINT_PROMPT, refs: [padded] });
    } catch (err) {
      toast((err as Error).message, 'error', 6000);
    }
  }
  async function extend() {
    if (!specOf((data as VideoData).model).frames.includes('first_frame')) return toast(`${modelLabel((data as VideoData).model)} 不支持首帧，请更换模型`, 'info');
    toast('正在截取最后一帧…', 'info', 1800);
    try {
      continueVideo(id, await grabFrame(file!.url, 'last', `${file!.name}-尾帧`));
    } catch (err) {
      toast((err as Error).message, 'error', 6000);
    }
  }
  // 切宫格、扩图各有几个选项，点了再出第二层菜单。
  const ratios = imageRatios((data as ImageData).model).filter((r) => ['1:1', '16:9', '9:16', '4:3', '3:4', '21:9'].includes(r));
  const submenu = (button: HTMLElement | null, label: string, options: { value: string; label: string; selected?: boolean }[], run: (value: string) => void) => button && setTimeout(() => openMenu(button, { label, items: options, onSelect: run }), 0);
  const moreButton = useRef<HTMLButtonElement>(null);
  // 换下来过的内容（就地替换、上传替换都会留一份）。有就多一项「历史版本」。
  const kept = keptOf(data as Generated);
  // 再次生成的结果放在哪：这个节点单独选过按它，没选过跟随设置。
  const place = data.inPlace ?? canvasPlace() === 'here';
  const items = [
    ...(local && kind === 'image' ? [{ value: 'crop', label: '裁剪' }, { value: 'grid', label: '切成宫格…' }, ...(ratios.length ? [{ value: 'outpaint', label: '扩图…' }] : [])] : []),
    ...(local && kind === 'video' ? [{ value: 'extend', label: '延长' }, { value: 'trim', label: '剪辑…' }, { value: 'frame', label: '截取当前帧' }, { value: 'first', label: '截取首帧' }, { value: 'last', label: '截取尾帧' }] : []),
    ...(file ? [{ value: 'download', label: '下载' }] : []),
    ...(kept.length ? [{ value: 'kept', label: '历史版本…', note: String(kept.length) }] : []),
    { value: 'place', label: `再次生成：${place ? '就地替换' : '另开节点'}…` },
    ...(onUpload ? [{ value: 'upload', label: file ? '替换图片' : '上传图片' }] : []),
  ];
  const acts: Record<string, () => void> = {
    crop,
    grid: () => submenu(moreButton.current, '切成宫格', [2, 3, 4].map((n) => ({ value: String(n), label: `${n}×${n}` })), (n) => make('切分', () => splitGrid(file!.url, Number(n), file!.name), Number(n))),
    outpaint: () => submenu(moreButton.current, '扩图成', ratios.map((r) => ({ value: r, label: r })), outpaint),
    extend,
    // 剪辑：在浏览器里把这段视频切成几段，每段变成一个新的视频节点，摆在这个节点右边。
    // 剪辑器连着 ffmpeg.wasm，用到的时候才加载，不占画布打开时的那一口气。
    trim: async () => {
      try {
        const { openVideoEditor } = await import('../editor/VideoEditor.tsx');
        openVideoEditor(file!.url, file!.name, { onMade: (made) => addBeside(id, made, 1, 'video') });
      } catch (err) {
        toast(`剪辑加载失败：${(err as Error).message}`, 'error', 6000);
      }
    },
    frame: () => make('截帧', async () => [await grabFrame(file!.url, playhead(), `${file!.name}-截帧`)]),
    first: () => make('截帧', async () => [await grabFrame(file!.url, 0, `${file!.name}-首帧`)]),
    last: () => make('截帧', async () => [await grabFrame(file!.url, 'last', `${file!.name}-尾帧`)]),
    download,
    kept: () => openKept({ id, kind, data: data as Generated, flow }),
    // 三选一：跟随设置（不写进节点）、就地替换、另开新节点。选中的那一项打勾，不会再点出动作。
    place: () =>
      submenu(
        moreButton.current,
        '再次生成的结果',
        [
          { value: 'follow', label: `跟随设置（${canvasPlace() === 'here' ? '就地替换' : '另开节点'}）`, selected: data.inPlace === undefined },
          { value: 'here', label: '就地替换', selected: data.inPlace === true },
          { value: 'new', label: '另开新节点', selected: data.inPlace === false },
        ],
        (value) => flow.updateNodeData(id, { inPlace: value === 'follow' ? undefined : value === 'here' }),
      ),
    upload: () => onUpload?.(),
  };
  const act = (value: string) => acts[value]?.();

  const hasContent = Boolean(done || data.upload);
  if (!hasContent && !onUpload) return null;
  return (
    <>
      {hasContent && (
        <button className="icon-btn icon-btn-sm cnode-btn" type="button" {...tip('全屏查看')} aria-label="全屏查看" onClick={view}>
          <Icon name="expand" size={16} />
        </button>
      )}
      {hasContent && kind === 'video' && local && (
        <button className="icon-btn icon-btn-sm cnode-btn" type="button" {...tip('接着拍（截取尾帧接续生成下一个镜头）')} aria-label="接着拍" onClick={extend}>
          <Icon name="workflow" size={16} />
        </button>
      )}
      {!hasContent && onUpload ? (
        <button className="icon-btn icon-btn-sm cnode-btn" type="button" {...tip('上传图片')} aria-label="上传图片" onClick={onUpload}>
          <Icon name="upload" size={16} />
        </button>
      ) : (
        items.length > 0 && (
          <button ref={moreButton} className="icon-btn icon-btn-sm cnode-btn" type="button" {...tip('更多')} aria-label="更多操作" aria-haspopup="menu" aria-expanded="false" onClick={(e) => openMenu(e.currentTarget, { label: '更多操作', items, onSelect: act })}>
            <Icon name="more" size={16} />
          </button>
        )
      )}
    </>
  );
}

function useWorking(data: MediaData) {
  useStore('history', 'app');
  const record = recordOf(data);
  return Boolean(data.busy) || Boolean(record && isPendingTask(record));
}

// 框的宽度按内容的实际比例定（见 model.ts 的 nodeWidth）。换上一张更宽的图——上传的或者生成出来的——
// 框就从 240 长到 427 这样，位置却是记死的，于是伸到右边那个节点底下，连到它的线整个被压在框里，看上去就是「线不见了」。
// 所以框变宽多少，右边同一排的节点就整体右移多少，原来的间距不变。变窄不往回拉，留给用户自己整理。
function useShape(id: string) {
  const flow = useReactFlow();
  const { snap } = useContext(CanvasActions);
  return useCallback(
    (aspect: number) => {
      const node = flow.getNode(id);
      if (!node) return;
      const kind = node.type as NodeKind;
      if (Math.abs(aspect - Number((node.data as { aspect?: number }).aspect || 0)) < 0.01) return;
      const before = nodeWidth(kind, node.data as { aspect?: number });
      const after = nodeWidth(kind, { aspect });
      if (after > before) {
        snap();
        const moved = makeRoom(
          flow
            .getNodes()
            .filter((n) => n.type !== 'group' && !n.hidden)
            .map((n) => ({ id: n.id, position: n.position, width: n.measured?.width || nodeWidth(n.type as NodeKind, n.data) })),
          node,
          before,
          after,
        );
        if (moved.size) flow.setNodes((items) => items.map((n) => (moved.has(n.id) ? { ...n, position: moved.get(n.id)! } : n)));
      }
      flow.updateNodeData(id, { aspect });
    },
    [flow, id, snap],
  );
}

const promptHint = (linked: boolean, own: string) => (linked ? '补充提示词（可选）' : own);

// ---------- 文本 ----------

// 框里是内容，双击进去改。下面的面板是给文本模型提要求：写好的内容会放进框里，连进来的文本节点和框里已有的内容当参考。
export function TextNode({ id, data: raw, selected, dragging }: NodeProps) {
  const data = raw as unknown as TextData;
  const flow = useReactFlow();
  const [editing, setEditing] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const draft = useDraft(data.text || '', (text) => flow.updateNodeData(id, { text }));
  const { snap } = useContext(CanvasActions);
  useStore('models', 'app');
  const models = state.catalog.polish;
  const model = models.includes(data.model || '') ? data.model! : polishModel();

  useEffect(() => {
    if (editing) area.current?.focus();
  }, [editing]);
  // 不再选中就退出编辑。
  useEffect(() => {
    if (!selected) setEditing(false);
  }, [selected]);

  const write = () => generate(flow, id, snap);

  return (
    <Frame
      id={id}
      kind="text"
      dragging={dragging}
      no={data.no}
      pins={(data as { pin?: Pin[] }).pin}
      selected={selected}
      width={BOX_HEIGHT}
      panel={
        <>
          <Refs id={id} kind="text" />
          <Prompt id={id} value={data.prompt || ''} placeholder={data.text ? '描述修改要求，例如：改成三个分镜，每个一句话' : '描述写作要求，例如：写一段 15 秒短视频的分镜'} />
          {data.error && !data.busy && <p className="cnode-error">{data.error}</p>}
          <Bar working={Boolean(data.busy)} ready={Boolean((data.prompt || '').trim())} action="生成文本" onSend={write}>
            {models.length > 0 ? (
              <Dropdown variant="tool" chevron label="文本模型" value={model} options={models.map((m) => ({ value: m, label: m }))} onChange={(next) => flow.updateNodeData(id, { model: next })} />
            ) : (
              <span className="cnode-note">暂无可用的文本模型</span>
            )}
          </Bar>
        </>
      }
    >
      {data.busy ? (
        <div className="cnode-state is-pending">
          <span className="state-chip">{data.busy}</span>
        </div>
      ) : editing ? (
        <textarea
          ref={area}
          className={`cnode-text-edit ${INERT}`}
          {...draft}
          onBlur={() => {
            draft.onBlur();
            setEditing(false);
          }}
        />
      ) : (
        <div className={`cnode-text-view nowheel ${data.text ? '' : 'is-empty'}`} onDoubleClick={() => setEditing(true)}>
          {data.text || '双击编辑'}
        </div>
      )}
    </Frame>
  );
}

// ---------- 图片 ----------

// 节点选的是 AutoDL.art 的工作流时，它自己的枚举、开关参数（模式、风格预设…）放进「参数」。键就是规则里的参数名，值存在节点的 flowValues 里。
// skip 是节点上已经有控件的参数（视频的分辨率、时长）。
function flowParamGroups(model: string, values: Record<string, unknown> | undefined, onChange: (next: Record<string, unknown>) => void, skip: string[] = []): ParamGroup[] {
  const rules = flowSummary(model)?.rules || {};
  return Object.entries(rules)
    .filter(([key, rule]) => !skip.includes(key) && (rule.type === 'enum' || rule.type === 'boolean'))
    .map(([key, rule]) => {
      const chosen = values?.[key];
      if (rule.type === 'boolean') {
        return {
          label: ruleLabel(rule, key),
          value: String(chosen === undefined ? Boolean(ruleDefault(rule)) : Boolean(chosen)),
          options: [
            { value: 'true', label: '开' },
            { value: 'false', label: '关' },
          ],
          onChange: (next: string) => onChange({ ...values, [key]: next === 'true' }),
        };
      }
      return {
        label: ruleLabel(rule, key),
        value: String(chosen ?? ruleDefault(rule) ?? rule.options?.[0]?.label ?? ''),
        options: (rule.options || []).map((option) => ({ value: option.label, label: option.label })),
        onChange: (next: string) => onChange({ ...values, [key]: next }),
      };
    });
}

export function ImageNode({ id, data: raw, selected, dragging }: NodeProps) {
  const data = raw as unknown as ImageData;
  const flow = useReactFlow();
  const file = useRef<HTMLInputElement>(null);
  const inputs = useInputs(id);
  const linked = inputs.some((i) => i.link.kind === 'text');
  const working = useWorking(data);
  useStore('models', 'app', 'flows');
  // 模型菜单：图片的型号，加上 AutoDL.art 上出图的工作流（也当成一种模型）。
  const flows = flowModelsOf('image');
  const isFlow = isFlowModel(data.model);
  const models = [...new Set([...(state.catalog.image.length ? state.catalog.image : [data.model]), ...flows])];
  const modelName = (id: string) => (flows.includes(id) ? flowModelLabel(id) : modelLabel(id));
  const ratios = imageRatios(data.model);
  // 这个模型收几张参考图。不收的模型不显示参考图那一排；已经连进来的仍然显示，方便看出问题在哪。工作流收几张，看它的图片规则。
  const refLimit = isFlow ? flowMediaKeys(flowSummary(data.model)?.rules || {}, 'image').length : imageRefLimit(data.model);
  const flowGroups = flowParamGroups(data.model, data.flowValues, (next) => flow.updateNodeData(id, { flowValues: next }));
  const { snap } = useContext(CanvasActions);
  const shape = useShape(id);
  const selfNode = flow.getNode(id);
  const selfOutput = selfNode ? outputOf(selfNode) : (data.upload ? { url: data.upload.url, kind: 'image' as const, name: data.upload.name } : null);
  const usesSelfRef = Boolean(
    !inputs.some((i) => i.link.kind === 'image') &&
    selfOutput?.kind === 'image' &&
    refLimit > 0 &&
    !isFlow &&
    !(data as { ignoreSelfRef?: boolean }).ignoreSelfRef
  );
  const hasRefs = inputs.some((i) => i.link.kind === 'image') || usesSelfRef;

  async function upload(picked?: File) {
    if (!picked) return;
    flow.updateNodeData(id, { busy: '正在上传', error: '', ignoreSelfRef: false });
    try {
      const ref = await uploadLocalFile(picked, 'image');
      // 框里原来有内容（生成的、上传的都算）：它退进历史版本，随时换得回来。
      const now = (flow.getNode(id)?.data || data) as ImageData;
      const patch = { upload: { url: ref.url, name: ref.name }, recordId: undefined, ignoreSelfRef: false };
      flow.updateNodeData(id, isFilled(now) ? keepBefore(now, patch) : patch);
    } catch (err) {
      toast((err as Error).message, 'error', 6000);
    } finally {
      flow.updateNodeData(id, { busy: '' });
    }
  }

  return (
    <Frame
      id={id}
      kind="image"
      dragging={dragging}
      no={data.no}
      pins={(data as { pin?: Pin[] }).pin}
      selected={selected}
      width={nodeWidth('image', data)}
      tools={<NodeTools id={id} kind="image" data={data} onUpload={() => file.current!.click()} />}
      panel={
        <>
          <Refs id={id} kind="image" model={data.model} limit={refLimit} />
          <Prompt id={id} value={data.prompt} placeholder={promptHint(linked, hasRefs ? '描述修改要求，例如：把背景改成雪夜' : '描述主体、环境、构图、光线与风格')} presets={{ refs: inputs.filter((i) => i.link.kind === 'image').length + (usesSelfRef ? 1 : 0), limit: refLimit, run: (prompt) => generate(flow, id, snap, { prompt }) }} />
          {data.error && !data.busy && <p className="cnode-error">{data.error}</p>}
          <Bar working={working} ready={Boolean(data.prompt.trim()) || linked || hasRefs} action="生成图片" onSend={() => generate(flow, id, snap)}>
            <Dropdown variant="tool" chevron label="模型" value={data.model} options={models.map((m) => modelOption(m, modelName(m), flows.includes(m) ? 'AutoDL 工作流' : null))} onChange={(model) => flow.updateNodeData(id, { model, flowValues: undefined, ratio: imageRatios(model).includes(data.ratio) ? data.ratio : imageRatios(model)[0] || data.ratio, resolution: fitImageSize(model, data.resolution), quality: fitImageQuality(model, data.quality) })} />
            <Params
              label="参数"
              groups={[
                ...(isFlow
                  ? []
                  : [
                      { label: '比例', value: data.ratio, options: ratios.map((r) => ({ value: r, label: r })), onChange: (ratio: string) => flow.updateNodeData(id, { ratio }) },
                      { label: '分辨率', value: fitImageSize(data.model, data.resolution) || '', options: imageSizes(data.model).map((r) => ({ value: r, label: r })), onChange: (resolution: string) => flow.updateNodeData(id, { resolution }) },
                      ...(imageQualities(data.model).length ? [{ label: '画质', value: fitImageQuality(data.model, data.quality) || '', options: imageQualities(data.model).map((q) => ({ value: q, label: IMAGE_QUALITY_LABELS[q] || q })), onChange: (quality: string) => flow.updateNodeData(id, { quality }) }] : []),
                    ]),
                { label: '张数', value: String(data.count || 1), options: IMAGE_COUNTS.map((n) => ({ value: String(n), label: `${n} 张` })), onChange: (count) => flow.updateNodeData(id, { count: Number(count) }) },
                ...flowGroups,
              ]}
            />
          </Bar>
        </>
      }
    >
      <input
        ref={file}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={(e) => {
          upload(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <Result kind="image" data={data} onShape={shape} />
    </Frame>
  );
}

// ---------- 视频 ----------

const ROLES: FrameRole[] = ['reference', 'first', 'last'];
// 一次最多出几份：图片是接口一次能出的张数，视频是连着提交几次。
const IMAGE_COUNTS = [1, 2, 3, 4];
const VIDEO_COUNTS = [1, 2, 3, 4];


// 改一条图片连线的用途。连线上的标签和输入面板里的小图都能点开它。
function pickRole(anchor: HTMLElement, model: string | undefined, current: FrameRole, onPick: (role: FrameRole) => void) {
  const { frames } = specOf(model);
  const usable: Record<FrameRole, boolean> = { reference: true, first: frames.includes('first_frame'), last: hasLastFrame(model) };
  openMenu(anchor, {
    label: '图片用途',
    items: ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role], selected: role === current, disabled: !usable[role], title: usable[role] ? null : '当前模型不支持' })),
    onSelect: (role) => onPick(role as FrameRole),
  });
}

// 面板最上面一排：连进来的节点各一个小方块，写着它当什么用；最后一个加号是再加一份参考素材。
// 连进来的文本节点也在这里（它的内容会拼进提示词）。视频节点收图片、视频、音频，图片可以点开改用途；
// 图片节点只收图片（图生图），limit 是它的模型最多收几张；文本、音频节点只收文本。这一排每种节点都有，最后一个加号一直在。
function Refs({ id, kind, model = '', limit = 0, mode }: { id: string; kind: NodeKind; model?: string; limit?: number; mode?: string }) {
  const forImage = kind === 'image';
  const flow = useReactFlow();
  const { snap, addInput, continueVideo, jumpTo, hoverNode } = useContext(CanvasActions);
  useStore('history', 'app');
  const inputs = useInputs(id);
  const selfNode = flow.getNode(id);
  const rawData = selfNode?.data as (AnyData & { ignoreSelfRef?: boolean; selfFrame?: { url: string; name: string }; selfRole?: string }) | undefined;
  const selfOutput = selfNode ? outputOf(selfNode) : (rawData?.upload ? { url: rawData.upload.url, kind: kind as Kind, name: rawData.upload.name } : null);
  const usesSelfRef = Boolean(
    forImage &&
    !inputs.some((i) => i.link.kind === 'image') &&
    selfOutput?.kind === 'image' &&
    limit > 0 &&
    !rawData?.ignoreSelfRef
  );
  const hasVideoContent = Boolean(kind === 'video' && selfOutput?.kind === 'video');
  // 文本排在前面。这个节点的模型不收的素材也照样显示，方便看出问题在哪。
  const media = [...inputs.filter((i) => i.link.kind === 'text'), ...inputs.filter((i) => i.link.kind !== 'text')];
  const used = inputs.filter((i) => i.link.kind === 'image').length + (usesSelfRef ? 1 : 0);
  const canUpload = kind === 'video' || (forImage && used < limit);
  const only = !canUpload;
  // 视频节点按生成方式把缺的素材摆成空格（和创作页的固定槽一个意思）：首尾帧缺首帧/尾帧，编辑/延长缺原片视频。
  const wantSlots: { key: string; media: Kind; role?: FrameRole; label: string }[] = [];
  if (kind === 'video' && mode) {
    const able = specOf(model);
    const images = inputs.filter((i) => i.link.kind === 'image');
    if (mode === 'frames' && able.frames.includes('first_frame')) {
      if (!images.some((i) => i.link.role === 'first')) wantSlots.push({ key: 'first', media: 'image', role: 'first', label: '首帧' });
      if (hasLastFrame(model) && !images.some((i) => i.link.role === 'last')) wantSlots.push({ key: 'last', media: 'image', role: 'last', label: '尾帧' });
    }
    if ((mode === 'edit' || mode === 'extend') && !inputs.some((i) => i.link.kind === 'video')) wantSlots.push({ key: 'source', media: 'video', label: '原片视频' });
  }
  // 点空格直接进选素材弹窗，选完按槽位落用途。
  const pickSlot = (button: HTMLElement, slot: (typeof wantSlots)[number]) =>
    openAssetPicker({ title: `添加${slot.label}`, kind: slot.media, onPick: (ref) => addInput(id, ref.kind, { upload: { url: ref.url, name: ref.name } }, slot.role) });
  // 移除一份素材就是断开那条线，上游的节点留在画布上。
  const unlink = (edgeId: string) => {
    snap();
    flow.deleteElements({ edges: [{ id: edgeId }] });
  };

  // 加号：这个节点还能接什么就列什么。文本哪种节点都能接；图片节点还能接参考图，视频节点还能接图片、视频、音频。只有一样时不弹菜单。
  // 本机的文件走创作页的同一个选素材弹窗：上传、生成记录、角色都能选，选中的变成一个连进来的节点。
  function add(button: HTMLElement) {
    const kinds = Object.keys(MEDIA) as Kind[];
    const items = [
      ...(canUpload ? [{ value: 'local', label: forImage ? '参考图' : '图片、视频或音频' }] : []),
      ...(forImage && rawData?.ignoreSelfRef && selfOutput ? [{ value: 'self', label: '使用当前图片作为底图' }] : []),
      ...(hasVideoContent ? [
        { value: 'extend', label: '接着拍（截取尾帧在右侧生成下一个分镜）' },
        ...(specOf(model).frames.includes('first_frame') ? [{ value: 'self-frame', label: '以本片尾帧作为首帧续拍' }] : []),
        { value: 'self-video', label: '以本片作为参考视频' },
      ] : []),
      { value: 'text', label: '文本节点' },
    ];
    const pick = async (value: string) => {
      if (value === 'self') {
        snap();
        return flow.updateNodeData(id, { ignoreSelfRef: false });
      }
      if (value === 'extend') {
        if (!selfOutput?.url) return toast('视频尚未准备好', 'info');
        toast('正在截取最后一帧…', 'info', 1800);
        try {
          const frame = await grabFrame(selfOutput.url, 'last', `${selfOutput.name}-尾帧`);
          continueVideo(id, frame);
        } catch (err) {
          toast((err as Error).message, 'error', 6000);
        }
        return;
      }
      if (value === 'self-frame') {
        if (!selfOutput?.url) return toast('视频尚未准备好', 'info');
        toast('正在提取最后一帧…', 'info', 1500);
        try {
          const frame = await grabFrame(selfOutput.url, 'last', `${selfOutput.name}-首帧`);
          snap();
          flow.updateNodeData(id, { selfFrame: frame, selfRole: undefined });
        } catch (err) {
          toast((err as Error).message, 'error', 6000);
        }
        return;
      }
      if (value === 'self-video') {
        snap();
        return flow.updateNodeData(id, { selfRole: 'reference', selfFrame: undefined });
      }
      if (value === 'text') return addInput(id, 'text');
      const onPick = (ref: Ref) => {
        // 首尾帧方式下传图进来自动落槽：没标首帧的当首帧，其次尾帧；槽都满了就当普通参考图。
        let role: FrameRole | undefined;
        if (mode === 'frames' && ref.kind === 'image' && specOf(model).frames.includes('first_frame')) {
          const images = inputs.filter((i) => i.link.kind === 'image');
          if (!images.some((i) => i.link.role === 'first')) role = 'first';
          else if (hasLastFrame(model) && !images.some((i) => i.link.role === 'last')) role = 'last';
        }
        addInput(id, ref.kind, { upload: { url: ref.url, name: ref.name } }, role);
      };
      if (forImage) return openAssetPicker({ title: '添加参考图', kind: 'image', remaining: limit - used, onPick });
      // 视频节点的素材上限按模型来（2.5 是 30 图 + 10 视频 + 10 音频，其余 9/3/3）；工作流看它自己的规则，这里不设限。
      const videoLimits = isFlowModel(model) ? undefined : refLimitsOf(specOf(model));
      openAssetPicker({ title: '添加参考素材', limits: videoLimits ? { ...videoLimits } : Object.fromEntries(kinds.map((item) => [item, MEDIA[item].max])), onPick });
    };
    if (items.length === 1) return pick(items[0].value);
    openMenu(button, { label: '连接上游节点', items, onSelect: pick });
  }

  return (
    <div className="cnode-refs">
      {usesSelfRef && selfOutput && (
        <MediaTile
          key="self-ref"
          tag="底图"
          tipText={`基于当前${selfOutput.name || '图片'}图生图（点击 × 可切换为纯文本生成）`}
          onRemove={() => {
            snap();
            flow.updateNodeData(id, { ignoreSelfRef: true });
          }}
        >
          <img className="thumb-img" src={selfOutput.url} alt="" draggable={false} />
        </MediaTile>
      )}
      {kind === 'video' && rawData?.selfFrame && (
        <MediaTile
          key="self-frame"
          tag="首帧"
          tipText="以本片尾帧作为接续首帧（点击 × 移除）"
          onRemove={() => {
            snap();
            flow.updateNodeData(id, { selfFrame: undefined });
          }}
        >
          <img className="thumb-img" src={rawData.selfFrame.url} alt="" draggable={false} />
        </MediaTile>
      )}
      {kind === 'video' && rawData?.selfRole === 'reference' && selfOutput && (
        <MediaTile
          key="self-video"
          tag="参考视频"
          tipText="以当前视频作为参考（点击 × 移除）"
          onRemove={() => {
            snap();
            flow.updateNodeData(id, { selfRole: undefined });
          }}
        >
          <Icon name="video" size={18} />
        </MediaTile>
      )}
      {media.map(({ edgeId, link, node }) => {
        // 每一格写着它连的是哪个节点（「文本 1」），和提示词里的「@文本 1」对得上；指上去画布上那个节点和连线亮起来。
        const hover = (on: boolean) => hoverNode(on ? node.id : null);
        if (link.kind === 'text') {
          const text = ((node.data as unknown as TextData).text || '').trim();
          // 文本格点一下跳到那个文本节点。
          const locate = { 'aria-label': `定位 ${nameOf(node)}`, onClick: () => (hoverNode(null), jumpTo(node.id)) };
          return (
            <MediaTile key={edgeId} className="is-text" tag={nameOf(node)} face={locate} onHover={hover} tipText={text ? (text.length > 80 ? `${text.slice(0, 80)}…` : text) : '上游文本节点为空'} onRemove={() => unlink(edgeId)}>
              <Icon name="type" size={18} />
            </MediaTile>
          );
        }
        const output = outputOf(node);
        const thumb = link.kind === 'image' ? output?.url : null;
        const label = linkLabel(link);
        // 连到视频节点的图片可以点开改用途（参考图、首帧、尾帧）。
        const face =
          link.kind === 'image' && !forImage
            ? {
                'aria-haspopup': 'listbox' as const,
                'aria-expanded': false,
                'aria-label': `图片用途：${label}`,
                onClick: (e: React.MouseEvent<HTMLButtonElement>) =>
                  pickRole(e.currentTarget, model, link.role || 'reference', (role) => {
                    snap();
                    flow.updateEdgeData(edgeId, { role });
                  }),
              }
            : undefined;
        return (
          <MediaTile key={edgeId} tag={label} face={face} onHover={hover} tipText={`${nameOf(node)} · ${label}`} onRemove={() => unlink(edgeId)}>
            {thumb ? <img className="thumb-img" src={thumb} alt="" draggable={false} /> : <Icon name={NODE_ICONS[link.kind]} size={18} />}
          </MediaTile>
        );
      })}
      {wantSlots.map((slot) => (
        <AddTile key={slot.key} label={`添加${slot.label}`} caption={slot.label} tipText="从素材库选择，或把画布上的素材节点连过来" onClick={(e) => pickSlot(e.currentTarget, slot)} />
      ))}
      <AddTile label={only ? '添加文本节点' : '添加上游节点'} tipText={only ? '添加文本' : forImage ? '添加参考图或文本' : '添加参考素材或文本'} aria-haspopup={only ? undefined : 'menu'} aria-expanded={only ? undefined : false} onClick={(e) => add(e.currentTarget)} />
    </div>
  );
}

export function VideoNode({ id, data: raw, selected, dragging }: NodeProps) {
  const data = raw as unknown as VideoData;
  const flow = useReactFlow();
  const inputs = useInputs(id);
  const linked = inputs.some((i) => i.link.kind === 'text');
  const working = useWorking(data);
  useStore('models', 'app', 'flows');
  // 模型菜单：火山方舟、MiniMax 的型号，加上 AutoDL.art 上出视频的工作流（也当成一种模型）。
  const flows = flowModelsOf('video');
  const models = [...new Set([...(state.models.includes(data.model) ? state.models : [data.model, ...state.models]), ...flows].filter(Boolean))];
  const isFlow = (id: string) => flows.includes(id);
  const modelName = (id: string) => (isFlow(id) ? flowModelLabel(id) : modelLabel(id));
  const modelHint = (id: string) => (isFlow(id) ? 'AutoDL 工作流' : modelNote(id));
  const able = specOf(data.model);
  const ratioLabel = (value: string) => RATIOS.find((r) => r.value === value)?.label || value;
  const set = (patch: Partial<VideoData>) => flow.updateNodeData(id, patch);
  // 切生成方式时把连线用途一并对齐，输入区的小方块标签跟着变（和创作页选首尾帧出现两个槽是一个意思）：
  // 切到首尾帧，图片连线按顺序标成首帧、尾帧；切回全能参考，把标记还原成参考图。编辑/延长只看视频连线，不用动。
  const setMode = (mode: VideoData['mode']) => {
    const images = inputs.filter((i) => i.link.kind === 'image');
    if (mode === 'frames') {
      for (const [index, { edgeId, link }] of images.entries()) {
        const role: FrameRole = index === 0 && able.frames.includes('first_frame') ? 'first' : index === 1 && hasLastFrame(data.model) ? 'last' : 'reference';
        if ((link.role || 'reference') !== role) flow.updateEdgeData(edgeId, { role });
      }
    } else if (mode === 'reference') {
      for (const { edgeId, link } of images) if (link.role && link.role !== 'reference') flow.updateEdgeData(edgeId, { role: 'reference' });
    }
    set(fitVideo({ ...data, mode }));
  };
  // 模型是工作流时，它自己的枚举、开关参数（模式、风格预设…）也放进「参数」：键就是规则里的参数名。分辨率、时长用节点上直接的那两个。
  const flowGroups = flowParamGroups(data.model, data.flowValues, (next) => set({ flowValues: next }), ['resolution']);
  const { snap } = useContext(CanvasActions);
  const shape = useShape(id);
  const hasSelfRef = Boolean(data.selfFrame || data.selfRole);
  const modelCount = models.length;
  // 目录晚于节点到达（或者只配了 AutoDL.art 的令牌，型号全不可用）时，节点可能还没选模型：
  // 默认用菜单里的第一个，不然这个节点根本无法生成。
  useEffect(() => {
    if (!data.model && modelCount) set(fitVideo({ ...data, model: models[0] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.model, modelCount]);
  return (
    <Frame
      id={id}
      kind="video"
      dragging={dragging}
      no={data.no}
      pins={(data as { pin?: Pin[] }).pin}
      selected={selected}
      width={nodeWidth('video', data)}
      tools={<NodeTools id={id} kind="video" data={data} />}
      panel={
        <>
          <Refs id={id} kind="video" model={data.model} mode={data.mode || 'reference'} />
          <Prompt id={id} value={data.prompt} placeholder={promptHint(linked, data.selfFrame ? '描述接续动作与剧情，例如：主角转身上车，车辆向远方驶去' : '描述主体、动作、场景、运镜、光线与风格')} />
          {data.error && !data.busy && <p className="cnode-error">{data.error}</p>}
          <Bar working={working} ready={Boolean(data.prompt.trim()) || inputs.length > 0 || hasSelfRef} action="生成视频" onSend={() => generate(flow, id, snap)}>
            <Dropdown
              variant="tool"
              chevron
              label="生成方式"
              value={data.mode || 'reference'}
              options={[
                { value: 'reference', label: '全能参考', note: '图、视频、音频都当参考，不连素材就是文生视频' },
                ...(able.frames.includes('first_frame')
                  ? [{ value: 'frames', label: able.frames.includes('last_frame') ? '首尾帧' : '图生视频', note: able.frames.includes('last_frame') ? '第一张图作首帧，第二张作尾帧' : '以图片为首帧' }]
                  : []),
                ...(able.editExtend
                  ? [
                      { value: 'edit', label: '编辑视频', note: '改原片的画面或声音，时长跟随原视频' },
                      { value: 'extend', label: '延长视频', note: '从原片向前或向后接着拍' },
                    ]
                  : []),
              ]}
              onChange={(mode) => setMode(mode as VideoData['mode'])}
            />
            <Dropdown variant="tool" chevron label="模型" value={data.model} options={models.map((m) => modelOption(m, modelName(m), modelHint(m)))} onChange={(model) => set(fitVideo({ ...data, model }))} />
            <Params
              label="参数"
              groups={[
                { label: '比例', value: data.ratio, options: able.ratios.map((r) => ({ value: r, label: ratioLabel(r) })), onChange: (ratio) => set({ ratio }) },
                { label: '分辨率', value: data.resolution, options: able.resolutions.map((r) => ({ value: r, label: r })), onChange: (resolution) => set({ resolution }) },
                // 时长是一段连续取值：画滑杆，不把每秒一格列成几十个按钮；支持的模型（2.5）可以交给模型决定。
                {
                  label: '时长',
                  value: data.durationAuto ? 'auto' : String(data.duration),
                  display: data.durationAuto ? '自动' : `${data.duration} 秒`,
                  range: { min: able.durations[0] ?? 4, max: able.durations[able.durations.length - 1] ?? 15 },
                  onAuto: able.autoDuration ? (durationAuto) => set({ durationAuto }) : undefined,
                  onChange: (duration) => set({ duration: Number(duration), durationAuto: false }),
                },
                { label: '段数', value: String(data.count || 1), options: VIDEO_COUNTS.map((n) => ({ value: String(n), label: `${n} 段` })), onChange: (count) => set({ count: Number(count) }) },
                // 声音和种子只有支持的模型才有（和创作页的「更多」一致）：MiniMax 两样都没有。
                ...(able.audio ? [{ label: '声音', value: String(data.generateAudio !== false), options: [{ value: 'true', label: '有声' }, { value: 'false', label: '无声' }], onChange: (value: string) => set({ generateAudio: value === 'true' }) }] : []),
                ...flowGroups,
              ]}
              texts={able.seed ? [{ label: '随机种子', value: data.seed || '', placeholder: '留空则每次随机', numeric: true, onChange: (seed) => set({ seed }) }] : []}
            />
          </Bar>
        </>
      }
    >
      <Result kind="video" data={data} onShape={shape} />
    </Frame>
  );
}

// ---------- 音频 ----------

export function AudioNode({ id, data: raw, selected, dragging }: NodeProps) {
  const data = raw as unknown as AudioData;
  const flow = useReactFlow();
  const linked = useInputs(id).some((i) => i.link.kind === 'text');
  const working = useWorking(data);
  const [, redraw] = useState(0);
  const { snap } = useContext(CanvasActions);
  useStore('app', 'flows');
  // 音频节点的模型：语音、音效两个内置的，加上 AutoDL.art 上出音频的工作流。选了工作流，节点按它的规则出。
  const flows = flowModelsOf('audio');
  const isFlow = isFlowModel(data.model);
  const speech = !isFlow && data.tool !== 'sfx';
  const voices = state.voices || [];

  // 音色列表第一次用到时才读。还没选过音色：有中文的先用第一个中文的。
  useEffect(() => {
    if (!speech || !state.app.hasKey) return;
    let alive = true;
    loadVoices()
      .then((list) => {
        if (!alive || !list?.length) return;
        if (!list.some((v) => v.id === data.voiceId)) {
          const first = list.find((v) => v.language === 'zh') || list[0];
          flow.updateNodeData(id, { voiceId: first.id, voiceName: voiceName(first) });
        }
        redraw((n) => n + 1);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [speech, state.app.hasKey]);

  const tools = [{ value: 'speech', label: '语音' }, { value: 'sfx', label: '音效' }, ...flows.map((id) => modelOption(id, flowModelLabel(id), 'AutoDL 工作流'))];
  return (
    <Frame
      id={id}
      kind="audio"
      dragging={dragging}
      no={data.no}
      pins={(data as { pin?: Pin[] }).pin}
      selected={selected}
      width={nodeWidth('audio')}
      tools={<NodeTools id={id} kind="audio" data={data} />}
      panel={
        <>
          <Refs id={id} kind="audio" />
          <Prompt id={id} value={data.prompt} placeholder={promptHint(linked, speech ? '输入朗读文本' : '描述声音的来源、材质与动作')} />
          {data.error && !data.busy && <p className="cnode-error">{data.error}</p>}
          <Bar working={working} ready={Boolean(data.prompt.trim()) || linked} action={isFlow ? '运行工作流' : speech ? '生成语音' : '生成音效'} onSend={() => generate(flow, id, snap)}>
            <Dropdown
              variant="tool"
              chevron
              label="类型"
              value={isFlow ? data.model! : data.tool}
              options={tools}
              onChange={(next) => (isFlowModel(next) ? flow.updateNodeData(id, { model: next, flowValues: undefined }) : flow.updateNodeData(id, { tool: next as AudioData['tool'], model: undefined, flowValues: undefined }))}
            />
            {isFlow && <Params label="参数" groups={flowParamGroups(data.model!, data.flowValues, (next) => flow.updateNodeData(id, { flowValues: next }))} />}
            {speech && voices.length > 0 && (
              <Dropdown
                variant="tool"
                chevron
                label="音色"
                value={data.voiceId}
                options={voices.map((v) => ({ value: v.id, label: voiceName(v) }))}
                onChange={(voiceId) => flow.updateNodeData(id, { voiceId, voiceName: voiceName(voices.find((v) => v.id === voiceId)!) })}
              />
            )}
          </Bar>
        </>
      }
    >
      <Result kind="audio" data={data} />
    </Frame>
  );
}

// ---------- 分组 ----------

// 分组只是一个框：垫在成员下面，左上角是组名。拖这个框，里面的节点一起走。
// 组名双击改。只选中这一个分组时，名字后面是「更多」：执行整组、存为工作流、解散分组。
export function GroupNode({ id, data: raw, selected }: NodeProps) {
  const data = raw as unknown as GroupData;
  const flow = useReactFlow();
  const alone = useAlone(selected);
  const { snap, ungroup, saveWorkflow } = useContext(CanvasActions);
  const [naming, setNaming] = useState(false);
  const draft = useDraft(data.name || '', (name) => flow.updateNodeData(id, { name }));
  const name = data.name?.trim() || `分组${data.no ? ` ${data.no}` : ''}`;
  const acts: Record<string, () => void> = { run: () => runAll(flow, data.members, snap), save: () => saveWorkflow(id), ungroup: () => ungroup(id) };
  return (
    <div className={`cgroup ${selected ? 'selected' : ''}`}>
      <div className="cgroup-title">
        {naming ? (
          <input
            className="cgroup-name-edit nodrag"
            autoFocus
            maxLength={30}
            placeholder={name}
            aria-label="组名"
            {...draft}
            onBlur={() => {
              draft.onBlur();
              setNaming(false);
            }}
            onKeyDown={(e) => !e.nativeEvent.isComposing && (e.key === 'Enter' || e.key === 'Escape') && e.currentTarget.blur()}
          />
        ) : (
          <span className="cgroup-name" onDoubleClick={() => setNaming(true)}>
            {name}
          </span>
        )}
        <span className="cgroup-count">{data.members.length} 个节点</span>
        {alone && (
          <button
            className="icon-btn icon-btn-sm cnode-btn nodrag"
            type="button"
            {...tip('更多')}
            aria-label="分组操作"
            aria-haspopup="menu"
            aria-expanded="false"
            onClick={(e) =>
              openMenu(e.currentTarget, {
                label: '分组操作',
                items: [
                  { value: 'run', label: '执行整组' },
                  { value: 'save', label: '存为工作流' },
                  { value: 'ungroup', label: '解散分组', note: '⇧ ⌘ G' },
                ],
                onSelect: (value) => acts[value](),
              })
            }
          >
            <Icon name="more" size={16} />
          </button>
        )}
      </div>
      <div className="cgroup-frame" />
    </div>
  );
}

// ---------- 堆叠 ----------

// 一叠里某个节点的小图：图片、视频是画面，文本是开头几个字，音频是图标。
function Mini({ node }: { node: Node }) {
  useStore('history');
  const kind = node.type as NodeKind;
  if (kind === 'text') return <span className="cstack-words">{((node.data as unknown as TextData).text || '').slice(0, 40) || '空文本'}</span>;
  const output = outputOf(node);
  const thumb = output?.url;
  if (thumb && kind === 'image') return <img src={thumb} alt="" draggable={false} />;
  if (thumb && kind === 'video') return <video src={`${thumb}#t=0.1`} preload="metadata" muted playsInline tabIndex={-1} />;
  return <Icon name={NODE_ICONS[kind]} size={20} />;
}

// 一叠：框里是最上面那个节点的画面，后面露出两层边，右上角写着一共几个。
// 选中它，下面展开一个画廊：点其中一个把它取回画布；右上角可以整叠摊开。
export function StackNode({ id, data: raw, selected, dragging }: NodeProps) {
  const data = raw as unknown as StackData;
  const alone = useAlone(selected) && !dragging;
  const { unstack } = useContext(CanvasActions);
  // 成员是藏着的节点，它们变了这里也要跟着变。
  const all = useFlowStore((s) => s.nodes);
  const members = data.members.map((member) => all.find((node) => node.id === member)).filter((node): node is Node => Boolean(node));
  return (
    <div className={`cnode cstack ${selected ? 'selected' : ''}`} style={{ width: BOX_HEIGHT }}>
      <div className="cnode-title">
        <span className="cnode-name">
          <Icon name="layers" size={14} />
          <span>{`堆叠${data.no ? ` ${data.no}` : ''}`}</span>
        </span>
        {alone && (
          <span className="cnode-acts nodrag">
            <button className="icon-btn icon-btn-sm cnode-btn" type="button" {...tip('取消堆叠')} aria-label="取消堆叠" onClick={() => unstack(id)}>
              <Icon name="grid" size={16} />
            </button>
          </span>
        )}
      </div>
      <div className="cnode-box cstack-box">
        {members[0] && <Mini node={members[0]} />}
        <span className="cstack-count">{members.length}</span>
      </div>
      <NodeToolbar isVisible={alone} position={Position.Bottom} offset={20}>
        <div className="cnode-panel cstack-panel nowheel">
          <div className="cstack-grid">
            {members.map((member) => (
              <button key={member.id} type="button" className="cstack-item" {...tip('取回画布')} aria-label={`取回 ${NODE_LABELS[member.type as NodeKind]}${member.data.no ? ` ${member.data.no}` : ''}`} onClick={() => unstack(id, member.id)}>
                <Mini node={member} />
                <span className="chist-cap ellipsis">{`${NODE_LABELS[member.type as NodeKind]}${member.data.no ? ` ${member.data.no}` : ''}`}</span>
              </button>
            ))}
          </div>
        </div>
      </NodeToolbar>
    </div>
  );
}

// ---------- 连线 ----------

// 流光走一遍的节奏：用八成半的时间从上游匀着滑到下游（两头稍缓），剩下的停一下再来。
// 不用原版那条「起步很快、后面几乎不动」的曲线：连线短，那样光一闪就过去了，大半时间看不见。
const BEAM_DUR = '2.4s';
const BEAM_TIMES = '0;0.85;1';
const BEAM_EASE = '0.4 0 0.2 1;0 0 1 1';

// 一条细线，上面不放标签：图片当参考图、首帧还是尾帧，在视频节点的输入面板里看和改。
// 线两头的节点有一个被选中时，这条线变成彩色并带流光，看得出它连着谁；平时是普通的灰线。
export function LinkEdge({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected }: EdgeProps) {
  const from = useInternalNode(source);
  const to = useInternalNode(target);
  // 线画到框的边上，不画到加号上：加号平时是藏着的，而且它在屏幕上大小不变，位置会随缩放挪动。
  const startX = from ? from.internals.positionAbsolute.x + (from.measured.width || 0) : sourceX;
  const endX = to ? to.internals.positionAbsolute.x : targetX;
  const [path] = getBezierPath({ sourceX: startX, sourceY, targetX: endX, targetY, sourcePosition, targetPosition });
  // 流光那段渐变沿着起点到终点的方向走，长度是两点距离的一半，收在 100 到 320 之间。
  const dx = endX - startX;
  const dy = targetY - sourceY;
  const span = Math.hypot(dx, dy) || 1;
  const ux = dx / span;
  const uy = dy / span;
  const reach = Math.min(320, Math.max(100, span * 0.5));
  // 两头的节点有一个被选中，或被 @ 胶囊悬停高亮：线变成彩色，上面有一段光顺着线从上游流到下游。线自己被选中时不流，免得盖住选中的样子。
  const isHovered = Boolean((from as { className?: string } | undefined)?.className?.includes('is-mention-hover') || (to as { className?: string } | undefined)?.className?.includes('is-mention-hover'));
  const lit = !selected && Boolean(from?.selected || to?.selected || isHovered);
  return (
    <>
      <BaseEdge id={id} path={path} className={`clink ${lit ? 'is-lit' : ''} ${isHovered ? 'is-mention' : ''}`} />
      {lit && (
        <>
          {/* 流光的做法取自 Magic UI 的 Animated Beam：不另画一段粗线，而是在原来的细线上再描一遍，
              描边用一条两头透明的渐变，让这条渐变顺着上游到下游的方向滑过去。两头是淡出的，所以没有硬边。 */}
          <defs>
            <linearGradient id={`beam-${id}`} gradientUnits="userSpaceOnUse" x1={startX - reach * ux} y1={sourceY - reach * uy} x2={startX} y2={sourceY}>
              <animate attributeName="x1" dur={BEAM_DUR} repeatCount="indefinite" calcMode="spline" keyTimes={BEAM_TIMES} keySplines={BEAM_EASE} values={`${startX - reach * ux};${endX};${endX}`} />
              <animate attributeName="y1" dur={BEAM_DUR} repeatCount="indefinite" calcMode="spline" keyTimes={BEAM_TIMES} keySplines={BEAM_EASE} values={`${sourceY - reach * uy};${targetY};${targetY}`} />
              <animate attributeName="x2" dur={BEAM_DUR} repeatCount="indefinite" calcMode="spline" keyTimes={BEAM_TIMES} keySplines={BEAM_EASE} values={`${startX};${endX + reach * ux};${endX + reach * ux}`} />
              <animate attributeName="y2" dur={BEAM_DUR} repeatCount="indefinite" calcMode="spline" keyTimes={BEAM_TIMES} keySplines={BEAM_EASE} values={`${sourceY};${targetY + reach * uy};${targetY + reach * uy}`} />
              <stop offset="0%" className="clink-beam-tail" stopOpacity="0" />
              <stop offset="60%" className="clink-beam-tail" />
              <stop offset="88%" className="clink-beam-head" />
              <stop offset="100%" className="clink-beam-head" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={path} className="clink-beam" stroke={`url(#beam-${id})`} />
        </>
      )}
    </>
  );
}

// 正在拉的那条线：一直跟着鼠标走，拖到节点上也不提前吸过去，松手才连上。能不能连，看那个节点有没有浮起来。
// 这条线画在画布坐标里，而 React Flow 给的 pointer 是屏幕上的位置，要按当前的平移和缩放换算过来，不然只有 100%、没平移过的时候才对得上。
export function DragLine({ fromX, fromY, fromNode, fromHandle, fromPosition, pointer }: ConnectionLineComponentProps) {
  const [x, y, zoom] = useFlowStore((s) => s.transform);
  // 线从框的边上出发，不从感应区的外沿出发。
  const startX = fromNode ? fromNode.internals.positionAbsolute.x + (fromHandle?.type === 'source' ? fromNode.measured.width || 0 : 0) : fromX;
  const [path] = getBezierPath({ sourceX: startX, sourceY: fromY, sourcePosition: fromPosition, targetX: (pointer.x - x) / zoom, targetY: (pointer.y - y) / zoom, targetPosition: fromPosition === Position.Right ? Position.Left : Position.Right });
  return <path d={path} fill="none" className="react-flow__connection-path" />;
}
