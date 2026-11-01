// 入口：把页面画出来，读取 Key 的状态，启动轮询。

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App.tsx';
import { state, on, emit, loadApp, loadModels, loadFlows, startHistoryLoop, needsLogin } from './store.ts';
import { initComposer } from './composer/state.ts';
import { toast } from './ui/layers.tsx';

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 保存 Key 之后重新读取模型列表和工作流目录。
let hadKey: boolean | null = null;
let hadFlow: boolean | null = null;
on('app', () => {
  if (hadKey === false && state.app.hasKey) loadModels().catch(() => {});
  hadKey = state.app.hasKey;
  const flow = Boolean(state.app.autodl?.hasKey || state.app.runninghub?.hasKey);
  if (hadFlow === false && flow) loadFlows(true).catch(() => {});
  hadFlow = flow;
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
  // 模型列表和工作流目录都无条件读：没配某个平台时服务端会把相应的型号标成不可用，
  // 而不是什么都不给（只配了 AutoDL.art 的令牌时，画布也应该能看到工作流）。
  loadModels().catch(() => {});
  loadFlows().catch(() => {});
  // 没配 Key 也不弹「管理」：页面照常打开，缺少的 Key 由侧栏的红点和输入框里的「设置 API Key」提示，点进去才开。
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
