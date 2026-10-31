// 管理：成员和积分、模型平台的几个 Key、各账户的余额。多人模式下只有管理员打得开，相关的接口服务端也只认管理员。
// 这个文件单独打包，点开「管理」时才加载。

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, state, useStore, loadApp, loadModels, loadBalance, loadFlows, isAdmin } from './store.ts';
import { AIHUBMIX, ARK, DOUBAO_SPEECH, MINIMAX, VOLC_BILLING } from '../../shared/models.ts';
import { fmtCredits, fmtTime } from './format.ts';
import { Segmented, FormRow } from './ui/controls.tsx';
import { toast, openMenu, openModal, confirmDialog, copyText } from './ui/layers.tsx';
import { TosSettings } from './tos.tsx';

const amount = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const message = (err: unknown) => (err as Error).message;

export default function Admin() {
  useStore('app');
  const { hasKey, keyHint, keySource } = state.app;
  const { label: platform } = ARK;

  async function save(value: string) {
    try {
      state.app = await api('PUT', '/api/key', { apiKey: value });
      await loadApp();
      toast('API Key 已保存', 'success');
      // 换了 Key，可用的模型要重新读一遍。
      loadModels();
      return true;
    } catch (err) {
      toast(message(err), 'error', 6000);
      return false;
    }
  }

  async function remove() {
    const ok = await confirmDialog({ title: `清除已保存的${platform} API Key？`, message: '清除后，进行中的任务将暂停查询。', okText: '清除', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', '/api/key');
      await loadApp();
      toast('已清除', 'success');
    } catch (err) {
      toast(message(err), 'error');
    }
  }

  return (
    <div className="settings">
      {isAdmin() && <MembersSection />}
      <section className="settings-group">
        <h3>模型平台</h3>
        <div className="settings-card">
          <KeyRow
            name={platform}
            label={`${platform} API Key`}
            desc="Seedance、Seedream、提示词润色"
            placeholder="粘贴 API Key"
            copyHint={`请从${platform}控制台重新复制。`}
            hasKey={hasKey}
            keyHint={keyHint}
            keySource={keySource}
            onSave={save}
            onRemove={remove}
          />
          <MinimaxKey />
          <AihubmixKey />
          <SpeechKey />
          <AutodlKey />
        </div>
      </section>

      <BillingKey />
      <TosSettings />
      <p className="settings-hint">{state.app.hosted ? '密钥仅保存在服务器，成员不可见。' : '密钥仅保存在本地。'}</p>
    </div>
  );
}

// ---------- 成员和积分 ----------

interface Member {
  id: string;
  name: string;
  role: 'admin' | 'member';
  disabled: boolean;
  lastSeenAt: number | null;
  // 剩多少积分，和这个月花了多少。
  credits: number;
  monthUsed: number;
}

// 新建账号、重置密码之后，密码只在这里出现一次。
function showPassword(name: string, password: string) {
  const modal = openModal({
    title: `${name} 的初始密码`,
    size: 'sm',
    // 关掉就再也看不到了，只能重置：只留「复制并关闭」。
    dismissible: false,
    content: (
      <>
        <p className="mono confirm-text">{password}</p>
        <p className="muted small">仅显示一次。成员登录后可在「设置」中修改。</p>
        <div className="modal-actions">
          <button
            className="btn btn-primary"
            onClick={() => {
              copyText(password, '已复制');
              modal.close();
            }}
          >
            复制并关闭
          </button>
        </div>
      </>
    ),
  });
}

// 发放积分。填负数是扣回。
function GrantDialog({ member, done }: { member: Member; done: () => void }) {
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  async function submit() {
    const value = Math.round(Number(input.current!.value));
    if (!value) return toast('请输入积分数', 'error');
    setBusy(true);
    try {
      await api('POST', `/api/users/${member.id}/credits`, { amount: value });
      toast(value > 0 ? `已发放 ${fmtCredits(value)}` : `已扣回 ${fmtCredits(-value)}`, 'success');
      done();
    } catch (err) {
      toast(message(err), 'error', 6000);
      setBusy(false);
    }
  }
  return (
    <>
      <p className="muted small">{`当前 ${fmtCredits(member.credits)} · 100 积分 = ¥1`}</p>
      <input ref={input} className="input" type="text" inputMode="numeric" placeholder="积分数，负数为扣回" aria-label="积分数" autoFocus onKeyDown={(e) => e.key === 'Enter' && submit()} />
      <div className="modal-actions">
        <button className="btn btn-primary" disabled={busy} onClick={submit}>
          确定
        </button>
      </div>
    </>
  );
}

function MembersSection() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [adding, setAdding] = useState(false);
  // 填了名字，「添加成员」才是主按钮。
  const [named, setNamed] = useState(false);
  const name = useRef<HTMLInputElement>(null);
  const me = state.app.user!;
  const load = () =>
    api<{ items: Member[] }>('GET', '/api/users')
      .then((data) => setMembers(data.items))
      .catch((err) => toast(message(err), 'error', 6000));
  useEffect(() => {
    load();
  }, []);

  async function add() {
    const value = name.current!.value.trim();
    if (!value) return;
    setAdding(true);
    try {
      const { user, password } = await api('POST', '/api/users', { name: value });
      name.current!.value = '';
      setNamed(false);
      showPassword(user.name, password);
      await load();
    } catch (err) {
      toast(message(err), 'error', 6000);
    } finally {
      setAdding(false);
    }
  }

  const change = async (member: Member, body: Record<string, unknown>, done?: string) => {
    try {
      const { password } = await api('PUT', `/api/users/${member.id}`, body);
      if (password) showPassword(member.name, password);
      else if (done) toast(done, 'success');
      await load();
    } catch (err) {
      toast(message(err), 'error', 6000);
    }
  };

  async function remove(member: Member) {
    const ok = await confirmDialog({ title: `删除成员「${member.name}」？`, message: '账号将无法登录。该成员的生成记录和文件保留在服务器上。', okText: '删除', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', `/api/users/${member.id}`);
      await load();
    } catch (err) {
      toast(message(err), 'error', 6000);
    }
  }

  // 停用会让这个人立刻退出登录，先问一句。能再启用回来，所以不是危险操作的红色。
  async function disable(member: Member) {
    const ok = await confirmDialog({ title: `停用成员「${member.name}」？`, message: '停用后立即退出登录，无法再登录和生成；可随时重新启用。', okText: '停用' });
    if (ok) change(member, { disabled: true }, '已停用');
  }

  function grant(member: Member) {
    const modal = openModal({
      title: `为「${member.name}」发放积分`,
      size: 'sm',
      content: (
        <GrantDialog
          member={member}
          done={() => {
            modal.close();
            load();
          }}
        />
      ),
    });
  }

  function more(button: HTMLElement, member: Member) {
    const acts: Record<string, () => void> = {
      reset: () => change(member, { resetPassword: true }),
      toggle: () => (member.disabled ? change(member, { disabled: false }, '已启用') : disable(member)),
      remove: () => remove(member),
    };
    openMenu(button, {
      label: '成员操作',
      align: 'end',
      items: [
        { value: 'reset', label: '重置密码' },
        { value: 'toggle', label: member.disabled ? '启用' : '停用' },
        ...(member.id === me.id ? [] : [{ value: 'remove', label: '删除', danger: true }]),
      ],
      onSelect: (value) => acts[value](),
    });
  }

  const totalCredits = (members || []).reduce((sum, m) => sum + (m.credits || 0), 0);
  const totalMonthUsed = (members || []).reduce((sum, m) => sum + (m.monthUsed || 0), 0);

  return (
    <section className="settings-group">
      <h3>成员{members ? ` · 团队剩余 ${fmtCredits(totalCredits)} · 本月已用 ${fmtCredits(totalMonthUsed)}` : ''}</h3>
      <div className="settings-card">
        {(members || []).map((member) => {
          // 管理员生成不扣积分：不写余额和本月用量，也不给发积分。
          const admin = member.role === 'admin';
          return (
            <FormRow key={member.id} className={member.disabled ? 'is-off' : undefined} label={member.name} desc={[admin ? '管理员' : '成员', member.disabled ? '已停用' : member.lastSeenAt ? `最近使用 ${fmtTime(member.lastSeenAt)}` : '尚未登录', !admin && `本月 ${fmtCredits(member.monthUsed)}`].filter(Boolean).join(' · ')}>
              {admin ? (
                <span className="muted">不扣积分</span>
              ) : (
                <>
                  <span className="muted amount">{fmtCredits(member.credits)}</span>
                  <button className="btn btn-sm" type="button" onClick={() => grant(member)}>
                    发放积分
                  </button>
                </>
              )}
              <button className="btn btn-sm" type="button" aria-haspopup="menu" aria-expanded="false" onClick={(e) => more(e.currentTarget, member)}>
                管理
              </button>
            </FormRow>
          );
        })}
        <div className="form-row">
          <div className="form-control key-edit">
            <input ref={name} className="input" type="text" placeholder="新成员的名称" maxLength={30} aria-label="新成员的名称" onInput={(e) => setNamed(Boolean(e.currentTarget.value.trim()))} onKeyDown={(e) => e.key === 'Enter' && add()} />
            <button className={`btn${named ? ' btn-primary' : ''}`} type="button" disabled={adding} onClick={add}>
              添加成员
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------- Key 和余额 ----------

// Key 的那一行。平时只显示尾号和「更换」；要填的时候这一行原地换成输入框，不把下面的内容往下推。
// 还没有 Key 时一直是输入框。onSave 存成了返回 true，这一行才收回去。
function KeyRow({ name, label = 'API Key', desc, placeholder, copyHint = '', hasKey, keyHint, keySource, onSave, onRemove }: { name: string; label?: string; desc?: ReactNode; placeholder: string; copyHint?: string; hasKey: boolean; keyHint: string; keySource: string; onSave: (value: string) => Promise<boolean>; onRemove: () => void }) {
  const [editing, setEditing] = useState(false);
  // 输入框默认遮住内容；显示出来是为了核对粘贴的到底是不是 Key。
  const [masked, setMasked] = useState(true);
  const [saving, setSaving] = useState(false);
  // 填了内容，「保存」才是反色的主按钮：一屏好几行没填的 Key，不该同时亮着好几个主按钮。
  const [filled, setFilled] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  async function submit() {
    const value = input.current!.value.trim();
    if (!value) return toast(`请输入 ${name} API Key`, 'error');
    if (/[^\x21-\x7e]/.test(value)) {
      setMasked(false);
      return toast(`API Key 格式不正确：包含中文或空格。${copyHint}`, 'error', 8000);
    }
    setSaving(true);
    try {
      if (!(await onSave(value))) return;
      if (input.current) input.current.value = '';
      setFilled(false);
      setMasked(true);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  if (hasKey && !editing) {
    return (
      <FormRow label={label} desc={desc}>
        <span className="mono">{keyHint}</span>
        {keySource === 'env' ? (
          <span className="muted">来自环境变量</span>
        ) : (
          <>
            <button className="btn btn-sm" type="button" onClick={() => setEditing(true)}>
              更换
            </button>
            {keySource === 'file' && (
              <button className="btn btn-sm" type="button" onClick={onRemove}>
                清除
              </button>
            )}
          </>
        )}
      </FormRow>
    );
  }
  return (
    <div className="form-row">
      {/* 用途在还没填的时候最需要看到，所以输入状态下也写着。 */}
      <div className="form-label">
        {label}
        {desc && <span className="form-desc">{desc}</span>}
      </div>
      <div className="form-control key-edit">
        <input ref={input} className={`input mono${masked ? ' masked' : ''}`} type="text" placeholder={placeholder} autoComplete="off" data-1p-ignore="" data-lpignore="true" aria-label={`${name}API Key`} onInput={(e) => setFilled(Boolean(e.currentTarget.value.trim()))} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        <button className="btn" type="button" onClick={() => setMasked(!masked)}>
          {masked ? '显示' : '隐藏'}
        </button>
        <button className={`btn${filled ? ' btn-primary' : ''}`} type="button" disabled={saving} onClick={submit}>
          保存
        </button>
        {hasKey && (
          <button className="btn" type="button" onClick={() => setEditing(false)}>
            取消
          </button>
        )}
      </div>
    </div>
  );
}

// MiniMax 的 Key：视频模型 MiniMax H3 用它，要国内站的。订阅 Key 扣的是积分，按量付费的 Key 扣的是账户余额；视频资源包不支持 H3。
function MinimaxKey() {
  useStore('app');
  const { hasKey, keyHint, keySource } = state.app.minimax;
  const { label } = MINIMAX;
  async function save(value: string) {
    try {
      state.app = await api('PUT', '/api/key', { apiKey: value, service: 'minimax' });
      await loadApp();
      toast(`${label} 的 API Key 已保存`, 'success');
      return true;
    } catch (err) {
      toast(message(err), 'error', 6000);
      return false;
    }
  }

  async function remove() {
    const ok = await confirmDialog({ title: `清除已保存的 ${label} API Key？`, message: '清除后将无法使用 MiniMax H3。', okText: '清除', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', '/api/key?service=minimax');
      await loadApp();
      toast('已清除', 'success');
    } catch (err) {
      toast(message(err), 'error');
    }
  }

  return (
    <KeyRow
      name={label}
      label={`${label} API Key`}
      desc="MiniMax H3"
      placeholder="粘贴 API Key"
      hasKey={hasKey}
      keyHint={keyHint}
      keySource={keySource}
      onSave={save}
      onRemove={remove}
    />
  );
}

// AiHubMix 的 Key：图片模型 GPT Image 2.5、Nano Banana 2.1 用它。账号要先在它的控制台开启「异步任务」。
function AihubmixKey() {
  useStore('app');
  const { hasKey, keyHint, keySource } = state.app.aihubmix;
  const { label } = AIHUBMIX;
  async function save(value: string) {
    try {
      state.app = await api('PUT', '/api/key', { apiKey: value, service: 'aihubmix' });
      await loadApp();
      toast(`${label} 的 API Key 已保存`, 'success');
      return true;
    } catch (err) {
      toast(message(err), 'error', 6000);
      return false;
    }
  }

  async function remove() {
    const ok = await confirmDialog({ title: `清除已保存的 ${label} API Key？`, message: '清除后将无法使用 GPT Image 2.5 和 Nano Banana 2.1。', okText: '清除', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', '/api/key?service=aihubmix');
      await loadApp();
      toast('已清除', 'success');
    } catch (err) {
      toast(message(err), 'error');
    }
  }

  return (
    <KeyRow
      name={label}
      label={`${label} API Key`}
      desc="GPT Image 2.5、Nano Banana 2.1"
      placeholder="粘贴 API Key"
      hasKey={hasKey}
      keyHint={keyHint}
      keySource={keySource}
      onSave={save}
      onRemove={remove}
    />
  );
}

// 豆包语音的 Key：语音用它。它和方舟不是一个产品，Key 要另外创建、另外填。排在「模型平台」那组里，方舟的 Key 下面。
function SpeechKey() {
  useStore('app');
  const { hasKey, keyHint, keySource } = state.app.speech;
  const { label } = DOUBAO_SPEECH;
  async function save(value: string) {
    try {
      state.app = await api('PUT', '/api/key', { apiKey: value, service: 'speech' });
      await loadApp();
      toast(`${label}的 API Key 已保存`, 'success');
      return true;
    } catch (err) {
      toast(message(err), 'error', 6000);
      return false;
    }
  }

  async function remove() {
    const ok = await confirmDialog({ title: `清除已保存的${label} API Key？`, message: '清除后将无法生成语音、音效与配乐。', okText: '清除', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', '/api/key?service=speech');
      await loadApp();
      toast('已清除', 'success');
    } catch (err) {
      toast(message(err), 'error');
    }
  }

  return (
    <KeyRow
      name={label}
      label={`${label} API Key`}
      desc="语音、音效、配乐"
      placeholder="粘贴 API Key"
      hasKey={hasKey}
      keyHint={keyHint}
      keySource={keySource}
      onSave={save}
      onRemove={remove}
    />
  );
}

// AutoDL.art 的令牌：ComfyUI 云工作流用它。令牌原样放进请求头（不加 Bearer），在 autodl.art 的个人中心里取。
function AutodlKey() {
  useStore('app');
  const { hasKey, keyHint, keySource } = state.app.autodl;
  async function save(value: string) {
    try {
      state.app = await api('PUT', '/api/key', { apiKey: value, service: 'autodl' });
      await loadApp();
      // 换了令牌，工作流目录要重新读一遍。
      loadFlows(true);
      toast('AutoDL.art 令牌已保存', 'success');
      return true;
    } catch (err) {
      toast(message(err), 'error', 6000);
      return false;
    }
  }

  async function remove() {
    const ok = await confirmDialog({ title: '清除已保存的 AutoDL.art 令牌？', message: '清除后将无法运行工作流。', okText: '清除', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', '/api/key?service=autodl');
      await loadApp();
      loadFlows(true);
      toast('已清除', 'success');
    } catch (err) {
      toast(message(err), 'error');
    }
  }

  return (
    <KeyRow
      name="AutoDL.art"
      label="AutoDL.art 令牌"
      desc="ComfyUI 云工作流（MiniMax H3、声纹克隆等）"
      placeholder="粘贴 AutoDL.art 令牌"
      copyHint="令牌原样使用，不需要加 Bearer 前缀。"
      hasKey={hasKey}
      keyHint={keyHint}
      keySource={keySource}
      onSave={save}
      onRemove={remove}
    />
  );
}

// 查余额用的火山引擎 Access Key。它是账号级的一对密钥（ID 和 Secret），和方舟、豆包语音的 API Key 都不是一回事。
// 保存时服务端会先查一次余额，查不到就不存。
function BillingKey() {
  useStore('app', 'balance');
  const { hasKey, keyHint, keySource } = state.app.billing;
  const { label } = VOLC_BILLING;
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [filled, setFilled] = useState(false);
  const id = useRef<HTMLInputElement>(null);
  const secret = useRef<HTMLInputElement>(null);

  async function save() {
    const accessKeyId = id.current!.value.trim();
    const secretAccessKey = secret.current!.value.trim();
    if (!accessKeyId || !secretAccessKey) return toast('请填写 Access Key ID 和 Secret Access Key', 'error');
    setSaving(true);
    try {
      state.app = await api('PUT', '/api/key', { service: 'billing', accessKeyId, secretAccessKey });
      await loadApp();
      await loadBalance();
      setEditing(false);
      setFilled(false);
      toast('Access Key 已保存', 'success');
    } catch (err) {
      toast(message(err), 'error', 8000);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    const ok = await confirmDialog({ title: '清除已保存的 Access Key？', message: '清除后不再显示账户余额。', okText: '清除', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', '/api/key?service=billing');
      await loadApp();
      await loadBalance();
      toast('已清除', 'success');
    } catch (err) {
      toast(message(err), 'error');
    }
  }

  return (
    <section className="settings-group">
      <h3>{label}</h3>
      <div className="settings-card">
        {hasKey && !editing ? (
          <>
            <FormRow
              label="Access Key"
              desc="查询火山引擎余额"
            >
              <span className="mono">{keyHint}</span>
              {keySource === 'env' ? (
                <span className="muted">来自环境变量</span>
              ) : (
                <>
                  <button className="btn btn-sm" type="button" onClick={() => setEditing(true)}>
                    更换
                  </button>
                  <button className="btn btn-sm" type="button" onClick={remove}>
                    清除
                  </button>
                </>
              )}
            </FormRow>
            <FormRow label="可用余额">
              <span className="muted amount">{state.balance != null ? `¥${amount(state.balance)}` : '获取失败'}</span>
            </FormRow>
          </>
        ) : (
          <>
            {/* ID 和 Secret 是一对，一起保存：保存键放在第二行的 Secret 后面。 */}
            <div className="form-row">
              <div className="form-label">
                Access Key ID
                <span className="form-desc">查询火山引擎余额</span>
              </div>
              <div className="form-control key-edit">
                <input ref={id} className="input mono" type="text" placeholder="AKLT…" autoComplete="off" data-1p-ignore="" data-lpignore="true" aria-label="Access Key ID" />
              </div>
            </div>
            <div className="form-row">
              <div className="form-label">Secret Access Key</div>
              <div className="form-control key-edit">
                <input ref={secret} className="input mono masked" type="text" placeholder="粘贴 Secret Access Key" autoComplete="off" data-1p-ignore="" data-lpignore="true" aria-label="Secret Access Key" onInput={(e) => setFilled(Boolean(e.currentTarget.value.trim()))} onKeyDown={(e) => e.key === 'Enter' && save()} />
                <button className={`btn${filled ? ' btn-primary' : ''}`} type="button" disabled={saving} onClick={save}>
                  保存
                </button>
                {hasKey && (
                  <button className="btn" type="button" onClick={() => setEditing(false)}>
                    取消
                  </button>
                )}
              </div>
            </div>
          </>
        )}
        <OtherBalances />
      </div>
    </section>
  );
}

// 另外两个账户的余额。MiniMax 的余额没有查询接口，手动填控制台上看到的数，之后按估算的费用扣；充值后要重新填。
// MiniMax 的余额有两种：订阅 Key 用的是积分，按量付费的 Key 用的是账户余额（元），填的时候选单位。
// AiHubMix 的要另填一个 Manage Key（不是生图用的 API Key），保存时服务端会先查一次，查不到就不存。
function OtherBalances() {
  useStore('app', 'balance');
  const { hasKey, keyHint, keySource } = state.app.aihubmixManage;
  const minimax = state.minimaxBalance;
  const [saving, setSaving] = useState(false);
  const [filled, setFilled] = useState(false);
  const [unit, setUnit] = useState<'credits' | 'cny'>(minimax?.unit || 'credits');
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function saveMinimax() {
    const value = input.current!.value.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(value)) return toast(unit === 'credits' ? '请输入积分数，例如 4489' : '请输入余额，例如 30 或 26.50', 'error');
    setSaving(true);
    try {
      await api('PUT', '/api/balance/minimax', { amount: Number(value), unit });
      await loadBalance();
      setEditing(false);
      setFilled(false);
      toast('MiniMax 余额已更新', 'success');
    } catch (err) {
      toast(message(err), 'error');
    } finally {
      setSaving(false);
    }
  }

  async function clearMinimax() {
    try {
      await api('DELETE', '/api/balance/minimax');
      await loadBalance();
      toast('已清除', 'success');
    } catch (err) {
      toast(message(err), 'error');
    }
  }

  async function saveManage(value: string) {
    try {
      state.app = await api('PUT', '/api/key', { apiKey: value, service: 'aihubmix-manage' });
      await loadApp();
      await loadBalance();
      toast('Manage Key 已保存', 'success');
      return true;
    } catch (err) {
      toast(message(err), 'error', 8000);
      return false;
    }
  }

  async function removeManage() {
    const ok = await confirmDialog({ title: '清除已保存的 Manage Key？', message: '清除后不再显示 AiHubMix 余额。', okText: '清除', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', '/api/key?service=aihubmix-manage');
      await loadApp();
      await loadBalance();
      toast('已清除', 'success');
    } catch (err) {
      toast(message(err), 'error');
    }
  }

  return (
    <>
        {minimax && !editing ? (
          <FormRow label="MiniMax 余额" desc="手动填写，按估算扣减">
            <span className="muted amount">{minimax.unit === 'credits' ? fmtCredits(minimax.remaining) : `¥${amount(minimax.remaining)}`}</span>
            <button className="btn btn-sm" type="button" onClick={() => setEditing(true)}>
              更新
            </button>
            <button className="btn btn-sm" type="button" onClick={clearMinimax}>
              清除
            </button>
          </FormRow>
        ) : (
          <div className="form-row">
            <div className="form-label">
              MiniMax 余额
              <span className="form-desc">手动填写，按估算扣减</span>
            </div>
            <div className="form-control key-edit">
              <Segmented
                options={[
                  { value: 'credits', label: '积分' },
                  { value: 'cny', label: '元' },
                ]}
                value={unit}
                onChange={setUnit}
              />
              <input ref={input} className="input" type="text" inputMode="decimal" placeholder={unit === 'credits' ? '当前积分' : '当前余额'} aria-label="MiniMax 余额" onInput={(e) => setFilled(Boolean(e.currentTarget.value.trim()))} onKeyDown={(e) => e.key === 'Enter' && saveMinimax()} />
              <button className={`btn${filled ? ' btn-primary' : ''}`} type="button" disabled={saving} onClick={saveMinimax}>
                保存
              </button>
              {minimax && (
                <button className="btn" type="button" onClick={() => setEditing(false)}>
                  取消
                </button>
              )}
            </div>
          </div>
        )}
        <KeyRow
          name="AiHubMix Manage "
          label="AiHubMix Manage Key"
          desc="查询 AiHubMix 余额"
          placeholder="粘贴 Manage Key"
          hasKey={hasKey}
          keyHint={keyHint}
          keySource={keySource}
          onSave={saveManage}
          onRemove={removeManage}
        />
        {hasKey && (
          <FormRow label="AiHubMix 余额">
            <span className="muted amount">{state.aihubmixBalance?.remaining != null ? `$${amount(state.aihubmixBalance.remaining)}` : '获取失败'}</span>
          </FormRow>
        )}
    </>
  );
}
