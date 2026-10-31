// 一个节点的历史版本：就地替换时被换下来的那些内容。
// 生成记录本身一直在「创作记录」里，这里只是这个节点的快捷入口：点「换回」就换回那一版，现在这一版退进历史。

import { useState } from 'react';
import type { Edge, Node, ReactFlowInstance } from '@xyflow/react';
import { state } from '../store.ts';
import { fmtTime } from '../format.ts';
import { recordName } from '../media.ts';
import { openDetail } from '../history.tsx';
import { openModal, toast } from '../ui/layers.tsx';
import { Icon } from '../ui/Icon.tsx';
import type { HistoryItem } from '../types.ts';
import { keepBefore, keptOf, type Generated, type Kept } from './model.ts';

type Flow = ReactFlowInstance<Node, Edge>;

// 一版写什么：生成出来的用提示词，上传的用文件名；生成记录已经被删掉了就直说。
function describe(entry: Kept, record: HistoryItem | undefined) {
  if (entry.upload) return { text: entry.upload.name, from: '上传' };
  if (!record) return { text: '这一版的生成记录已删除', from: '已删除' };
  return { text: (record.prompt || '').trim() || recordName(record), from: record.tool === 'sfx' ? '音效' : '生成' };
}

// 一版的缩略图：图片、视频用小图；音频、或者小图还没做出来时放个图标。
function Thumb({ entry, record, kind }: { entry: Kept; record: HistoryItem | undefined; kind: string }) {
  const url = entry.upload?.url || record?.thumbUrl || record?.mediaUrl || '';
  const shape = entry.upload ? kind : record?.kind || kind;
  if (!url || shape === 'audio') {
    return (
      <span className="cnode-kept-icon">
        <Icon name={shape === 'video' ? 'video' : shape === 'audio' ? 'music' : 'image'} size={18} />
      </span>
    );
  }
  return <img src={url} alt="" draggable={false} />;
}

function KeptList({ id, kind, flow, done }: { id: string; kind: string; flow: Flow; done: () => void }) {
  // 打开时节点里的历史版本。换回一次就关窗，所以不用跟着节点重画。
  const [entries] = useState(() => keptOf((flow.getNode(id)?.data || {}) as Generated));
  // 换回这一版：现在这一版退进历史，换回来的那一版从历史里拿掉（见 keepBefore）。
  const back = (entry: Kept) => {
    const data = (flow.getNode(id)?.data || {}) as Generated;
    flow.updateNodeData(id, keepBefore(data, { recordId: entry.recordId, upload: entry.upload, aspect: undefined }));
    done();
    toast('已换回这一版', 'success');
  };
  if (!entries.length) return <p className="muted">这个节点还没有换下来过内容。</p>;
  return (
    <div className="cnode-kept">
      {entries.map((entry, index) => {
        const record = entry.recordId ? state.history.find((item) => item.id === entry.recordId) : undefined;
        const { text, from } = describe(entry, record);
        const when = fmtTime(record?.createdAt || entry.at || undefined);
        // 记录已经不在创作记录里了：缩略图和内容都没有，换不回去。
        const gone = Boolean(entry.recordId) && !record;
        return (
          <div className="cnode-kept-item" key={entry.recordId || entry.upload?.url || index}>
            <Thumb entry={entry} record={record} kind={kind} />
            <span className="cnode-kept-text">
              <span className="cnode-kept-prompt">{text}</span>
              <span className="cnode-kept-meta">{[from, when].filter(Boolean).join(' · ')}</span>
            </span>
            {record && (
              <button className="btn btn-sm" type="button" onClick={() => openDetail(record.id)}>
                查看
              </button>
            )}
            {/* 记录被删掉的那一份没东西可换回来，按钮就灰着。 */}
            <button className="btn btn-sm btn-primary" type="button" disabled={gone} title={gone ? '这条生成记录已被删除' : undefined} onClick={() => back(entry)}>
              换回
            </button>
          </div>
        );
      })}
    </div>
  );
}

// 「更多」里点历史版本：列出来，能看、能换回。
export function openKept({ id, kind, data, flow }: { id: string; kind: string; data: Generated; flow: Flow }) {
  if (!keptOf(data).length) return;
  // done 只在点「换回」之后调用，那时候 modal 已经赋值了。
  const modal = openModal({
    title: '历史版本',
    subtitle: '这个节点里换下来过的内容。换回之后，现在这一版也留在这里。',
    size: 'md',
    content: <KeptList id={id} kind={kind} flow={flow} done={() => modal.close()} />,
  });
}
