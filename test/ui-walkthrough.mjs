#!/usr/bin/env node
// 用 Ego 浏览器跑整体走查（test/ui-walkthrough.aside.js）。走查脚本本身不改，这里补上它用到的几个浏览器函数，交给 ego-browser 执行。
//
// 前提：pnpm dev:mock 已在运行（http://127.0.0.1:5179）。改了界面要重新运行它，它启动时才构建页面。
// 用法：node test/ui-walkthrough.mjs [dark|light] [--space 任务空间编号]，不写主题就是深色、浅色各一遍。
// 新建的任务空间开在后台，要你在 Ego 里切过去才渲染；--space 用一个已经在前台的空间，跑完不关它。
// 截图存在 test/.tmp/walkthrough/。Ego 要停在这个走查的任务空间上：标签页不在前台时不渲染，截图和点击都会超时。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shotsDir = path.join(root, 'test', '.tmp', 'walkthrough');
fs.mkdirSync(shotsDir, { recursive: true });
const body = fs.readFileSync(path.join(root, 'test', 'ui-walkthrough.aside.js'), 'utf8');

// 走查脚本是照 Aside 的接口写的：openTab 给一个 Playwright 样子的页面，再加 sleep、pwd。
// Ego 的页面接口不一样，这里包一层：evaluate、reload、keyboard 直接转过去；locator 只用到 fill、hover、click 和 first()；
// 截图的相对路径落到 test/.tmp/walkthrough；没有事件接口（pg.on），走查脚本自己会兜住。
const prelude = (theme, space) => `
const __shots = ${JSON.stringify(shotsDir)};
const __task = await taskSpace(${space ? Number(space) : JSON.stringify(`Innate Studio 整体走查（${theme}）`)});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pwd = () => __shots;
const __locator = (page, selector) => {
  const at = (s) => ({
    fill: (value) => page.fill(s, value),
    hover: () => page.hover(s),
    click: () => page.click(s),
    first: () => at(\`\${selector} >> nth=0\`),
  });
  return at(selector);
};
async function openTab(url) {
  const page = __task.page('p1');
  await page.goto(url);
  return {
    // Ego 的 evaluate 不收 undefined：没给参数就不传。
    evaluate: (fn, arg) => (arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg)),
    reload: () => page.reload(),
    keyboard: page.keyboard,
    locator: (selector) => __locator(page, selector),
    screenshot: ({ path: file }) => page.screenshot({ path: ${'`${__shots}/${file.replace(/^\\.\\//, "")}`'} }),
    on: () => {
      throw new Error('Ego 没有页面事件接口');
    },
  };
}
`;

const args = process.argv.slice(2);
const at = args.indexOf('--space');
const space = at >= 0 ? args.splice(at, 2)[1] : '';
const themes = args[0] ? [args[0]] : ['dark', 'light'];
let failed = false;
for (const theme of themes) {
  // 自己建的空间跑完关掉；借来的空间留着。
  const close = space ? '' : 'await __task.finish({ keep: [] });';
  const code = `${prelude(theme, space)}\ntry {\n${body.replace(/__THEME__/g, theme)}\n} finally {\n  ${close}\n}\n`;
  const run = spawnSync('ego-browser', ['nodejs'], { input: code, stdio: ['pipe', 'inherit', 'inherit'] });
  if (run.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
