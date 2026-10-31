// 账号和登录。部署给多人用的时候才用得上：
// 数据目录里有 users.json（至少建过一个账号）就是「多人模式」，每个请求都要先登录，各人的数据放在各自的目录里；
// 没有就是原来的「本机模式」，不用登录，数据就在数据目录里。账号用 pnpm user 建第一个，之后在页面的设置里管。
//
// 密码只存加盐的 scrypt 散列。登录后给浏览器一个随机的令牌放在 Cookie 里，服务这边只存令牌的散列。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { HttpError } from './http.js';

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const COOKIE = 'innate_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
// 同一个名字连续输错这么多次，就锁这么久。
const MAX_FAILS = 5;
const LOCK_MS = 10 * 60 * 1000;

function read(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function write(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

let users = read(USERS_FILE, []);
let sessions = read(SESSIONS_FILE, []);
let usersMtime = 0;
let sessionsMtime = 0;

function syncUsers() {
  try {
    const mtime = fs.statSync(USERS_FILE).mtimeMs;
    if (mtime !== usersMtime) {
      users = read(USERS_FILE, []);
      usersMtime = mtime;
    }
  } catch {
    users = [];
    usersMtime = 0;
  }
}

function syncSessions() {
  try {
    const mtime = fs.statSync(SESSIONS_FILE).mtimeMs;
    if (mtime !== sessionsMtime) {
      sessions = read(SESSIONS_FILE, []);
      sessionsMtime = mtime;
    }
  } catch {
    sessions = [];
    sessionsMtime = 0;
  }
}
syncUsers();
syncSessions();

const saveUsers = () => {
  write(USERS_FILE, users);
  try { usersMtime = fs.statSync(USERS_FILE).mtimeMs; } catch {}
};
const saveSessions = () => {
  write(SESSIONS_FILE, sessions);
  try { sessionsMtime = fs.statSync(SESSIONS_FILE).mtimeMs; } catch {}
};

export const isHosted = () => {
  syncUsers();
  return users.length > 0;
};
export const userDir = (id) => path.join(DATA_DIR, 'users', id);
export const allUsers = () => {
  syncUsers();
  return users;
};

// 给页面看的账号信息，不带密码的散列。
export const userView = (user) => ({ id: user.id, name: user.name, role: user.role, disabled: Boolean(user.disabled), createdAt: user.createdAt, lastSeenAt: user.lastSeenAt || null });

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

function setPassword(user, password) {
  user.salt = crypto.randomBytes(16).toString('hex');
  user.hash = hashPassword(password, user.salt);
}

// 初始密码：随机的 12 位，去掉了容易看错的字符。建账号、重置密码时生成，只显示这一次。
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newPassword = () => Array.from(crypto.randomBytes(12), (byte) => ALPHABET[byte % ALPHABET.length]).join('');

function checkPassword(password) {
  const value = String(password || '');
  if (value.length < 6) throw new HttpError(400, 'invalid_request', '密码至少 6 位');
  if (value.length > 200) throw new HttpError(400, 'invalid_request', '密码太长');
  return value;
}

export function findUser(id) {
  syncUsers();
  const user = users.find((u) => u.id === id);
  if (!user) throw new HttpError(404, 'not_found', '成员不存在');
  return user;
}

export function createUser({ name, role = 'member', password }) {
  syncUsers();
  const clean = String(name || '').trim();
  if (!clean || clean.length > 30) throw new HttpError(400, 'invalid_request', '请输入名称，最多 30 个字');
  if (users.some((u) => sameName(u.name, clean))) throw new HttpError(400, 'invalid_request', '该名称已被使用');
  const user = { id: `u_${crypto.randomBytes(8).toString('hex')}`, name: clean, role: role === 'admin' ? 'admin' : 'member', createdAt: Date.now() };
  setPassword(user, checkPassword(password));
  users.push(user);
  saveUsers();
  return user;
}

// 至少要留一个能用的管理员，不然没人能管成员和 Key 了。
function keepAnAdmin(user, change) {
  const stillAdmin = (u) => u.role === 'admin' && !u.disabled;
  if (!stillAdmin(user)) return;
  const after = { ...user, ...change };
  if (!stillAdmin(after) && !users.some((u) => u !== user && stillAdmin(u))) throw new HttpError(400, 'invalid_request', '至少保留一名可用的管理员');
}

export function updateUser(user, { role, disabled, password }) {
  syncUsers();
  const change = {};
  if (role !== undefined) change.role = role === 'admin' ? 'admin' : 'member';
  if (disabled !== undefined) change.disabled = Boolean(disabled);
  keepAnAdmin(user, change);
  Object.assign(user, change);
  if (password !== undefined) setPassword(user, checkPassword(password));
  // 停用、改了密码：这个账号已经登录着的地方都退出。
  if (user.disabled || password !== undefined) dropSessions(user.id);
  saveUsers();
  return user;
}

// 只删账号，它的数据目录留在磁盘上。
export function removeUser(user) {
  syncUsers();
  keepAnAdmin(user, { disabled: true });
  users.splice(users.indexOf(user), 1);
  dropSessions(user.id);
  saveUsers();
}

function dropSessions(userId, except) {
  syncSessions();
  sessions = sessions.filter((s) => s.userId !== userId || s.token === except);
  saveSessions();
}

// ---------- 登录 ----------

const fails = new Map();

export function login(name, password) {
  syncUsers();
  syncSessions();
  const key = String(name || '').trim().toLowerCase();
  const record = fails.get(key);
  if (record && record.count >= MAX_FAILS && Date.now() - record.at < LOCK_MS) throw new HttpError(429, 'too_many_attempts', '尝试次数过多，请 10 分钟后再试');
  const user = users.find((u) => sameName(u.name, key));
  // 没有这个名字时也照样算一遍散列，免得从快慢上看得出名字存不存在。
  const hash = hashPassword(String(password || ''), user?.salt || 'no-such-user');
  const ok = Boolean(user) && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.hash));
  if (!ok || user.disabled) {
    fails.set(key, { count: record && Date.now() - record.at < LOCK_MS ? record.count + 1 : 1, at: Date.now() });
    throw new HttpError(401, 'bad_credentials', ok ? '该账号已停用' : '名称或密码不正确');
  }
  fails.delete(key);
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions = sessions.filter((s) => s.expiresAt > now);
  sessions.push({ token: sha256(token), userId: user.id, expiresAt: now + SESSION_MS });
  saveSessions();
  return { user, token };
}

export function changeOwnPassword(user, current, next, req) {
  syncUsers();
  syncSessions();
  if (hashPassword(String(current || ''), user.salt) !== user.hash) throw new HttpError(400, 'bad_credentials', '当前密码不正确');
  setPassword(user, checkPassword(next));
  // 别处登录着的都退出，正在用的这一处留着。
  dropSessions(user.id, sha256(tokenOf(req)));
  saveUsers();
}

function tokenOf(req) {
  const match = new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{64})`).exec(req.headers.cookie || '');
  return match ? match[1] : '';
}

// 这个请求是谁发的。没登录、登录过期、账号停用了，都是 null。
export function userOf(req) {
  syncUsers();
  syncSessions();
  const token = tokenOf(req);
  if (!token) return null;
  const hashed = sha256(token);
  const session = sessions.find((s) => s.token === hashed && s.expiresAt > Date.now());
  const user = session && users.find((u) => u.id === session.userId);
  if (!user || user.disabled) return null;
  // 最近来过的时间，一小时记一次就够了。
  if (Date.now() - (user.lastSeenAt || 0) > 60 * 60 * 1000) {
    user.lastSeenAt = Date.now();
    saveUsers();
  }
  return user;
}

export function logout(req) {
  syncSessions();
  const hashed = sha256(tokenOf(req));
  sessions = sessions.filter((s) => s.token !== hashed);
  saveSessions();
}

// 经过 HTTPS 的反向代理来的请求，Cookie 加上 Secure。
const secure = (req) => (req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '');
export const sessionCookie = (req, token) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_MS / 1000)}${secure(req)}`;
export const clearedCookie = (req) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(req)}`;
