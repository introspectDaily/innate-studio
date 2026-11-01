// 火山引擎对象存储（TOS）：把本机参考视频传到已有 Bucket，生成可公开访问的地址；同时给「素材库」提供对象管理。
// 只校验、使用 Bucket，绝不创建 Bucket。TOS 没有真正的目录，prefix 只是对象 key 的前缀；配置 prefix 时放一个 .keep 作为路径标记。
// 官方文档：
// - API 总览 https://www.volcengine.com/docs/6349/1404012
// - PutObject https://www.volcengine.com/docs/6349/74860
// - ListObjectsV2 https://www.volcengine.com/docs/6349/357812
// - Node SDK https://www.volcengine.com/docs/6349/113481
// - 预签名 URL https://www.volcengine.com/docs/6349/79910

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TosClient } from '@volcengine/tos-sdk';
import { VOLC_BILLING } from './config.js';
import { HttpError, MIME } from './http.js';
import { UPLOAD_TYPES, localMediaFile } from './media.js';
import { config, saveConfig } from './store.js';

export const TOS_MARKER = '.keep';
const DEFAULT_REGION = 'cn-beijing';
const DEFAULT_ENDPOINT = 'tos-cn-beijing.volces.com';
const SUPPORTED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov', '.webm', '.mp3', '.wav']);
const KIND_BY_EXT = { '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.webp': 'image', '.mp4': 'video', '.mov': 'video', '.webm': 'video', '.mp3': 'audio', '.wav': 'audio' };
const MIME_BY_EXT = MIME;

let cachedClient = null;
let cachedSignature = '';

const stored = () => (config.tos && typeof config.tos === 'object' ? config.tos : {});
const env = (name) => String(process.env[name] || '').trim();
const firstEnv = (...names) => names.map(env).find(Boolean) || '';

// 专属 TOS 的 Access Key 优先；没有时沿用「火山引擎 Access Key」，它本来就可以同时用于费用中心和 TOS。
export function tosCredentials() {
  const value = stored();
  const envId = firstEnv('INNATE_STUDIO_VOLC_TOS_ACCESS_KEY_ID', 'TOS_ACCESS_KEY_ID');
  const envSecret = firstEnv('INNATE_STUDIO_VOLC_TOS_ACCESS_KEY', 'TOS_SECRET_ACCESS_KEY');
  const id = envId || value.accessKeyId || process.env[VOLC_BILLING.envId] || config[VOLC_BILLING.configId] || '';
  const secret = envSecret || value.accessKeySecret || process.env[VOLC_BILLING.envSecret] || config[VOLC_BILLING.configSecret] || '';
  if (!id || !secret) return null;
  const source = envId || envSecret ? 'env' : value.accessKeyId && value.accessKeySecret ? 'tos-file' : process.env[VOLC_BILLING.envId] || process.env[VOLC_BILLING.envSecret] ? 'env' : 'file';
  return { id, secret, source };
}

export function normalizePrefix(value) {
  let prefix = String(value ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!prefix) return '';
  if (/[\\\x00-\x1f\x7f]/.test(prefix)) throw new HttpError(400, 'invalid_tos_prefix', 'Bucket 前缀不能包含反斜杠或控制字符');
  prefix = prefix.replace(/\/{2,}/g, '/');
  for (const part of prefix.split('/')) {
    if (!part || part === '.' || part === '..') throw new HttpError(400, 'invalid_tos_prefix', 'Bucket 前缀不能包含空路径段、. 或 ..');
  }
  if (prefix.length > 512) throw new HttpError(400, 'invalid_tos_prefix', 'Bucket 前缀过长');
  return prefix;
}

// 对象名允许目录层级，但禁止绝对路径、反斜杠、控制字符和路径穿越。素材库里的重命名也走这里。
export function normalizeObjectName(value) {
  const name = String(value ?? '').trim().replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
  if (!name) throw new HttpError(400, 'invalid_object_name', '请输入文件名');
  if (/[\\\x00-\x1f\x7f]/.test(name)) throw new HttpError(400, 'invalid_object_name', '文件名不能包含反斜杠或控制字符');
  for (const part of name.split('/')) {
    if (!part || part === '.' || part === '..') throw new HttpError(400, 'invalid_object_name', '文件名不能包含空路径段、. 或 ..');
  }
  if (name === TOS_MARKER || name.endsWith(`/${TOS_MARKER}`)) throw new HttpError(400, 'invalid_object_name', '该文件名由系统保留');
  if (name.length > 900) throw new HttpError(400, 'invalid_object_name', '文件名过长');
  return name;
}

export function fullObjectKey(prefix, name) {
  const cleanPrefix = normalizePrefix(prefix);
  const cleanName = normalizeObjectName(name);
  return cleanPrefix ? `${cleanPrefix}/${cleanName}` : cleanName;
}

export function keyInPrefix(key, prefix) {
  const cleanPrefix = normalizePrefix(prefix);
  const value = String(key || '');
  if (!value || value.includes('\\') || /[\x00-\x1f\x7f]/.test(value)) return false;
  if (value === TOS_MARKER || value.endsWith(`/${TOS_MARKER}`)) return false;
  return cleanPrefix ? value.startsWith(`${cleanPrefix}/`) : true;
}

function relativeName(key, prefix) {
  const cleanPrefix = normalizePrefix(prefix);
  return cleanPrefix ? String(key).slice(cleanPrefix.length + 1) : String(key);
}

function assertObjectKey(key, prefix) {
  if (!keyInPrefix(key, prefix)) throw new HttpError(400, 'invalid_object_name', '对象不在已配置的前缀内');
  return String(key);
}

function normalizedEndpoint(value) {
  const raw = String(value || DEFAULT_ENDPOINT).trim();
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new HttpError(400, 'invalid_tos_endpoint', 'TOS Endpoint 格式不正确');
  }
  if (url.pathname !== '/' || url.search || url.hash) throw new HttpError(400, 'invalid_tos_endpoint', 'TOS Endpoint 只填写域名，不要带路径');
  return { endpoint: url.host, secure: url.protocol !== 'http:' };
}

function normalizeRegion(value) {
  const region = String(value || DEFAULT_REGION).trim();
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/i.test(region)) throw new HttpError(400, 'invalid_tos_region', 'TOS Region 格式不正确');
  return region;
}

function normalizeBucket(value) {
  const bucket = String(value || '').trim();
  if (!bucket) throw new HttpError(400, 'invalid_tos_bucket', '请填写 Bucket 名称');
  // 火山引擎 TOS Bucket 名为 3–63 位小写字母、数字或连字符，不能以连字符开头或结尾。
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new HttpError(400, 'invalid_tos_bucket', 'Bucket 名称须为 3–63 位小写字母、数字或连字符，且不能以连字符开头或结尾');
  return bucket;
}

function normalizePublicBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'invalid_tos_public_url', '公开访问域名格式不正确');
  }
  if (url.protocol !== 'https:') throw new HttpError(400, 'invalid_tos_public_url', '公开访问域名必须使用 https');
  if (url.pathname !== '/' || url.search || url.hash) throw new HttpError(400, 'invalid_tos_public_url', '公开访问域名只填写域名，不要带路径');
  return url.origin;
}

function settings() {
  const value = stored();
  const endpointEnv = firstEnv('INNATE_STUDIO_VOLC_TOS_ENDPOINT', 'TOS_ENDPOINT');
  const endpointValue = endpointEnv || value.endpoint || DEFAULT_ENDPOINT;
  // 存盘时 Endpoint 只保存主机名；secure 另存，测试/自建 Endpoint 的 http 不会被误当成 https。
  const endpoint = normalizedEndpoint(/^https?:\/\//i.test(endpointValue) ? endpointValue : `${!endpointEnv && value.secure === false ? 'http' : 'https'}://${endpointValue}`);
  return {
    bucket: normalizeBucket(firstEnv('INNATE_STUDIO_VOLC_TOS_BUCKET', 'TOS_BUCKET') || value.bucket || ''),
    prefix: normalizePrefix(firstEnv('INNATE_STUDIO_VOLC_TOS_PATH', 'TOS_PREFIX') || value.prefix || ''),
    region: normalizeRegion(firstEnv('INNATE_STUDIO_VOLC_TOS_REGION', 'TOS_REGION') || value.region || DEFAULT_REGION),
    endpoint: endpoint.endpoint,
    secure: endpoint.secure,
    publicBaseUrl: normalizePublicBaseUrl(firstEnv('INNATE_STUDIO_VOLC_TOS_PUBLIC_BASE_URL', 'TOS_PUBLIC_BASE_URL') || value.publicBaseUrl || ''),
  };
}

function clientFor(current, credentials) {
  const signature = JSON.stringify([current.endpoint, current.region, credentials.id, credentials.secret]);
  if (cachedClient && cachedSignature === signature) return cachedClient;
  const localHost = /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(current.endpoint);
  cachedClient = new TosClient({
    accessKeyId: credentials.id,
    accessKeySecret: credentials.secret,
    region: current.region,
    endpoint: current.endpoint,
    secure: current.secure,
    // 本地 mock/测试服务用 path-style；火山引擎真实 Endpoint 用 bucket.endpoint 的虚拟主机形式。
    forcePathStyle: localHost || process.env.TOS_FORCE_PATH_STYLE === '1',
    maxRetryCount: 1,
    requestTimeout: 45000,
  });
  cachedSignature = signature;
  return cachedClient;
}

function resetClient() {
  cachedClient = null;
  cachedSignature = '';
}

export function tosConfigView({ includeCredentials = true } = {}) {
  const credentials = tosCredentials();
  let current;
  try {
    current = settings();
  } catch (err) {
    // 配置坏了也要让管理员打开页面修改，不要把整个「管理」弹窗卡死。
    const value = stored();
    current = { bucket: value.bucket || '', prefix: value.prefix || '', region: value.region || DEFAULT_REGION, endpoint: value.endpoint || DEFAULT_ENDPOINT, secure: true, publicBaseUrl: value.publicBaseUrl || '' };
  }
  return {
    configured: Boolean(current.bucket),
    bucket: current.bucket,
    prefix: current.prefix,
    region: current.region,
    endpoint: current.endpoint,
    publicBaseUrl: current.publicBaseUrl,
    bucketUrl: current.bucket ? publicBucketUrl(current) : '',
    hasCredentials: Boolean(credentials),
    credentialHint: includeCredentials && credentials ? `${credentials.id.slice(0, 6)}…${credentials.id.slice(-4)}` : '',
    credentialSource: includeCredentials ? credentials?.source || '' : '',
  };
}

function publicBucketUrl(current) {
  if (current.publicBaseUrl) return current.publicBaseUrl;
  if (!current.bucket) return '';
  return `${current.secure ? 'https' : 'http'}://${current.bucket}.${current.endpoint}`;
}

export function publicObjectUrl(key, current = settings()) {
  const encoded = String(key).split('/').map((part) => encodeURIComponent(part)).join('/');
  if (current.publicBaseUrl) return `${current.publicBaseUrl}/${encoded}`;
  const forcePath = /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(current.endpoint) || process.env.TOS_FORCE_PATH_STYLE === '1';
  const origin = `${current.secure ? 'https' : 'http'}://${current.endpoint}`;
  return forcePath ? `${origin}/${encodeURIComponent(current.bucket)}/${encoded}` : `${origin.replace('://', `://${current.bucket}.`)}/${encoded}`;
}

function mapTosError(err, action = '访问 TOS') {
  if (err instanceof HttpError) return err;
  const code = err?.code || 'tos_error';
  const status = err?.statusCode || err?.response?.status;
  const detail = err?.data?.Message || err?.message || (status ? `HTTP ${status}` : '未知错误');
  if (code === 'NoSuchBucket' || status === 404) return new HttpError(400, 'tos_bucket_not_found', 'Bucket 不存在或当前 Access Key 无权访问。请先在火山引擎控制台创建 Bucket，再回来填写名称。', detail);
  if (code === 'AccessDenied' || code === 'InvalidAccessKeyId' || code === 'SignatureDoesNotMatch' || status === 403) return new HttpError(403, 'tos_access_denied', `TOS 鉴权失败：请检查 Access Key 以及它是否有该 Bucket 的读写权限。`, detail);
  if (code === 'NoSuchKey') return new HttpError(404, 'tos_object_not_found', '对象不存在或已被删除', detail);
  if (code === 'MalformedAclError' || code === 'AccessControlListNotSupported') return new HttpError(400, 'tos_public_read_failed', 'Bucket 不允许对象公开读。参考视频需要公网可访问，请开启公开读或给 Bucket 绑定可公开访问的自定义域名。', detail);
  return new HttpError(502, 'tos_error', `${action}失败：${detail}`, detail);
}

// 只有「对象确实不存在」才算失效。超时、5xx、权限这些如实抛出，别当成不存在去重传整份文件。
function objectMissing(err) {
  const code = err?.code || '';
  const status = err?.statusCode || err?.response?.status;
  if (code === 'NoSuchBucket') return false;
  return code === 'NoSuchKey' || status === 404;
}

// 对象在不在。404 返回 false，其他错误照实抛出（由调用方决定怎么报）。
async function objectExists(client, bucket, key) {
  try {
    const result = await client.headObject({ bucket, key });
    return result?.statusCode === 200;
  } catch (err) {
    if (objectMissing(err)) return false;
    throw err;
  }
}

async function checkedClient() {
  let current;
  try {
    current = settings();
  } catch (err) {
    throw err;
  }
  if (!current.bucket) throw new HttpError(409, 'tos_not_configured', 'TOS 尚未配置。请先在「管理」中填写已有的 Bucket。');
  const credentials = tosCredentials();
  if (!credentials) throw new HttpError(409, 'tos_credentials_missing', 'TOS 尚未配置 Access Key。请在「管理」中填写有 TOS 权限的 Access Key ID 和 Secret Access Key。');
  return { current, client: clientFor(current, credentials) };
}

async function ensurePrefix(current, client, credentials) {
  if (!current.prefix) return;
  const key = `${current.prefix}/${TOS_MARKER}`;
  await client.putObject({ bucket: current.bucket, key, body: Buffer.from('created by Innate Studio\n'), contentType: 'text/plain' });
}

// 保存前先 HEAD Bucket 验证存在和权限；不会调用 createBucket。
export async function saveTosConfig(input) {
  const value = stored();
  const bucket = normalizeBucket(input?.bucket);
  const prefix = normalizePrefix(input?.prefix);
  const region = normalizeRegion(input?.region || DEFAULT_REGION);
  const endpointValue = input?.endpoint || DEFAULT_ENDPOINT;
  const endpoint = normalizedEndpoint(endpointValue);
  const publicBaseUrl = normalizePublicBaseUrl(input?.publicBaseUrl);
  const newId = String(input?.accessKeyId || '').trim();
  const newSecret = String(input?.secretAccessKey || '').trim();
  if (Boolean(newId) !== Boolean(newSecret)) throw new HttpError(400, 'invalid_tos_credentials', 'Access Key ID 和 Secret Access Key 必须同时填写');
  if (newId && !/^[\x21-\x7e]+$/.test(newId)) throw new HttpError(400, 'invalid_tos_credentials', 'Access Key ID 格式不正确');
  if (newSecret && !/^[\x21-\x7e]+$/.test(newSecret)) throw new HttpError(400, 'invalid_tos_credentials', 'Secret Access Key 格式不正确');
  const credentials = newId ? { id: newId, secret: newSecret, source: 'tos-file' } : tosCredentials();
  if (!credentials) throw new HttpError(400, 'tos_credentials_missing', '请填写有 TOS 权限的 Access Key ID 和 Secret Access Key');
  const candidate = { bucket, prefix, region, endpoint: endpoint.endpoint, secure: endpoint.secure, publicBaseUrl };
  const client = clientFor(candidate, credentials);
  try {
    await client.headBucket(bucket);
    await ensurePrefix(candidate, client, credentials);
  } catch (err) {
    resetClient();
    throw mapTosError(err, '校验 Bucket');
  }
  config.tos = { ...value, ...candidate, ...(newId ? { accessKeyId: newId, accessKeySecret: newSecret } : {}) };
  saveConfig();
  resetClient();
  return tosConfigView();
}

export function clearTosConfig() {
  delete config.tos;
  saveConfig();
  resetClient();
}

function kindOfKey(key) {
  return KIND_BY_EXT[path.extname(String(key)).toLowerCase()] || 'video';
}

function contentTypeOfKey(key) {
  return MIME_BY_EXT[path.extname(String(key)).toLowerCase()] || 'application/octet-stream';
}

function objectView(key, current, extra = {}) {
  return {
    key,
    name: relativeName(key, current.prefix),
    url: publicObjectUrl(key, current),
    kind: kindOfKey(key),
    contentType: extra.contentType || contentTypeOfKey(key),
    size: Number(extra.size || 0),
    lastModified: extra.lastModified ? new Date(extra.lastModified).toISOString() : null,
  };
}

export async function listTosObjects({ prefix = '', cursor = '', limit = 100 } = {}) {
  const { current, client } = await checkedClient();
  const search = normalizePrefix(prefix);
  const fullPrefix = search ? fullObjectKey(current.prefix, `${search}`) : current.prefix ? `${current.prefix}/` : '';
  const size = Math.min(200, Math.max(1, Math.round(Number(limit) || 100)));
  let result;
  try {
    result = await client.listObjectsType2({
      bucket: current.bucket,
      prefix: fullPrefix,
      maxKeys: size,
      // 不要传 continuationToken: undefined：SDK 会把它拼成空参数，导致 TOS 签名校验失败。
      ...(cursor ? { continuationToken: cursor } : {}),
    });
  } catch (err) {
    throw mapTosError(err, '读取素材列表');
  }
  const data = result?.data || result || {};
  const items = (data.Contents || [])
    .filter((item) => item?.Key && item.Key !== `${current.prefix}/${TOS_MARKER}` && !String(item.Key).endsWith(`/${TOS_MARKER}`))
    .map((item) => objectView(item.Key, current, { size: item.Size, lastModified: item.LastModified }));
  return {
    items,
    nextCursor: data.IsTruncated ? data.NextContinuationToken || '' : '',
    truncated: Boolean(data.IsTruncated),
    prefix: current.prefix,
  };
}

export async function uploadTosObject(body, contentType, filename) {
  if (!body?.length) throw new HttpError(400, 'empty_file', '文件为空');
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  const ext = Object.entries(UPLOAD_TYPES).find(([mime]) => mime === type)?.[1];
  if (!ext || !SUPPORTED_EXT.has(`.${ext}`)) throw new HttpError(415, 'unsupported_media_type', '素材库只支持 JPG、PNG、WebP、MP4、MOV、WebM、MP3、WAV');
  const original = path.basename(String(filename || `upload.${ext}`).replace(/\\/g, '/'));
  const safe = original.replace(/[^\p{L}\p{N}._ -]+/gu, '_').slice(0, 160) || `upload.${ext}`;
  const { current, client } = await checkedClient();
  const date = new Date().toISOString().slice(0, 10);
  const key = fullObjectKey(current.prefix, `uploads/${date}/${crypto.randomBytes(5).toString('hex')}-${safe}`);
  try {
    await client.putObject({ bucket: current.bucket, key, body, contentType: type, acl: 'public-read' });
  } catch (err) {
    throw mapTosError(err, '上传素材');
  }
  return objectView(key, current, { size: body.length, contentType: type, lastModified: new Date() });
}

export async function renameTosObject(key, name) {
  const { current, client } = await checkedClient();
  const source = assertObjectKey(key, current.prefix);
  const target = fullObjectKey(current.prefix, normalizeObjectName(name));
  if (source === target) return objectView(source, current);
  try {
    // TOS 的 renameObject 是服务端原地改名，避免大文件先复制再删除；recursiveMkdir 会自动补齐新路径。
    await client.renameObject({ bucket: current.bucket, key: source, newKey: target, recursiveMkdir: true });
  } catch (renameErr) {
    // RenameObject 需要 Bucket 开启对应能力；老 Bucket 用 CopyObject + DeleteObject 兜底。
    try {
      await client.copyObject({ bucket: current.bucket, key: target, srcBucket: current.bucket, srcKey: source, acl: 'public-read', metadataDirective: 'COPY' });
      await client.deleteObject({ bucket: current.bucket, key: source });
    } catch (copyErr) {
      throw mapTosError(renameErr?.code ? renameErr : copyErr, '重命名素材');
    }
  }
  return objectView(target, current);
}

export async function deleteTosObject(key) {
  const { current, client } = await checkedClient();
  const source = assertObjectKey(key, current.prefix);
  try {
    await client.deleteObject({ bucket: current.bucket, key: source });
  } catch (err) {
    throw mapTosError(err, '删除素材');
  }
  return null;
}

export function tosConfigured() {
  try {
    return Boolean(settings().bucket && tosCredentials());
  } catch {
    return false;
  }
}

function safePublicFileName(file) {
  return path.basename(file).replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 160) || 'media';
}

// 流式算内容哈希：整段视频一次 readFileSync 会占满内存、还会把事件循环堵住几百毫秒到几秒。
function fileDigest(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// 把一个本机文件上传成 TOS 公网对象。key 里带内容哈希，同一份内容即使换了本机地址也不会重复占空间。
export async function publishLocalFileToTos(space, localUrl, { purpose = 'share' } = {}) {
  const file = localMediaFile(space, localUrl);
  const ext = path.extname(file).toLowerCase();
  if (!SUPPORTED_EXT.has(ext)) throw new HttpError(400, 'invalid_request', '该文件类型不支持发布到 TOS');
  const { current, client } = await checkedClient();
  const { size } = fs.statSync(file);
  const digest = (await fileDigest(file)).slice(0, 16);
  const folder = purpose === 'reference' ? 'references' : 'published';
  const date = new Date().toISOString().slice(0, 10);
  const key = fullObjectKey(current.prefix, `${folder}/${date}/${digest}-${safePublicFileName(file)}`);
  const view = {
    provider: 'tos',
    key,
    url: publicObjectUrl(key, current),
    expiresAt: null,
    size,
    contentType: contentTypeOfKey(file),
    filename: path.basename(file),
  };
  try {
    // key 由内容决定，同一个文件永远算出同一个 key：对象已经在了就直接复用，不再传一遍。
    if (await objectExists(client, current.bucket, key)) return { ...view, reusedRemote: true };
    await client.putObjectFromFile({ bucket: current.bucket, key, filePath: file, contentType: view.contentType, acl: 'public-read' });
  } catch (err) {
    throw mapTosError(err, purpose === 'reference' ? '上传参考视频' : '发布素材');
  }
  return view;
}

// 复用缓存之前检查对象是否还在；返回最新的公网地址（自定义域名改了也能跟着更新）。
// 返回值：对象在 → 最新的记录；对象确实没了 → null（调用方会重传）；
// 其他错误（超时、5xx、权限）直接抛出，让调用方复用旧链接或报错，而不是重传整份文件。
export async function validateTosPublication(publication) {
  const { current, client } = await checkedClient();
  const key = String(publication?.key || '');
  // 前缀改过、或者记录里的 key 不在当前前缀内：这条记录已经用不了，交给调用方重新上传。
  if (!keyInPrefix(key, current.prefix)) return null;
  try {
    const result = await client.headObject({ bucket: current.bucket, key });
    if (result?.statusCode !== 200) return null;
    return { ...publication, url: publicObjectUrl(key, current), checkedAt: Date.now() };
  } catch (err) {
    if (objectMissing(err)) return null;
    throw mapTosError(err, '检查 TOS 对象');
  }
}

export const __tosInternals = { settings, normalizeBucket, normalizeEndpoint: normalizedEndpoint, objectView };
