#!/usr/bin/env node

// Innate Studio 的服务：托管页面、保管 API Key、转发请求给火山引擎、轮询任务并保存历史。
// 这个文件只是入口：收请求、找到对应的接口、把文件发出去。各部分在 server/ 里：
//   config.js 固定设置    store.js 磁盘上的数据    keys.js API Key
//   ark.js 调用火山方舟    speech.js 豆包语音    billing.js 费用中心
//   media.js 本机文件    tasks.js 生成记录的轮询和落盘    thumbs.js 缩略图
//   auth.js 账号和登录    spaces.js 每个请求用哪一份数据    routes/ 各组接口
// 两种用法：本机模式（默认）不用登录，只接受本机页面的请求；建了账号（pnpm user）就是多人模式，要登录，各人的数据分开。
// 服务本身不依赖第三方包。页面是 web/ 里的 React 源码，用 pnpm build 构建到 web/dist 之后由这里托管。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ARK, DATA_DIR, HOST, PORT, PUBLIC_DIR } from './server/config.js';
import { HttpError, notFound, routes, sendJson, serveFile } from './server/http.js';
import { apiKey } from './server/keys.js';
import { MEDIA_PATH } from './server/media.js';
import { startPolling } from './server/tasks.js';
import { allUsers, isHosted, userOf } from './server/auth.js';
import { spaceOf } from './server/spaces.js';
import './server/routes/account.js';
import './server/routes/generate.js';
import './server/routes/text.js';
import './server/routes/library.js';
import './server/routes/users.js';

// 启动时把每份数据都打开：没跑完的任务要接着查。
if (isHosted()) allUsers().forEach(spaceOf);
else spaceOf(null);

// 挡掉别的网站发来的跨站调用。本机模式只接受本机页面发来的请求；
// 多人模式下页面是从哪个域名打开的事先不知道，就看请求是不是页面自己那个域名发的（经过反向代理时看代理转来的原域名）。
function isTrustedRequest(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = String(req.headers.origin || '').replace(/^https?:\/\//, '');
  if (isHosted()) return !origin || origin === (req.headers['x-forwarded-host'] || req.headers.host);
  const allowed = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
  return allowed.has(req.headers.host || '') && (!origin || allowed.has(origin));
}

const needLogin = (res) => sendJson(res, 401, { error: { code: 'login_required', message: '请先登录' } });

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);
  const isApi = pathname.startsWith('/api/');
  const isMedia = pathname.startsWith('/media/');

  if ((isApi || isMedia) && !isTrustedRequest(req)) {
    return sendJson(res, 403, { error: { code: 'forbidden', message: '只接受本机页面发来的请求' } });
  }
  const user = isHosted() && (isApi || isMedia) ? userOf(req) : null;

  if (isApi) {
    for (const { method, pattern, handler, access } of routes) {
      if (method !== req.method) continue;
      const match = pattern.exec(pathname);
      if (!match) continue;
      if (isHosted() && access !== 'open') {
        if (!user) return needLogin(res);
        if (access === 'admin' && user.role !== 'admin') return sendJson(res, 403, { error: { code: 'forbidden', message: '仅管理员可操作' } });
      }
      const result = await handler({ req, res, params: match.slice(1), query: url.searchParams, user, space: user || !isHosted() ? spaceOf(user) : null });
      if (result === null) {
        res.writeHead(204);
        return res.end();
      }
      return sendJson(res, 200, result);
    }
    return sendJson(res, 404, { error: { code: 'not_found', message: '接口不存在' } });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: { code: 'method_not_allowed', message: '不支持的请求方法' } });
  }

  if (isMedia) {
    const match = MEDIA_PATH.exec(pathname);
    if (!match) return notFound(res);
    if (isHosted() && !user) return needLogin(res);
    const space = spaceOf(user);
    const download = url.searchParams.has('download') ? `seedance-${match[2]}` : undefined;
    // 文件名里带着随机的 id，同一个地址的内容不会变，浏览器可以一直存着。
    return serveFile(req, res, path.join(space.dir(match[1]), match[2]), { download, cache: 'private, max-age=31536000, immutable' });
  }

  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, relative);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return notFound(res);
  return serveFile(req, res, file);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (res.headersSent) return res.end();
    const status = err instanceof HttpError ? err.status : 500;
    if (!(err instanceof HttpError)) console.error(err);
    // 多人模式下，平台返回的原始内容（upstream、平台的原话 detail）、缺哪个平台的 Key，只给管理员看。
    const hidden = isHosted() && userOf(req)?.role !== 'admin';
    const message = hidden && err.code === 'no_api_key' ? '该功能暂未开通，请联系管理员' : err instanceof HttpError ? err.message : `本地服务出错：${err.message}`;
    sendJson(res, status, { error: { code: err.code || 'internal_error', message, detail: hidden ? undefined : err.detail, upstream: hidden ? undefined : err.upstream } });
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。可以换一个端口启动：PORT=5180 node server.js`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Innate Studio 已启动：http://${HOST}:${PORT}`);
  console.log(`数据目录：${DATA_DIR}`);
  if (isHosted()) console.log(`多人模式：${allUsers().length} 个账号，需要登录。`);
  if (!fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) console.log('还没有构建页面，打开会是空的。先运行 pnpm build（pnpm start 会自动构建）。');
  if (!apiKey()) console.log(`还没有设置 ${ARK.label} 的 API Key，打开页面后在「管理」里填写。`);
  startPolling();
});
