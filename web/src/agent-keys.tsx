// 设置里的「Agent Keys」：给 Codex、Claude Code 这类编程客户端用的访问令牌（Access Token）。
// 令牌只用于调用本机接口，和「管理」里存的火山/AiHubMix 等平台 Key 不是一回事。
// 一个令牌绑定到当前账号：空间隔离、积分、角色都跟着这个账号走。明文只在创建时返回一次，
// 磁盘上只存散列，所以列表里只能看到前缀。——本机模式没有账号，创建/查看/吊销都走命令行。

import { useEffect, useRef, useState } from 'react';
import { api, state } from './store.ts';
import { fmtTime } from './format.ts';
import { FormRow, Segmented } from './ui/controls.tsx';
import { confirmDialog, copyText, openModal, toast } from './ui/layers.tsx';

export interface AgentKey {
  id: string;
  name: string;
  // read 只能查（GET），write 才能生成、上传。
  scope: 'read' | 'write';
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}
// 只有新建的那一次带 token，之后列表里再也读不到。
interface CreatedKey extends AgentKey {
  token: string;
}

const SCOPE_LABEL: Record<AgentKey['scope'], string> = { read: '只读', write: '可生成' };
const message = (err: unknown) => (err as Error).message;

// 新建成功后的弹窗：关掉就再也看不到了，所以放着能一键复制，并且要求先复制再关。
function CreatedDialog({ created, close }: { created: CreatedKey; close: () => void }) {
  return (
    <>
      <p className="muted small">令牌已创建。<strong>只显示这一次</strong>，关闭后无法再次查看，请立即复制保存。</p>
      <label className="field-label">{created.name}</label>
      <p className="mono confirm-text">{created.token}</p>
      <div className="modal-actions">
        <button className="btn" type="button" onClick={() => copyText(created.token, '令牌已复制')}>
          复制
        </button>
        <button className="btn btn-primary" type="button" onClick={close}>
          我已保存
        </button>
      </div>
    </>
  );
}

export function AgentKeysSection() {
  const user = state.app.user;
  const nameRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<AgentKey[]>([]);
  const [filled, setFilled] = useState(false);
  const [scope, setScope] = useState<AgentKey['scope']>('write');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    try {
      const { items } = await api<{ items: AgentKey[] }>('GET', '/api/agent-keys');
      setItems(items);
      setError('');
    } catch (err) {
      setError(message(err));
      setItems([]);
    }
  }

  // 本机模式（没有账号）的接口会直接报错，所以只在多人模式下才拉列表。
  useEffect(() => {
    if (user) load();
  }, [user?.id]);

  async function add() {
    const name = nameRef.current?.value.trim() || '';
    if (!name) return;
    setBusy(true);
    setError('');
    try {
      const created = await api<CreatedKey>('POST', '/api/agent-keys', { name, scope });
      if (nameRef.current) nameRef.current.value = '';
      setFilled(false);
      await load();
      const modal = openModal({ title: 'Agent Key', size: 'sm', content: <CreatedDialog created={created} close={() => modal.close()} /> });
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(key: AgentKey) {
    const ok = await confirmDialog({
      title: `吊销令牌「${key.name}」？`,
      message: '用它调用接口的客户端会立即失效，且无法撤销。',
      okText: '吊销',
      danger: true,
    });
    if (!ok) return;
    try {
      await api('DELETE', `/api/agent-keys/${key.id}`);
      toast('令牌已吊销', 'success');
      await load();
    } catch (err) {
      setError(message(err));
    }
  }

  return (
    <section className="settings-group">
      <h3>Agent Keys</h3>
      <div className="settings-card">
        {/* 本机模式：没有账号，只能走命令行。 */}
        {!user && (
          <p className="settings-hint">
            本机模式没有账号，请用命令行管理令牌：<span className="mono">pnpm user token add</span>（另有 list、revoke）。
          </p>
        )}

        {user &&
          items.map((key) => (
            <FormRow
              key={key.id}
              label={key.name}
              desc={[SCOPE_LABEL[key.scope], `创建于 ${fmtTime(key.createdAt) || '—'}`, key.lastUsedAt ? `最近使用 ${fmtTime(key.lastUsedAt)}` : '尚未使用'].join(' · ')}
            >
              <span className="muted small mono">{key.prefix}…</span>
              <button className="btn btn-sm" type="button" onClick={() => revoke(key)}>
                吊销
              </button>
            </FormRow>
          ))}

        {user && (
          <div className="form-row">
            <div className="form-control key-edit">
              <input
                ref={nameRef}
                className="input"
                type="text"
                placeholder="新令牌的名称，如 codex"
                maxLength={40}
                aria-label="新令牌的名称"
                onInput={(e) => setFilled(Boolean(e.currentTarget.value.trim()))}
                onKeyDown={(e) => e.key === 'Enter' && add()}
              />
              <Segmented
                options={[
                  { value: 'write', label: '可生成' },
                  { value: 'read', label: '只读' },
                ]}
                value={scope}
                onChange={(next) => setScope(next)}
              />
              <button className={`btn${filled ? ' btn-primary' : ''}`} type="button" disabled={busy || !filled} onClick={add}>
                创建
              </button>
            </div>
          </div>
        )}

        {user && <p className="settings-hint">令牌等同于该账号的操作权，请只交给可信的客户端。用法见 SKILL.md。</p>}
        <p className="form-error" role="alert">
          {error}
        </p>
      </div>
    </section>
  );
}
