// 入口：把页面画出来，读取 Key 的状态，启动轮询。

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App.tsx';
import { state, on, emit, loadApp, loadModels, loadFlows, startHistoryLoop, needsLogin, canManage } from './store.ts';
import { initComposer } from './composer/state.ts';
import { openAdmin } from './settings.tsx';
import { toast } from './ui/layers.tsx';

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 保存 Key 之后重新读取模型列表。
let hadKey: boolean | null = null;
on('app', () => {
  if (hadKey === false && state.app.hasKey) loadModels().catch(() => {});
  hadKey = state.app.hasKey;
});

async function start() {
  try {
    await loadApp();
  } catch (err) {
    toast((err as Error).message, 'error', 8000);
  }
  // 多人模式下还没登录：只画登录页，别的都不读。
  if (needsLogin()) return emit('app');
  initComposer();
  state.booted = true;
  emit('boot');
  startHistoryLoop();
  if (state.app.hasKey) loadModels().catch(() => {});
  if (state.app.autodl?.hasKey) loadFlows().catch(() => {});
  if (!state.app.hasKey) {
    if (canManage()) openAdmin();
  }
}

// 滚动条平时不显示：哪一块在滚就给它加上 .is-scrolling，停下一会儿再去掉。页面上所有能滚的地方都走这里。
const scrollTimers = new WeakMap<Element, number>();
document.addEventListener(
  'scroll',
  (e) => {
    const el = e.target instanceof Element ? e.target : document.documentElement;
    el.classList.add('is-scrolling');
    clearTimeout(scrollTimers.get(el));
    scrollTimers.set(el, window.setTimeout(() => el.classList.remove('is-scrolling'), 800));
  },
  { capture: true, passive: true },
);

// 自动化走查要直接改状态来模拟接口的变化，所以把状态挂出来。
Object.assign(window, { __studio: { state, emit } });

start();
