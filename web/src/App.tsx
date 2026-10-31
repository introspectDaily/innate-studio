// 整个页面：侧边栏（导航和设置）和五个页面。多人模式下没登录时只有登录页。页面第一次打开时才画，之后切走只是藏起来。

import { useEffect, useRef } from 'react';
import { state, useStore, goTo, needsLogin, canManage, hasAnyKey } from './store.ts';
import { Login } from './account.tsx';
import { Icon, type IconName } from './ui/Icon.tsx';
import { LayerHosts } from './ui/layers.tsx';
import { tip } from './ui/controls.tsx';
import { Composer } from './composer/Composer.tsx';
import { focusComposer } from './composer/state.ts';
import { Recent, Records } from './history.tsx';
import { Projects } from './canvas/Projects.tsx';
import { Materials } from './tos.tsx';
import { Characters } from './characters.tsx';
import { Skills } from './skills.tsx';
import { openSettings, openAdmin } from './settings.tsx';
import { SpendButton } from './spend.tsx';
import { Logo } from './brand/Logo.tsx';
import type { ViewId } from './types.ts';

// 五项是同一层的页签。「创作」是首页，在首页再点一次会回到顶部并把光标放回输入框。
// 侧栏的图标线宽是 2，比别处的 1.5 粗一档。
// Sparkle 在库里画得比别的图标小一圈（只占画布中间六成），所以放大到 22 显示，线条相应调细，看上去和其他几项一样大、一样粗。
const VIEWS: { id: ViewId; label: string; icon: IconName; size?: number; stroke?: number }[] = [
  { id: 'create', label: '创作', icon: 'sparkle', size: 22, stroke: 1.45 },
  { id: 'canvas', label: '画布', icon: 'workflow' },
  { id: 'materials', label: '素材库', icon: 'folder' },
  { id: 'records', label: '创作记录', icon: 'history' },
  { id: 'characters', label: '角色', icon: 'userStory' },
  { id: 'skills', label: '技能', icon: 'wandSparkles' },
];
const NAV_STROKE = 2;
const NO_KEY = '未配置 API Key';

export function App() {
  useStore('app');
  return needsLogin() ? <Login /> : <Workbench />;
}

function Workbench() {
  const visit = useStore('view');
  useStore('boot', 'app', 'immersive', 'flows');
  const view = state.view;
  const main = useRef<HTMLElement>(null);
  const opened = useRef(new Set<ViewId>(['create'])).current;
  opened.add(view);

  // 每次切换页面（包括再点一次当前页）之后要做的事。
  useEffect(() => {
    // 离开一个页面时停掉它里面正在放的视频和音频，免得声音留在后台。
    for (const media of main.current!.querySelectorAll<HTMLMediaElement>('.view[hidden] :is(video, audio)')) media.pause();
    if (view === 'create') {
      main.current!.querySelector('.view-create')!.scrollTo({ top: 0 });
      focusComposer();
    }
  }, [visit]);

  return (
    <>
      {/* 进了一张画布之后侧栏收起，靠画布左上角的返回键出来。 */}
      <aside className="sidebar" hidden={state.immersive && view === 'canvas'}>
        <div className="brand">
          <Logo />
        </div>
        <nav className="nav">
          {VIEWS.map((v) => {
            const current = view === v.id;
            return (
              <button key={v.id} className={`nav-item ${current ? 'active' : ''}`} type="button" aria-current={current ? 'page' : undefined} onClick={() => goTo(v.id)}>
                <Icon name={v.icon} size={v.size} stroke={v.stroke ?? NAV_STROKE} />
                <span>{v.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          {/* 管理入口：Key、余额、成员和积分。多人模式下只有管理员有。缺少 API Key 时带一个提醒点。 */}
          {canManage() && (
            <button className="nav-item" type="button" aria-label="管理" onClick={openAdmin}>
              <Icon name="sliders" stroke={NAV_STROKE} />
              <span>管理</span>
              {!hasAnyKey() && <span className="dot dot-warn nav-dot" {...tip(NO_KEY)} aria-label={NO_KEY} />}
            </button>
          )}
          <button className="nav-item" type="button" aria-label="设置" onClick={openSettings}>
            <Icon name="gear" stroke={NAV_STROKE} />
            <span>设置</span>
          </button>
        </div>
      </aside>
      <main ref={main} className="main">
        {/* 右上角的消费入口。进了画布就收起，那里的右上角是画布自己的工具。 */}
        {state.booted && !(state.immersive && view === 'canvas') && <SpendButton />}
        <div className="view view-create" hidden={view !== 'create'}>
          {state.booted && (
            <>
              <Composer />
              <Recent />
            </>
          )}
        </div>
        <div className="view view-canvas" hidden={view !== 'canvas'}>
          {opened.has('canvas') && state.booted && <Projects />}
        </div>
        <div className="view" hidden={view !== 'materials'}>
          {opened.has('materials') && <Materials />}
        </div>
        <div className="view" hidden={view !== 'records'}>
          {opened.has('records') && <Records />}
        </div>
        <div className="view" hidden={view !== 'characters'}>
          {opened.has('characters') && <Characters />}
        </div>
        <div className="view" hidden={view !== 'skills'}>
          {opened.has('skills') && <Skills />}
        </div>
      </main>
      <LayerHosts />
    </>
  );
}
