// 测试用的最小 TOS 服务：实现 headBucket、PutObject、ListObjectsV2、renameObject、DeleteObject 和读取对象。
// SDK 默认以 JSON 接收列表响应；这里按它的返回形状给数据，测试不访问真实火山引擎。

import http from 'node:http';

export const MOCK_TOS_ACCESS_KEY_ID = 'AKLTmocktosaccesskey0001';
export const MOCK_TOS_SECRET_ACCESS_KEY = 'mock-tos-secret-access-key';
export const MOCK_TOS_BUCKET = 'innate-tos-test';

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

function sendJson(res, status, body, headers = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': bytes.length, 'x-tos-request-id': `mock-tos-${Date.now()}`, ...headers });
  res.end(bytes);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { Code: code, Message: message, RequestId: `mock-tos-${Date.now()}`, HostId: 'mock' });
}

export function startTosMock() {
  const buckets = new Map([[MOCK_TOS_BUCKET, new Map()]]);
  const log = [];
  // 测试可以把它设成大于 0，模拟 HEAD 一时失败（超时、5xx），验证不会因此重传整份文件。
  const state = { headFailures: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const body = await readBody(req);
    const decodedPath = decodeURIComponent(url.pathname);
    const [, bucket, ...parts] = decodedPath.split('/');
    const key = parts.join('/');
    const objects = buckets.get(bucket);
    log.push({ method: req.method, pathname: url.pathname, search: url.search, headers: req.headers, body });

    if (req.method === 'HEAD' && !key) {
      if (!objects) return sendError(res, 404, 'NoSuchBucket', 'The specified bucket does not exist.');
      res.writeHead(200, { 'x-tos-request-id': 'mock-tos-head' });
      return res.end();
    }

    if (!objects) return sendError(res, 404, 'NoSuchBucket', 'The specified bucket does not exist.');

    if (req.method === 'HEAD' && key) {
      if (state.headFailures > 0) {
        state.headFailures -= 1;
        return sendError(res, 503, 'InternalError', 'mock head failure');
      }
      const item = objects.get(key);
      if (!item) return sendError(res, 404, 'NoSuchKey', 'The specified key does not exist.');
      res.writeHead(200, { 'Content-Type': item.contentType, 'Content-Length': item.body.length, ETag: `"${key.length}"`, 'x-tos-request-id': 'mock-tos-head-object' });
      return res.end();
    }

    if (req.method === 'PUT' && key) {
      if (url.searchParams.has('rename')) {
        const next = url.searchParams.get('name') || '';
        if (!objects.has(key)) return sendError(res, 404, 'NoSuchKey', 'The specified key does not exist.');
        const item = objects.get(key);
        objects.delete(key);
        objects.set(next, item);
        res.writeHead(200, { 'Content-Length': 0, 'x-tos-request-id': 'mock-tos-rename' });
        return res.end();
      }
      objects.set(key, { body, contentType: String(req.headers['content-type'] || 'application/octet-stream'), acl: req.headers['x-tos-acl'] || '', at: new Date().toISOString() });
      res.writeHead(200, { ETag: `"${key.length}"`, 'x-tos-request-id': 'mock-tos-put' });
      return res.end();
    }

    if (req.method === 'GET' && key) {
      const item = objects.get(key);
      if (!item) return sendError(res, 404, 'NoSuchKey', 'The specified key does not exist.');
      res.writeHead(200, { 'Content-Type': item.contentType, 'Content-Length': item.body.length, 'x-tos-request-id': 'mock-tos-get' });
      return res.end(item.body);
    }

    if (req.method === 'GET' && !key && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') || '';
      const maxKeys = Math.min(1000, Number(url.searchParams.get('max-keys')) || 1000);
      const token = Number(url.searchParams.get('continuation-token')) || 0;
      const matching = [...objects.entries()].filter(([itemKey]) => itemKey.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
      const page = matching.slice(token, token + maxKeys);
      const next = token + page.length < matching.length ? String(token + page.length) : '';
      return sendJson(res, 200, {
        Name: bucket,
        Prefix: prefix,
        KeyCount: page.length,
        MaxKeys: maxKeys,
        IsTruncated: Boolean(next),
        NextContinuationToken: next || undefined,
        Contents: page.map(([itemKey, item]) => ({ Key: itemKey, LastModified: item.at, ETag: `"${itemKey.length}"`, Size: item.body.length, StorageClass: 'STANDARD' })),
      });
    }

    if (req.method === 'DELETE' && key) {
      objects.delete(key);
      res.writeHead(204, { 'x-tos-request-id': 'mock-tos-delete' });
      return res.end();
    }

    sendError(res, 404, 'NotFound', `No mock TOS route for ${req.method} ${url.pathname}`);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const mock = {
        url: `http://127.0.0.1:${server.address().port}`,
        buckets,
        log,
        close: () => new Promise((done) => server.close(done)),
      };
      Object.defineProperty(mock, 'headFailures', {
        get: () => state.headFailures,
        set: (value) => {
          state.headFailures = Number(value) || 0;
        },
      });
      resolve(mock);
    });
  });
}
