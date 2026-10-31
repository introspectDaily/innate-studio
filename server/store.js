// 存在磁盘上的东西：全局的设置（API Key），和一份「空间」里的数据（生成记录、画布、角色、技能、工作流、文件）。
// 本机模式只有一份空间，就是数据目录本身；多人模式下每个成员一份，在 users/<账号 id>/ 里。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, MEDIA_DIRS } from './config.js';

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value, mode) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const config = readJson(CONFIG_FILE, {});
export const saveConfig = () => writeJson(CONFIG_FILE, config, 0o600);

const COLLECTIONS = ['history', 'canvases', 'characters', 'skills', 'workflows', 'materials', 'publications'];
const FILE_DIRS = [...Object.values(MEDIA_DIRS), 'uploads', 'thumbs'];

class Space {
  constructor(root) {
    this.root = root;
    for (const name of FILE_DIRS) fs.mkdirSync(this.dir(name), { recursive: true });
    for (const name of COLLECTIONS) this[name] = readJson(path.join(root, `${name}.json`), []);
  }

  dir(name) {
    return path.join(this.root, name);
  }

  // 一条记录的结果文件放在哪个目录。
  resultDir(item) {
    return this.dir(MEDIA_DIRS[item.kind] || MEDIA_DIRS.video);
  }

  save(name) {
    writeJson(path.join(this.root, `${name}.json`), this[name]);
  }
}

const spaces = new Map();

export function openSpace(root = DATA_DIR) {
  if (!spaces.has(root)) spaces.set(root, new Space(root));
  return spaces.get(root);
}

export const openSpaces = () => [...spaces.values()];
