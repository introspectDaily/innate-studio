// TOS 素材库接口：配置、列表、上传、重命名、删除。
// 列表对所有登录成员开放，方便在创作时选择团队素材；配置和写操作只有管理员可用（本机模式没有账号限制）。

import { HttpError, readBody, readJsonBody, route } from '../http.js';
import { MAX_UPLOAD_BYTES } from '../config.js';
import { isHosted } from '../auth.js';
import { clearTosConfig, deleteTosObject, listTosObjects, renameTosObject, saveTosConfig, tosConfigView, uploadTosObject } from '../tos.js';

route('GET', /^\/api\/tos\/config$/, async ({ user }) => tosConfigView({ includeCredentials: !isHosted() || user?.role === 'admin' }), 'user');

route('PUT', /^\/api\/tos\/config$/, async ({ req }) => {
  const body = await readJsonBody(req);
  return saveTosConfig(body);
}, 'admin');

route('DELETE', /^\/api\/tos\/config$/, async () => {
  clearTosConfig();
  return tosConfigView();
}, 'admin');

route('GET', /^\/api\/tos\/objects$/, async ({ query }) => listTosObjects({
  prefix: query.get('prefix') || '',
  cursor: query.get('cursor') || '',
  limit: query.get('limit') || 100,
}), 'user');

route('POST', /^\/api\/tos\/objects$/, async ({ req, query }) => {
  const contentType = req.headers['content-type'] || '';
  if (!/^(image|video|audio)\//i.test(contentType)) throw new HttpError(415, 'unsupported_media_type', '请选择图片、视频或音频文件');
  const body = await readBody(req, MAX_UPLOAD_BYTES);
  return uploadTosObject(body, contentType, query.get('filename') || '');
}, 'admin');

route('PUT', /^\/api\/tos\/objects$/, async ({ req }) => {
  const { key, name } = await readJsonBody(req);
  return renameTosObject(key, name);
}, 'admin');

route('DELETE', /^\/api\/tos\/objects$/, async ({ query }) => {
  const key = query.get('key');
  if (!key) throw new HttpError(400, 'invalid_object_name', '请选择要删除的对象');
  await deleteTosObject(key);
  return null;
}, 'admin');
