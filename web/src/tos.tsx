// 素材库：本地素材优先，TOS 云端对象作为团队素材库；公网链接按需生成并缓存。

import { useEffect, useRef, useState } from 'react';
import { api, canManage } from './store.ts';
import { fmtBytes, fmtTime } from './format.ts';
import { UploadPane } from './assets.tsx';
import { uploadLocalFile, uploadTosFile, type Progress } from './media.ts';
import { FormRow, SearchBox, Segmented } from './ui/controls.tsx';
import { Icon } from './ui/Icon.tsx';
import { confirmDialog, copyText, openModal, toast } from './ui/layers.tsx';
import type { Kind, LocalMaterial, Publication, Ref, StorageStatus, TosConfig, TosObject, TosObjectList } from './types.ts';

const message = (err: unknown) => (err as Error).message;
type MaterialTab = 'local' | 'cloud';

// ---------- 配置 ----------

const DEFAULT_CONFIG = { bucket: '', prefix: '', region: 'cn-beijing', endpoint: 'tos-cn-beijing.volces.com', publicBaseUrl: '' };

function sourceLabel(source: TosConfig['credentialSource']) {
  if (source === 'env') return '来自环境变量';
  if (source === 'tos-file') return '保存在服务器';
  if (source === 'file') return '沿用火山引擎 Access Key';
  return '';
}

// 管理弹窗里的 TOS 配置。保存时服务端会 headBucket 校验，Bucket 不存在就拒绝；程序不会创建 Bucket。
export function TosSettings({ onSaved }: { onSaved?: (config: TosConfig) => void }) {
  const [config, setConfig] = useState<TosConfig | null>(null);
  const [form, setForm] = useState(DEFAULT_CONFIG);
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    api<TosConfig>('GET', '/api/tos/config')
      .then((next) => {
        if (!live) return;
        setConfig(next);
        setForm({ bucket: next.bucket || '', prefix: next.prefix || '', region: next.region || DEFAULT_CONFIG.region, endpoint: next.endpoint || DEFAULT_CONFIG.endpoint, publicBaseUrl: next.publicBaseUrl || '' });
      })
      .catch((err) => live && setError(message(err)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  const change = (key: keyof typeof form, value: string) => setForm((now) => ({ ...now, [key]: value }));

  async function save() {
    setSaving(true);
    setError('');
    try {
      const next = await api<TosConfig>('PUT', '/api/tos/config', { ...form, ...(accessKeyId || secretAccessKey ? { accessKeyId, secretAccessKey } : {}) });
      setConfig(next);
      setAccessKeyId('');
      setSecretAccessKey('');
      toast('TOS 配置已保存，Bucket 校验通过', 'success');
      onSaved?.(next);
    } catch (err) {
      setError(message(err));
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    const ok = await confirmDialog({ title: '清除 TOS 配置？', message: '只会删除本地保存的连接配置，不会删除 Bucket，也不会删除 Bucket 里的文件。', okText: '清除配置', danger: true });
    if (!ok) return;
    try {
      const next = await api<TosConfig>('DELETE', '/api/tos/config');
      setConfig(next);
      setForm(DEFAULT_CONFIG);
      setAccessKeyId('');
      setSecretAccessKey('');
      toast('TOS 配置已清除', 'success');
      onSaved?.(next);
    } catch (err) {
      setError(message(err));
    }
  }

  if (loading) return <p className="muted small">读取 TOS 配置…</p>;

  return (
    <div className="settings tos-config">
      <section className="settings-group">
        <h3>火山引擎 TOS</h3>
        <div className="settings-card">
          <FormRow label="Bucket" desc="必须已在火山引擎控制台创建">
            <input className="input mono" value={form.bucket} placeholder="my-media-bucket" autoComplete="off" onChange={(e) => change('bucket', e.target.value)} />
          </FormRow>
          <FormRow label="前缀路径" desc="可留空；保存时会在这个路径下创建 .keep 标记">
            <input className="input mono" value={form.prefix} placeholder="innate-studio" autoComplete="off" onChange={(e) => change('prefix', e.target.value)} />
          </FormRow>
          <FormRow label="Region">
            <input className="input mono" value={form.region} placeholder="cn-beijing" autoComplete="off" onChange={(e) => change('region', e.target.value)} />
          </FormRow>
          <FormRow label="Endpoint">
            <input className="input mono" value={form.endpoint} placeholder="tos-cn-beijing.volces.com" autoComplete="off" onChange={(e) => change('endpoint', e.target.value)} />
          </FormRow>
          <FormRow label="公开访问域名" desc="可选；没有 CDN/自定义域名时留空">
            <input className="input mono" value={form.publicBaseUrl} placeholder="https://media.example.com" autoComplete="off" onChange={(e) => change('publicBaseUrl', e.target.value)} />
          </FormRow>
        </div>
      </section>

      <section className="settings-group">
        <h3>访问凭证</h3>
        <div className="settings-card">
          {config?.hasCredentials ? (
            <FormRow label="Access Key" desc={sourceLabel(config.credentialSource)}>
              <span className="mono">{config.credentialHint}</span>
            </FormRow>
          ) : (
            <p className="settings-hint">还没有可用的 Access Key。可使用 INNATE_STUDIO_VOLC_TOS_ACCESS_KEY_ID / INNATE_STUDIO_VOLC_TOS_ACCESS_KEY 环境变量，或在这里填写。</p>
          )}
          <FormRow label={config?.hasCredentials ? '更换 Access Key ID' : 'Access Key ID'}>
            <input className="input mono" value={accessKeyId} placeholder={config?.hasCredentials ? '留空则不修改' : 'Access Key ID'} autoComplete="off" onChange={(e) => setAccessKeyId(e.target.value)} />
          </FormRow>
          <FormRow label={config?.hasCredentials ? '更换 Secret Access Key' : 'Secret Access Key'}>
            <input className="input mono masked" type="password" value={secretAccessKey} placeholder={config?.hasCredentials ? '留空则不修改' : 'Secret Access Key'} autoComplete="new-password" onChange={(e) => setSecretAccessKey(e.target.value)} />
          </FormRow>
        </div>
      </section>

      <p className="settings-hint">Bucket 不会由 Innate Studio 创建。参考视频和素材使用对象公开读 ACL；请确保 Bucket 允许公开读，或配置能公开访问该 Bucket 的自定义域名。</p>
      <p className="form-error" role="alert">{error}</p>
      <div className="modal-actions">
        {config?.configured && <button className="btn btn-danger" type="button" onClick={clear}>清除配置</button>}
        <button className="btn btn-primary" type="button" disabled={saving || !form.bucket} onClick={save}>{saving ? '正在校验 Bucket…' : '保存并校验 Bucket'}</button>
      </div>
    </div>
  );
}

// ---------- 通用素材展示 ----------

const kindLabel = (kind: Kind) => (kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频');
const kindIcon = (kind: Kind) => (kind === 'image' ? 'image' : kind === 'video' ? 'video' : 'music');

function MediaThumb({ url, kind, name }: { url: string; kind: Kind; name: string }) {
  if (kind === 'image') return <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" />;
  if (kind === 'video') return <video src={url} preload="metadata" muted playsInline />;
  return (
    <span className="material-audio-thumb">
      <Icon name="music" size={30} />
      <span>{name}</span>
    </span>
  );
}

function publicationLabel(publication: Publication) {
  const direct = publication.direct ? '直链' : '分享页';
  return `TOS ${direct}${publication.expiresAt ? ` · 至 ${fmtTime(Date.parse(publication.expiresAt))}` : ''}`;
}

function preview(title: string, url: string, kind: Kind, publicUrl?: string) {
  openModal({
    title,
    size: 'lg',
    content: (
      <div className="material-preview">
        {kind === 'image' && <img src={url} alt={title} />}
        {kind === 'video' && <video src={url} controls autoPlay playsInline />}
        {kind === 'audio' && <audio src={url} controls autoPlay />}
        <div className="material-preview-foot">
          <span className="muted small">素材本体保存在本地</span>
          {publicUrl && <button className="btn btn-sm" type="button" onClick={() => copyText(publicUrl, '公网链接已复制')}>复制公网链接</button>}
        </div>
      </div>
    ),
  });
}

// ---------- 本地素材 ----------

function LocalRenameForm({ item, done, close }: { item: LocalMaterial; done: (item: LocalMaterial) => void; close: () => void }) {
  const [name, setName] = useState(item.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  async function submit() {
    setSaving(true);
    setError('');
    try {
      const next = await api<LocalMaterial>('PUT', `/api/materials/${encodeURIComponent(item.id)}`, { name });
      done(next);
      close();
    } catch (err) {
      setError(message(err));
      setSaving(false);
    }
  }
  return (
    <>
      <label className="field-label">素材名称</label>
      <input ref={input} className="input" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      <p className="muted small">只修改显示名称，本地文件名不会变。</p>
      <p className="form-error" role="alert">{error}</p>
      <div className="modal-actions">
        <button className="btn" type="button" onClick={close}>取消</button>
        <button className="btn btn-primary" type="button" disabled={saving || !name.trim()} onClick={submit}>{saving ? '保存中…' : '保存'}</button>
      </div>
    </>
  );
}

function LocalMaterialCard({ item, status, reload }: { item: LocalMaterial; status: StorageStatus | null; reload: () => void }) {
  const manage = canManage();
  const share = item.publications.find((publication) => publication.valid);
  const latest = item.publications[0];
  const [publishing, setPublishing] = useState(false);

  async function publish() {
    setPublishing(true);
    try {
      const result = await api<Publication & { publications: Publication[] }>('POST', '/api/materials/publish', { url: item.url, purpose: 'share' });
      toast(`已发布到 TOS${result.expiresAt ? `，${fmtTime(Date.parse(result.expiresAt))} 前有效` : ''}`, 'success', 5000);
      reload();
    } catch (err) {
      toast(message(err), 'error', 7000);
    } finally {
      setPublishing(false);
    }
  }

  function rename() {
    const modal = openModal({
      title: '重命名本地素材',
      size: 'sm',
      content: <LocalRenameForm item={item} close={() => modal.close()} done={() => reload()} />,
    });
  }

  async function remove() {
    const ok = await confirmDialog({ title: `删除「${item.name}」？`, message: '会删除本机 uploads 里的源文件；已发布的公网副本不会自动删除。', okText: '删除', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', `/api/materials/${encodeURIComponent(item.id)}`);
      toast('本地素材已删除', 'success');
      reload();
    } catch (err) {
      toast(message(err), 'error');
    }
  }

  return (
    <article className="material-card">
      <button className="material-thumb" type="button" aria-label={`预览 ${item.name}`} onClick={() => preview(item.name, item.url, item.kind, share?.url)}>
        <MediaThumb url={item.url} kind={item.kind} name={item.name} />
        <span className="material-kind"><Icon name={kindIcon(item.kind)} size={14} />{kindLabel(item.kind)}</span>
        <span className="material-local-badge">本地</span>
      </button>
      <div className="material-info">
        <div className="material-name" title={item.name}>{item.name}</div>
        <div className="muted small">{fmtBytes(item.size)} · {fmtTime(item.createdAt)}</div>
        {share ? <div className="material-publication"><Icon name="folder" size={13} /><span>{publicationLabel(share)}</span></div> : latest ? <div className="material-publication is-stale"><Icon name="folder" size={13} /><span>公网链接待校验</span></div> : null}
      </div>
      <div className="material-actions">
        <button className="btn btn-sm" type="button" onClick={() => copyText(new URL(item.url, location.origin).href, '本地链接已复制')}>本地链接</button>
        {share ? (
          <button className="btn btn-sm" type="button" onClick={() => copyText(share.url, '公网链接已复制')}>复制公网链接</button>
        ) : (
          <button className="btn btn-sm" type="button" disabled={publishing || (!status?.preferred)} onClick={publish}>{publishing ? '发布中…' : latest ? '校验公网链接' : '发布公网'}</button>
        )}
        {manage && <button className="btn btn-sm" type="button" onClick={rename}>重命名</button>}
        {manage && <button className="btn btn-sm btn-danger" type="button" onClick={remove}>删除</button>}
      </div>
    </article>
  );
}

function LocalMaterials({ status, reloadStatus }: { status: StorageStatus | null; reloadStatus: () => void }) {
  const [items, setItems] = useState<LocalMaterial[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const data = await api<{ items: LocalMaterial[] }>('GET', '/api/materials');
      setItems(data.items);
    } catch (err) {
      setError(message(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const shown = items.filter((item) => !search || item.name.toLowerCase().includes(search));
  const upload = async (file: File, kind: Kind, onProgress: Progress): Promise<Ref> => uploadLocalFile(file, kind, onProgress);

  return (
    <>
      <div className="materials-strategy">
        <div>
          <strong>本地优先</strong>
          <span>作品先保存在本机；只有分享或生成接口必须使用公网 URL 时才发布。</span>
        </div>
        <div className="materials-strategy-links">
          <span className="badge badge-ok">分享优先 {status?.tos.configured ? 'TOS' : '未配置'}</span>
          <span className="badge badge-pending">参考直链 {status?.direct === 'tos' ? 'TOS' : '未配置'}</span>
        </div>
      </div>

      <section className="settings-group">
        <h3>上传本地素材</h3>
        <UploadPane<Ref> kind={null} limit={20} upload={upload} onAllDone={load} note="上传后保存在本机；需要公网链接时再按需发布" />
      </section>

      <div className="page-tools materials-toolbar">
        <SearchBox label="搜索本地素材" onQuery={setSearch} />
        <div className="materials-toolbar-actions">
          {status && !status.preferred && <span className="muted small">尚未配置公网存储；本地创作不受影响。</span>}
          <button className="icon-btn" type="button" aria-label="刷新素材" onClick={() => { load(); reloadStatus(); }} disabled={loading}><Icon name="undo" /></button>
        </div>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      {loading ? (
        <div className="empty">读取本地素材…</div>
      ) : shown.length === 0 ? (
        <div className="empty">
          <Icon name="folder" size={30} />
          <div className="empty-title">{search ? '没有匹配的素材' : '本地素材库还是空的'}</div>
          <p className="muted">从上方上传图片、视频或音频。生成记录仍可在「创作记录」里查看。</p>
        </div>
      ) : (
        <div className="materials-grid">
          {shown.map((item) => <LocalMaterialCard key={item.id} item={item} status={status} reload={load} />)}
        </div>
      )}
    </>
  );
}

// ---------- TOS 云端素材 ----------

function TosRenameForm({ item, done, close }: { item: TosObject; done: (item: TosObject, previous: TosObject) => void; close: () => void }) {
  const [name, setName] = useState(item.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  async function submit() {
    if (!name.trim() || name.trim() === item.name) return close();
    setSaving(true);
    setError('');
    try {
      const next = await api<TosObject>('PUT', '/api/tos/objects', { key: item.key, name: name.trim() });
      done(next, item);
      close();
    } catch (err) {
      setError(message(err));
      setSaving(false);
    }
  }
  return (
    <>
      <label className="field-label">文件名 / 路径</label>
      <input ref={input} className="input mono" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      <p className="muted small">可以带目录，例如 videos/campaign/final.mp4。</p>
      <p className="form-error" role="alert">{error}</p>
      <div className="modal-actions">
        <button className="btn" type="button" onClick={close}>取消</button>
        <button className="btn btn-primary" type="button" disabled={saving} onClick={submit}>{saving ? '重命名中…' : '重命名'}</button>
      </div>
    </>
  );
}

function TosCloud() {
  const [config, setConfig] = useState<TosConfig | null>(null);
  const [items, setItems] = useState<TosObject[]>([]);
  const [nextCursor, setNextCursor] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const query = useRef('');
  const sequence = useRef(0);
  const manage = canManage();

  async function loadPage({ append = false, cursor = '', reset = false, text = query.current }: { append?: boolean; cursor?: string; reset?: boolean; text?: string } = {}) {
    const id = ++sequence.current;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError('');
    try {
      const data = await api<TosObjectList>('GET', `/api/tos/objects?prefix=${encodeURIComponent(text)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (id !== sequence.current) return;
      setItems((now) => (append ? [...now, ...data.items.filter((item) => !now.some((old) => old.key === item.key))] : data.items));
      setNextCursor(data.nextCursor || '');
      if (reset) setItems(data.items);
    } catch (err) {
      if (id === sequence.current) setError(message(err));
    } finally {
      if (id === sequence.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }

  useEffect(() => {
    let live = true;
    api<TosConfig>('GET', '/api/tos/config')
      .then((next) => {
        if (!live) return;
        setConfig(next);
        if (next.configured) loadPage({ reset: true, text: '' });
        else setLoading(false);
      })
      .catch((err) => {
        if (!live) return;
        setError(message(err));
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    query.current = search;
    if (!config?.configured) return;
    const timer = setTimeout(() => loadPage({ reset: true, text: search }), 250);
    return () => clearTimeout(timer);
  }, [search, config?.configured]);

  const upload = async (file: File, _kind: Kind, onProgress: Progress): Promise<Ref> => uploadTosFile(file, onProgress);

  function afterRename(next: TosObject, previous: TosObject) {
    setItems((now) => now.map((item) => (item.key === previous.key ? next : item)));
    toast('已重命名', 'success');
    loadPage({ reset: true });
  }

  async function remove(item: TosObject) {
    const ok = await confirmDialog({ title: `删除「${item.name}」？`, message: '这会把对象从 TOS Bucket 中永久删除，正在使用它的生成记录可能无法再访问。', okText: '删除', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', `/api/tos/objects?key=${encodeURIComponent(item.key)}`);
      setItems((now) => now.filter((old) => old.key !== item.key));
      toast('素材已删除', 'success');
    } catch (err) {
      toast(message(err), 'error', 6000);
    }
  }

  function openRename(item: TosObject) {
    const modal = openModal({ title: '重命名 TOS 素材', size: 'sm', content: <TosRenameForm item={item} close={() => modal.close()} done={afterRename} /> });
  }

  function openConfig() {
    const modal = openModal({
      title: 'TOS 素材库配置',
      size: 'md',
      content: <TosSettings onSaved={(next) => {
        setConfig(next);
        if (next.configured) loadPage({ reset: true });
        else setItems([]);
        modal.close();
      }} />,
    });
  }

  return (
    <>
      <div className="materials-strategy">
        <div>
          <strong>TOS 云端对象</strong>
          <span>这里显式管理的团队公网素材；生成时自动上传的参考视频也在同一前缀下。</span>
        </div>
        <div className="page-tools">
          {config?.configured && <SearchBox label="按 TOS 路径前缀搜索" onQuery={setSearch} />}
          {config?.configured && <button className="icon-btn" type="button" aria-label="刷新素材" onClick={() => loadPage({ reset: true })} disabled={loading}><Icon name="undo" /></button>}
          {manage && <button className="btn" type="button" onClick={openConfig}>{config?.configured ? '配置' : '配置 TOS'}</button>}
        </div>
      </div>

      {config?.configured && config.publicBaseUrl && <p className="settings-hint">公网访问域名：<span className="mono">{config.publicBaseUrl}</span></p>}
      {!config?.configured && (
        <div className="empty materials-empty">
          <Icon name="folder" size={34} />
          <div className="empty-title">还没有配置 TOS 云端素材库</div>
          <p className="muted">本地素材不依赖 TOS。需要给模型提供参考视频直链时，再配置已有 Bucket。</p>
          {manage ? <button className="btn btn-primary" type="button" onClick={openConfig}>配置已有 Bucket</button> : <p className="muted small">请联系管理员配置。</p>}
        </div>
      )}
      {config?.configured && manage && (
        <section className="settings-group">
          <h3>显式上传到 TOS</h3>
          <UploadPane<Ref> kind={null} limit={20} upload={upload} onAllDone={() => loadPage({ reset: true })} note="这里会直接写入云端；普通素材请优先使用「本地素材」" />
        </section>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {config?.configured && (
        <>
          {loading ? (
            <div className="empty">读取 TOS 素材…</div>
          ) : items.length === 0 ? (
            <div className="empty">
              <Icon name="folder" size={30} />
              <div className="empty-title">{search ? '没有匹配的素材' : 'TOS 素材库还是空的'}</div>
              <p className="muted">{manage ? '上传图片、视频或音频，创作时就能直接选用。' : '管理员还没有上传素材。'}</p>
            </div>
          ) : (
            <div className="materials-grid">
              {items.map((item) => (
                <article className="material-card" key={item.key}>
                  <button className="material-thumb" type="button" aria-label={`预览 ${item.name}`} onClick={() => preview(item.name, item.url, item.kind, item.url)}>
                    <MediaThumb url={item.url} kind={item.kind} name={item.name} />
                    <span className="material-kind"><Icon name={kindIcon(item.kind)} size={14} />{kindLabel(item.kind)}</span>
                    <span className="material-local-badge">TOS</span>
                  </button>
                  <div className="material-info">
                    <div className="material-name" title={item.name}>{item.name}</div>
                    <div className="muted small">{[fmtBytes(item.size), item.lastModified ? fmtTime(Date.parse(item.lastModified)) : ''].filter(Boolean).join(' · ')}</div>
                  </div>
                  <div className="material-actions">
                    <button className="btn btn-sm" type="button" onClick={() => copyText(item.url, '公网链接已复制')}>复制链接</button>
                    {manage && <button className="btn btn-sm" type="button" onClick={() => openRename(item)}>重命名</button>}
                    {manage && <button className="btn btn-sm btn-danger" type="button" onClick={() => remove(item)}>删除</button>}
                  </div>
                </article>
              ))}
            </div>
          )}
          {nextCursor && (
            <div className="materials-more">
              <button className="btn" type="button" disabled={loadingMore} onClick={() => loadPage({ append: true, cursor: nextCursor })}>{loadingMore ? '加载中…' : '加载更多'}</button>
            </div>
          )}
        </>
      )}
    </>
  );
}

// ---------- 页面 ----------

export function Materials() {
  const [tab, setTab] = useState<MaterialTab>('local');
  const [status, setStatus] = useState<StorageStatus | null>(null);

  async function loadStatus() {
    try {
      setStatus(await api<StorageStatus>('GET', '/api/storage/status'));
    } catch {
      setStatus(null);
    }
  }

  useEffect(() => {
    loadStatus();
  }, []);

  return (
    <div className="page materials-page">
      <header className="page-head">
        <div>
          <h1>素材库</h1>
          <p className="muted">素材默认保存在本地；公网链接按需生成，并缓存有效地址避免重复上传。</p>
        </div>
        <Segmented
          className="tabs"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'local', label: '本地素材' },
            { value: 'cloud', label: 'TOS 云端' },
          ]}
        />
      </header>
      {tab === 'local' ? <LocalMaterials status={status} reloadStatus={loadStatus} /> : <TosCloud />}
    </div>
  );
}
