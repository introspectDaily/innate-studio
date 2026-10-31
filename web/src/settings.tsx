// 设置弹窗：外观、润色用的模型，和多人模式下自己的账号。Key、余额、成员在「管理」里（admin.tsx），只有管理员打得开。

import { lazy, Suspense, useState } from 'react';
import { state, useStore, polishModel, setPolishModel, canvasPlace, setCanvasPlace } from './store.ts';
import { AccountSection } from './account.tsx';
import { AgentKeysSection } from './agent-keys.tsx';
import { themeChoice, setTheme } from './theme.ts';
import { Segmented, FormRow, Dropdown } from './ui/controls.tsx';
import { openModal } from './ui/layers.tsx';

const Admin = lazy(() => import('./admin.tsx'));

function Settings() {
  useStore('app', 'models');
  const [theme, setThemeState] = useState(themeChoice());
  const [polish, setPolish] = useState(polishModel());
  const [place, setPlace] = useState(canvasPlace());
  const models = state.catalog.polish;

  return (
    <div className="settings">
      {state.app.user && <AccountSection />}

      <AgentKeysSection />

      <section className="settings-group">
        <h3>通用</h3>
        <div className="settings-card">
          <FormRow label="主题">
            <Segmented
              options={[
                { value: 'system', label: '跟随系统' },
                { value: 'light', label: '浅色' },
                { value: 'dark', label: '深色' },
              ]}
              value={theme}
              onChange={(next) => {
                setTheme(next);
                setThemeState(next);
              }}
            />
          </FormRow>
          {/* 润色提示词用哪个文本模型。账号里一个可用的都没有时，创作面板上不会出现「润色」。 */}
          <FormRow label="提示词润色">
            {models.length ? (
              <Dropdown
                label="润色模型"
                value={models.includes(polish) ? polish : polishModel()}
                options={models.map((m) => ({ value: m, label: textModelName(m) }))}
                onChange={(model) => {
                  setPolishModel(model);
                  setPolish(model);
                }}
              />
            ) : (
              <span className="muted">{state.catalog.known ? '暂无可用的文本模型' : '加载中…'}</span>
            )}
          </FormRow>
          {/* 画布上改了提示词再点生成，结果放在哪。空节点总是把结果放进它自己，这里只管已经有内容的时候。 */}
          <FormRow label="画布再次生成" desc="节点里已经有内容时，新结果放哪。单个节点可以在「更多」里另行指定。">
            <Segmented
              options={[
                { value: 'new', label: '另开节点' },
                { value: 'here', label: '就地替换' },
              ]}
              value={place}
              onChange={(next) => {
                setCanvasPlace(next);
                setPlace(next);
              }}
            />
          </FormRow>
        </div>
      </section>
    </div>
  );
}

// 文本模型的型号（doubao-seed-2-1-lite-260915）在菜单里写成 Seed 2.1 Lite，和生成模型的写法一样，去掉前缀和版本日期。
// 只在这里换：别处（费用明细）要的是型号本身，shared/models.ts 的 modelLabel 对文本模型也原样返回。认不出来的原样显示。
function textModelName(id: string) {
  const m = /^doubao-seed-(\d+)-(\d+)-([a-z]+)-\d{6}$/i.exec(id);
  return m ? `Seed ${m[1]}.${m[2]} ${m[3][0].toUpperCase()}${m[3].slice(1)}` : id;
}

export function openSettings() {
  openModal({ title: '设置', size: 'md', content: <Settings /> });
}

export function openAdmin() {
  openModal({
    title: '管理',
    size: 'md',
    content: (
      <Suspense>
        <Admin />
      </Suspense>
    ),
  });
}
