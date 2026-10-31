// 浮在画布上的两块：节点搜索，和从生成历史里把结果放回画布。

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Node } from '@xyflow/react';
import { api, state, useStore } from '../store.ts';
import { fmtTime } from '../format.ts';
import { Icon } from '../ui/Icon.tsx';
import { Segmented, tip } from '../ui/controls.tsx';
import { toast } from '../ui/layers.tsx';
import type { HistoryItem, Kind } from '../types.ts';
import { NODE_LABELS, type NodeKind } from './model.ts';
import { NODE_ICONS } from './nodes.tsx';

// ---------- 节点搜索 ----------

// 一个节点在搜索里显示的名字（图片 1），和能被搜到的字：名字、提示词、文本节点里的内容。
const nameOf = (node: Node) => `${NODE_LABELS[node.type as NodeKind]}${node.data.no ? ` ${node.data.no}` : ''}`;
const wordsOf = (node: Node) => [nameOf(node), node.data.prompt, node.data.text].filter(Boolean).join('\n');

// 结果里每个节点下面那行小字：先给命中的那一段，没有关键词就给提示词或文本的开头。
function excerpt(node: Node, query: string) {
  const body = [node.data.text, node.data.prompt].filter(Boolean).join(' ').replace(/\s+/g, ' ');
  const at = query ? body.toLowerCase().indexOf(query) : -1;
  const from = Math.max(0, at - 12);
  return (from > 0 ? '…' : '') + body.slice(from, from + 60);
}

// 输入关键词，上下键选、回车跳过去。Esc 先清空关键词，再按一次关掉。
// ignore 是打开它的那个按钮：点它不算「点了别处」，收起交给按钮自己切换，否则会先关又被点开。
export function Finder({ nodes, onJump, onClose, ignore }: { nodes: Node[]; onJump: (id: string) => void; onClose: () => void; ignore?: RefObject<HTMLElement | null> }) {
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const word = query.trim().toLowerCase();
  const found = useMemo(() => nodes.filter((node) => !word || wordsOf(node).toLowerCase().includes(word)).slice(0, 50), [nodes, word]);
  const current = Math.min(at, Math.max(0, found.length - 1));

  useEffect(() => {
    input.current?.focus();
  }, []);
  // 点在浮层以外的地方就收起：空白、别的节点、别的工具按钮都算。捕获阶段先收，后面的拖动、选中照常进行。
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      // 这个文件里的 Node 是画布节点，DOM 的那个用 Element 表示（pointerdown 的 target 一定是元素）。
      const target = e.target as Element | null;
      if (box.current?.contains(target) || (target && ignore?.current?.contains(target))) return;
      onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [ignore, onClose]);
  // 新的浏览器里 scrollIntoView 会返回一个 Promise，不能直接当 effect 的返回值（React 会把它当成清理函数去调）。
  useEffect(() => {
    list.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  return (
    <div ref={box} className="cfind nowheel" role="dialog" aria-label="搜索节点">
      <div className="pop-search">
        <Icon name="search" />
        <input
          ref={input}
          value={query}
          placeholder="搜索节点"
          aria-label="搜索节点"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setAt(0);
          }}
          onKeyDown={(e) => {
            // 输入法还在拼字的时候，回车和方向键是它的。
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setAt((current + (e.key === 'ArrowDown' ? 1 : found.length - 1)) % Math.max(1, found.length));
            } else if (e.key === 'Enter' && found[current]) {
              onJump(found[current].id);
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              if (query) setQuery('');
              else onClose();
            }
          }}
        />
      </div>
      <div ref={list} className="cfind-list" role="listbox" aria-label="搜索结果">
        {found.map((node, index) => (
          <button key={node.id} type="button" role="option" aria-selected={index === current} className={`menu-item cfind-item ${index === current ? 'active' : ''}`} onClick={() => onJump(node.id)} onPointerMove={() => setAt(index)}>
            <Icon name={NODE_ICONS[node.type as NodeKind]} size={16} />
            <span className="cfind-name">{nameOf(node)}</span>
            <span className="cfind-text ellipsis">{excerpt(node, word)}</span>
          </button>
        ))}
        {!found.length && <div className="cfind-empty">{nodes.length ? '无匹配结果' : '暂无节点'}</div>}
      </div>
    </div>
  );
}

// ---------- 生成历史 ----------

type Filter = 'all' | Kind;
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
];

// 生成过的内容，按时间从新到旧。点一个，它就作为一个新节点回到画布上；原来的记录不动。
export function HistoryPicker({ onPick }: { onPick: (item: HistoryItem) => void }) {
  useStore('history');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const word = query.trim().toLowerCase();
  const done = state.history.filter((item) => item.status === 'completed' && item.mediaUrl);
  const shown = done.filter((item) => (filter === 'all' || item.kind === filter) && (!word || (item.prompt || '').toLowerCase().includes(word))).slice(0, 120);
  return (
    <div className="popover-body chist">
      <div className="chist-head">
        <Segmented options={FILTERS} value={filter} onChange={setFilter} />
        <div className="pop-search">
          <Icon name="search" />
          <input value={query} placeholder="搜索提示词" aria-label="搜索提示词" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>
      <div className="chist-grid">
        {shown.map((item) => (
          <button key={item.id} type="button" className={`chist-item is-${item.kind}`} aria-label={`放回画布：${item.prompt || NODE_LABELS[item.kind]}`} onClick={() => onPick(item)}>
            {item.kind === 'image' ? (
              <img src={item.mediaUrl} alt="" loading="lazy" draggable={false} />
            ) : item.kind === 'video' ? (
              <video src={`${item.mediaUrl}#t=0.1`} preload="metadata" muted playsInline tabIndex={-1} />
            ) : (
              <Icon name="music" size={20} />
            )}
            <span className="chist-cap ellipsis">{item.kind === 'audio' ? item.prompt || '音频' : fmtTime(item.completedAt || item.createdAt || 0)}</span>
          </button>
        ))}
        {!shown.length && <div className="cfind-empty">{done.length ? '无匹配结果' : '暂无生成记录'}</div>}
      </div>
    </div>
  );
}

// ---------- 工作流 ----------

export interface WorkflowMeta {
  id: string;
  name: string;
  count: number;
  updatedAt: number;
}

// 存下来的工作流。点一份，它的节点和连线就整套放到画布上，外面套一个同名的分组。
export function WorkflowPicker({ onPick }: { onPick: (id: string) => void }) {
  const [list, setList] = useState<WorkflowMeta[] | null>(null);
  const load = () =>
    api<{ items: WorkflowMeta[] }>('GET', '/api/workflows')
      .then((data) => setList(data.items))
      .catch((err) => toast(`工作流加载失败：${(err as Error).message}`, 'error', 6000));
  useEffect(() => {
    load();
  }, []);
  async function remove(item: WorkflowMeta) {
    try {
      await api('DELETE', `/api/workflows/${item.id}`);
      load();
    } catch (err) {
      toast((err as Error).message, 'error', 6000);
    }
  }
  return (
    <div className="popover-body cflows">
      {(list || []).map((item) => (
        <div key={item.id} className="cflows-item">
          <button type="button" className="menu-item cflows-pick" onClick={() => onPick(item.id)}>
            <Icon name="workflow" size={16} />
            <span className="cflows-name ellipsis">{item.name}</span>
            <span className="cflows-count">{item.count} 个节点</span>
          </button>
          <button type="button" className="icon-btn icon-btn-sm cnode-btn" {...tip('删除工作流')} aria-label={`删除工作流「${item.name}」`} onClick={() => remove(item)}>
            <Icon name="trash" size={16} />
          </button>
        </div>
      ))}
      {list && !list.length && <div className="cfind-empty">暂无工作流</div>}
    </div>
  );
}
