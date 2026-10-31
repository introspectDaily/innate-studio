// 素材的界面：缩略图、上传面板、选择素材的弹窗。文件处理在 media.ts。

import { useEffect, useRef, useState } from 'react';
import { api, state, useStore, KINDS, loadCharacters } from './store.ts';
import { kindOfFile, uploadLocalFile, refFromRecord, recordName, type Progress } from './media.ts';
import { fmtTime, fmtBytes } from './format.ts';
import { toast, openModal } from './ui/layers.tsx';
import { SearchBox, Segmented, tip } from './ui/controls.tsx';
import { refsFromCharacter } from './composer/state.ts';
import type { HistoryItem, Kind, Ref, TosObjectList } from './types.ts';

const message = (err: unknown) => (err as Error).message;

export function Thumb({ thumb, kind }: { thumb?: string | null; kind: Kind }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!thumb || failed === thumb) return <div className="thumb-fallback">{KINDS[kind]?.label || '图片'}</div>;
  return <img className="thumb-img" src={thumb} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(thumb)} />;
}

// ---------- 上传面板 ----------

interface UploadRow {
  id: number;
  name: string;
  size: number;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  text: string;
}

interface UploadPaneProps<T> {
  // 为空时按文件类型自动判断。
  kind: Kind | null;
  limit?: number;
  upload: (file: File, kind: Kind, onProgress: Progress) => Promise<T>;
  onUploaded?: (result: T, kind: Kind) => void;
  onAllDone?: () => void;
  note?: string;
}

// 拖拽或选择文件，逐个上传并显示进度。
export function UploadPane<T>({ kind, limit = 1, upload, onUploaded, onAllDone, note }: UploadPaneProps<T>) {
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const nextRow = useRef(0);
  const patch = (id: number, change: Partial<UploadRow>) => setRows((list) => list.map((row) => (row.id === id ? { ...row, ...change } : row)));

  async function handle(files: File[]) {
    const accepted: { file: File; kind: Kind }[] = [];
    for (const file of files) {
      const fileKind = kindOfFile(file);
      if (!fileKind || (kind && fileKind !== kind)) {
        toast(`「${file.name}」不是${kind ? KINDS[kind].label : '图片、视频或音频'}文件，已跳过`, 'error');
        continue;
      }
      accepted.push({ file, kind: fileKind });
    }
    if (accepted.length > limit) toast(`最多还可添加 ${limit} 个，超出部分已忽略`, 'info');
    let failed = 0;
    for (const { file, kind: fileKind } of accepted.slice(0, limit)) {
      const id = nextRow.current++;
      setRows((list) => [...list, { id, name: file.name, size: file.size, progress: 0, status: 'uploading', text: '上传中' }]);
      try {
        const result = await upload(file, fileKind, (p) => patch(id, { progress: Math.round(p * 100) }));
        patch(id, { progress: 100, status: 'done', text: '已上传' });
        onUploaded?.(result, fileKind);
      } catch (err) {
        failed += 1;
        patch(id, { status: 'error', text: message(err) });
      }
    }
    if (accepted.length && !failed) onAllDone?.();
  }

  return (
    <div className="upload-pane">
      <div
        className={`dropzone${over ? ' over' : ''}`}
        tabIndex={0}
        role="button"
        onClick={() => input.current!.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current!.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          handle([...e.dataTransfer.files]);
        }}
      >
        <div className="dropzone-title">点击或拖拽文件到此处上传</div>
        <div className="muted small">{note || (kind ? `支持${KINDS[kind].label}文件` : '支持图片、视频、音频文件')}</div>
      </div>
      <input
        ref={input}
        type="file"
        className="visually-hidden"
        accept={kind ? KINDS[kind].accept : 'image/*,video/*,audio/*'}
        multiple={limit > 1}
        onChange={(e) => {
          handle([...(e.currentTarget.files || [])]);
          e.currentTarget.value = '';
        }}
      />
      <div className="upload-rows">
        {rows.map((row) => (
          <div key={row.id} className="upload-row">
            <div className="upload-row-main">
              <div className="ellipsis">{row.name}</div>
              <div className={`bar${row.status === 'error' ? ' bar-error' : ''}`}>
                <div className="bar-fill" style={{ width: `${row.progress}%` }} />
              </div>
            </div>
            <span className="muted small">{fmtBytes(row.size)}</span>
            <span className={row.status === 'done' ? 'small ok-text' : row.status === 'error' ? 'small error-text' : 'muted small'}>{row.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- 选择素材的弹窗（创作页用） ----------

type Source = 'upload' | 'tos' | 'records' | 'character';
const SOURCE_LABELS: Record<Source, string> = { upload: '本地上传', tos: 'TOS 素材', records: '生成记录', character: '角色' };

interface PickerOptions {
  // 只选一种素材时给 kind 和 remaining。几种都能选时给 limits（每种还能加几个）：不用先选类型，上传的、选中的是什么就算什么。
  kind?: Kind;
  remaining?: number;
  limits?: Partial<Record<Kind, number>>;
  // 已经用上的文件的地址：生成记录里同一份不让加第二次。
  usedUrls?: string[];
  // 弹窗的标题。没给就按能选的类型写。
  title?: string;
  onPick: (ref: Ref) => void;
  // 这次能用的来源，按显示顺序。没给就是本地上传、生成记录，能选图片时再加上角色。
  sources?: Source[];
}

const labelsOf = (kinds: Kind[]) => kinds.map((kind) => KINDS[kind].label).join('、');

// 生成记录里已经存到本机的结果。选中后直接引用这个文件。
function RecordGrid({ kinds, usedUrls, onPick }: { kinds: Kind[]; usedUrls: string[]; onPick: (ref: Ref) => void }) {
  const [busy, setBusy] = useState('');
  const list = state.history.filter((i) => kinds.includes(i.kind) && i.status === 'completed' && i.savedLocally).slice(0, 60);
  if (!list.length) return <div className="empty small-empty">暂无{labelsOf(kinds)}</div>;

  async function choose(item: HistoryItem) {
    setBusy(item.id);
    try {
      onPick(await refFromRecord(item));
    } catch (err) {
      toast(message(err), 'error', 6000);
      setBusy('');
    }
  }

  return (
    <div className="pick-grid">
      {list.map((item) => (
        <button key={item.id} className="pick-card" type="button" disabled={Boolean(busy) || usedUrls.includes(item.mediaUrl!)} {...tip(item.prompt)} onClick={() => choose(item)}>
          <div className="pick-thumb">{item.kind === 'video' && !item.thumbUrl ? <video className="thumb-img" src={item.mediaUrl} preload="metadata" muted playsInline /> : <Thumb thumb={item.thumbUrl || (item.kind === 'image' ? item.mediaUrl : null)} kind={item.kind} />}</div>
          <div className="pick-name ellipsis">{recordName(item)}</div>
          {usedUrls.includes(item.mediaUrl!) ? <span className="badge badge-ok">已添加</span> : <span className="badge badge-pending">{busy === item.id ? '加载中' : fmtTime(item.createdAt)}</span>}
        </button>
      ))}
    </div>
  );
}

// 角色库里的角色。选中一个，把它的参考图都加进来，放不下的不加。
function CharacterGrid({ remaining, onPick }: { remaining: number; onPick: (refs: Ref[]) => void }) {
  useStore('characters');
  useEffect(() => {
    if (!state.characters) loadCharacters().catch((err) => toast(message(err), 'error', 6000));
  }, []);
  const list = (state.characters || []).filter((c) => c.images.length);
  if (!list.length) return <div className="empty small-empty">{state.characters ? '暂无可用角色' : '加载中…'}</div>;
  return (
    <div className="pick-grid">
      {list.map((character) => (
        <button key={character.id} className="pick-card" type="button" {...tip(character.description)} onClick={() => onPick(refsFromCharacter(character).slice(0, remaining))}>
          <div className="pick-thumb">
            <Thumb thumb={character.images[0]} kind="image" />
          </div>
          <div className="pick-name ellipsis">{character.name}</div>
          <span className="badge badge-pending">{character.images.length} 张图</span>
        </button>
      ))}
    </div>
  );
}


// TOS 素材库里的公网素材。参考视频本来就是公网地址，选中后直接交给生成接口。
function TosGrid({ kinds, usedUrls, onPick }: { kinds: Kind[]; usedUrls: string[]; onPick: (ref: Ref) => void }) {
  const [items, setItems] = useState<TosObjectList['items']>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api<TosObjectList>('GET', '/api/tos/objects?limit=200')
      .then((data) => live && setItems(data.items))
      .catch((err) => live && setError(message(err)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);
  const list = items.filter((item) => kinds.includes(item.kind) && (!query || item.name.toLowerCase().includes(query)));
  function choose(item: TosObjectList['items'][number]) {
    onPick({ uid: crypto.randomUUID(), kind: item.kind, source: 'url', url: item.url, name: item.name.split('/').at(-1) || item.name, thumb: item.kind === 'image' ? item.url : null });
  }
  if (loading) return <div className="empty small-empty">读取素材库…</div>;
  if (error) return <div className="empty small-empty">{error}</div>;
  return (
    <>
      <div className="picker-tos-toolbar">
        <SearchBox label="搜索 TOS 素材" onQuery={(value) => setQuery(value)} />
        <span className="muted small">共 {list.length} 个可用素材</span>
      </div>
      {list.length ? (
        <div className="pick-grid">
          {list.map((item) => (
            <button key={item.key} className="pick-card" type="button" disabled={usedUrls.includes(item.url)} {...tip(item.name)} onClick={() => choose(item)}>
              <div className="pick-thumb">
                {item.kind === 'image' ? <Thumb thumb={item.url} kind="image" /> : item.kind === 'video' ? <video className="thumb-img" src={item.url} preload="metadata" muted playsInline /> : <div className="thumb-fallback">音频</div>}
              </div>
              <div className="pick-name ellipsis">{item.name.split('/').at(-1)}</div>
              {usedUrls.includes(item.url) ? <span className="badge badge-ok">已添加</span> : <span className="badge badge-pending">TOS</span>}
            </button>
          ))}
        </div>
      ) : (
        <div className="empty small-empty">{query ? '没有匹配的素材' : 'TOS 素材库里还没有这类素材'}</div>
      )}
    </>
  );
}

function AssetPicker({ kind, remaining = 1, limits, usedUrls = [], onPick, sources, close }: PickerOptions & { sources: Source[]; close: () => void }) {
  const [tab, setTab] = useState(sources[0]);
  // 每种素材还能加几个。选一个少一个。
  const left = useRef<Partial<Record<Kind, number>>>(limits ?? { [kind!]: remaining }).current;
  const open = (k: Kind) => (left[k] || 0) > 0;
  const kinds = (Object.keys(KINDS) as Kind[]).filter(open);
  const room = kinds.reduce((sum, k) => sum + left[k]!, 0);
  const pick = (ref: Ref) => {
    onPick(ref);
    left[ref.kind] = (left[ref.kind] || 0) - 1;
  };
  const pickAndClose = (ref: Ref) => {
    pick(ref);
    close();
  };
  // 上传的文件是什么类型就算什么。这里用不了的类型、已经加满的类型，在那一行说明原因。
  const upload = async (file: File, k: Kind, onProgress: Progress): Promise<Ref> => {
    if (!(k in left)) throw new Error(`不支持${KINDS[k].label}`);
    if (!open(k)) throw new Error(`${KINDS[k].label}数量已达上限`);
    return uploadLocalFile(file, k, onProgress);
  };
  const several = Object.keys(left).length > 1;

  return (
    <>
      <div>
        <Segmented options={sources.map((value) => ({ value, label: SOURCE_LABELS[value] }))} value={tab} onChange={setTab} className="tabs" />
      </div>
      {/* 换来源时弹窗的大小不变：这一块固定高，内容多了在里面滚 */}
      <div className="tab-pane picker-pane">
        {tab === 'upload' && <UploadPane<Ref> kind={several ? null : kinds[0] || kind || null} limit={room} upload={upload} onUploaded={pick} onAllDone={close} />}
        {tab === 'tos' && <TosGrid kinds={kinds} usedUrls={usedUrls} onPick={pickAndClose} />}
        {tab === 'records' && <RecordGrid kinds={kinds} usedUrls={usedUrls} onPick={pickAndClose} />}
        {tab === 'character' && (
          <CharacterGrid
            remaining={left.image || 0}
            onPick={(refs) => {
              refs.forEach(pick);
              close();
            }}
          />
        )}
      </div>
    </>
  );
}

export function openAssetPicker(options: PickerOptions) {
  const kinds = options.limits ? (Object.keys(options.limits) as Kind[]) : [options.kind!];
  // 角色的参考图是图片，所以只在能选图片时出现。
  const sources: Source[] = options.sources ?? ['upload', 'records', 'tos', ...(kinds.includes('image') ? (['character'] as const) : [])];
  const modal = openModal({ title: options.title || (kinds.length > 1 ? '添加参考素材' : `添加${KINDS[kinds[0]].label}`), size: 'md', content: <AssetPicker {...options} sources={sources} close={() => modal.close()} /> });
}
