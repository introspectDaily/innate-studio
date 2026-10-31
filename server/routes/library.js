// 用户自己攒下来的东西：画布、工作流、角色、技能。都是原样存、原样取的小集合。

import fs from 'node:fs';
import path from 'node:path';
import { HttpError, readJsonBody, route } from '../http.js';
import { localMediaFile } from '../media.js';
import { newId } from '../tasks.js';
import { OFFICIAL_SKILLS } from '../../shared/skills.ts';

// ---------- 画布 ----------
// 一张画布是一组节点和连线，里面的内容由页面决定。节点只记生成记录的 id，结果还是在生成记录里。

// 列表里只给名字、封面和时间，节点和连线点进去才读。封面是画布里最近生成的一张图或一段视频的地址。
const canvasMeta = (canvas) => ({ id: canvas.id, name: canvas.name, cover: canvas.cover || null, updatedAt: canvas.updatedAt });
const canvasName = (name) => String(name || '').trim().slice(0, 60) || '未命名画布';
function findCanvas(space, id) {
  const canvas = space.canvases.find((c) => c.id === id);
  if (!canvas) throw new HttpError(404, 'not_found', '画布不存在');
  return canvas;
}

route('GET', /^\/api\/canvases$/, async ({ space }) => ({ items: space.canvases.map(canvasMeta).sort((a, b) => b.updatedAt - a.updatedAt) }));

// 没起名字的新画布：已经有「未命名画布」了就叫「未命名画布 2」「未命名画布 3」，列表里一排同名的分不开。
function freshName(space) {
  const taken = new Set(space.canvases.map((c) => c.name));
  let n = 1;
  while (taken.has(n === 1 ? '未命名画布' : `未命名画布 ${n}`)) n += 1;
  return n === 1 ? '未命名画布' : `未命名画布 ${n}`;
}

route('POST', /^\/api\/canvases$/, async ({ req, space }) => {
  const { name } = await readJsonBody(req);
  const now = Date.now();
  const canvas = { id: newId('cv'), name: String(name || '').trim() ? canvasName(name) : freshName(space), nodes: [], edges: [], viewport: null, cover: null, createdAt: now, updatedAt: now };
  space.canvases.push(canvas);
  space.save('canvases');
  return canvas;
});

route('GET', /^\/api\/canvases\/([\w-]+)$/, async ({ params, space }) => findCanvas(space, params[0]));

route('PUT', /^\/api\/canvases\/([\w-]+)$/, async ({ req, params, space }) => {
  const canvas = findCanvas(space, params[0]);
  const body = await readJsonBody(req);
  for (const field of ['nodes', 'edges']) {
    if (body[field] === undefined) continue;
    if (!Array.isArray(body[field])) throw new HttpError(400, 'invalid_request', `${field} 需要是数组`);
    canvas[field] = body[field];
  }
  if (body.name !== undefined) canvas.name = canvasName(body.name);
  if (body.viewport !== undefined) canvas.viewport = body.viewport;
  if (body.cover !== undefined) canvas.cover = typeof body.cover?.url === 'string' ? { url: body.cover.url, kind: body.cover.kind === 'video' ? 'video' : 'image' } : null;
  canvas.updatedAt = Date.now();
  space.save('canvases');
  return canvasMeta(canvas);
});

// ---------- 画布上的单个节点 ----------
// 整份 PUT 是「换成我这一份」，页面上同时在改的东西会被一起覆盖掉。agent 只想改一个节点的提示词时，
// 走下面这两条：只动传进来的字段，节点的历史版本（kept）、分组里的成员（members）、比例这些都留着。

function findNode(canvas, id) {
  const node = (canvas.nodes || []).find((item) => item?.id === id);
  if (!node) throw new HttpError(404, 'not_found', '节点不存在');
  return node;
}

const NODE_FIELDS = ['data', 'position', 'hidden'];

route('GET', /^\/api\/canvases\/([\w-]+)\/nodes\/([\w.-]+)$/, async ({ params, space }) => findNode(findCanvas(space, params[0]), params[1]));

// data 是浅合并：给 null 是删掉这个键（例如清掉 flowValues），不是把值写成 null。
// 不认识的字段直接 400：手写成 prompt 这种拼错，静默不生效比报错更难查。
route('PATCH', /^\/api\/canvases\/([\w-]+)\/nodes\/([\w.-]+)$/, async ({ req, params, space }) => {
  const canvas = findCanvas(space, params[0]);
  const node = findNode(canvas, params[1]);
  const body = await readJsonBody(req);
  const unknown = Object.keys(body).filter((field) => !NODE_FIELDS.includes(field));
  if (unknown.length) throw new HttpError(400, 'invalid_request', `不支持改 ${unknown.join('、')}；能改的是 ${NODE_FIELDS.join('、')}`);
  if (body.data !== undefined) {
    if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) throw new HttpError(400, 'invalid_request', 'data 需要是一个对象');
    const keys = Object.keys(body.data);
    if (!keys.length) throw new HttpError(400, 'invalid_request', 'data 里没有要改的字段');
    const data = { ...(node.data || {}) };
    for (const key of keys) {
      if (body.data[key] === null) delete data[key];
      else data[key] = body.data[key];
    }
    node.data = data;
  }
  if (body.position !== undefined) {
    const { x, y } = body.position || {};
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new HttpError(400, 'invalid_request', 'position 要有数字的 x 和 y');
    node.position = { x, y };
  }
  if (body.hidden !== undefined) {
    if (typeof body.hidden !== 'boolean') throw new HttpError(400, 'invalid_request', 'hidden 需要是 true 或 false');
    if (body.hidden) node.hidden = true;
    else delete node.hidden;
  }
  if (!NODE_FIELDS.some((field) => body[field] !== undefined)) throw new HttpError(400, 'invalid_request', '要改点什么：data / position / hidden');
  canvas.updatedAt = Date.now();
  space.save('canvases');
  return { canvas: canvas.id, node, updatedAt: canvas.updatedAt };
});

route('DELETE', /^\/api\/canvases\/([\w-]+)$/, async ({ params, space }) => {
  space.canvases.splice(space.canvases.indexOf(findCanvas(space, params[0])), 1);
  space.save('canvases');
  return null;
});

// ---------- 工作流 ----------
// 一份工作流是画布上的一组节点和它们之间的连线，存下来以后可以整套放回任何一张画布。列表里只给名字、节点数和时间。

const MAX_WORKFLOW_NODES = 200;
const workflowName = (name) => String(name || '').trim().slice(0, 60) || '未命名工作流';
const workflowMeta = (flow) => ({ id: flow.id, name: flow.name, count: flow.nodes.length, updatedAt: flow.updatedAt });
function findWorkflow(space, id) {
  const flow = space.workflows.find((w) => w.id === id);
  if (!flow) throw new HttpError(404, 'not_found', '工作流不存在');
  return flow;
}

route('GET', /^\/api\/workflows$/, async ({ space }) => ({ items: [...space.workflows].sort((a, b) => b.updatedAt - a.updatedAt).map(workflowMeta) }));

route('POST', /^\/api\/workflows$/, async ({ req, space }) => {
  const { name, nodes, edges } = await readJsonBody(req);
  if (!Array.isArray(nodes) || !nodes.length) throw new HttpError(400, 'invalid_request', '工作流至少包含一个节点');
  if (nodes.length > MAX_WORKFLOW_NODES) throw new HttpError(400, 'invalid_request', `工作流最多 ${MAX_WORKFLOW_NODES} 个节点`);
  if (!Array.isArray(edges)) throw new HttpError(400, 'invalid_request', 'edges 需要是数组');
  const now = Date.now();
  const flow = { id: newId('wf'), name: workflowName(name), nodes, edges, createdAt: now, updatedAt: now };
  space.workflows.push(flow);
  space.save('workflows');
  return workflowMeta(flow);
});

route('GET', /^\/api\/workflows\/([\w-]+)$/, async ({ params, space }) => findWorkflow(space, params[0]));

route('PUT', /^\/api\/workflows\/([\w-]+)$/, async ({ req, params, space }) => {
  const flow = findWorkflow(space, params[0]);
  const body = await readJsonBody(req);
  if (body.name !== undefined) flow.name = workflowName(body.name);
  flow.updatedAt = Date.now();
  space.save('workflows');
  return workflowMeta(flow);
});

route('DELETE', /^\/api\/workflows\/([\w-]+)$/, async ({ params, space }) => {
  space.workflows.splice(space.workflows.indexOf(findWorkflow(space, params[0])), 1);
  space.save('workflows');
  return null;
});

// ---------- 角色 ----------
// 一个角色是一个名字、一段描述和几张参考图。生成图片或视频时把这些图当参考图带上，同一个角色才能反复出现。
// 参考图只存本机的图片地址，都在 uploads 里：从生成记录里选的图会复制一份过来，免得那条记录删掉之后角色的图也没了。

const MAX_CHARACTER_IMAGES = 6;
const CHARACTER_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp'];
const characterName = (name) => String(name || '').trim().slice(0, 60) || '未命名角色';
function findCharacter(space, id) {
  const character = space.characters.find((c) => c.id === id);
  if (!character) throw new HttpError(404, 'not_found', '角色不存在');
  return character;
}
function characterImages(space, urls) {
  if (!Array.isArray(urls)) throw new HttpError(400, 'invalid_request', 'images 需要是数组');
  if (urls.length > MAX_CHARACTER_IMAGES) throw new HttpError(400, 'invalid_request', `每个角色最多 ${MAX_CHARACTER_IMAGES} 张参考图`);
  return urls.map((url) => {
    const file = localMediaFile(space, url);
    const ext = path.extname(file).slice(1).toLowerCase();
    if (!CHARACTER_IMAGE_EXTS.includes(ext)) throw new HttpError(400, 'invalid_request', '角色参考图仅支持图片');
    if (path.dirname(file) === space.dir('uploads')) return `/media/uploads/${path.basename(file)}`;
    const copy = `${newId('up')}.${ext}`;
    fs.copyFileSync(file, path.join(space.dir('uploads'), copy));
    return `/media/uploads/${copy}`;
  });
}

route('GET', /^\/api\/characters$/, async ({ space }) => ({ items: [...space.characters].sort((a, b) => b.updatedAt - a.updatedAt) }));

route('POST', /^\/api\/characters$/, async ({ req, space }) => {
  const { name, description, images } = await readJsonBody(req);
  const now = Date.now();
  const character = { id: newId('ch'), name: characterName(name), description: String(description || '').trim().slice(0, 2000), images: characterImages(space, images || []), createdAt: now, updatedAt: now };
  space.characters.push(character);
  space.save('characters');
  return character;
});

route('PUT', /^\/api\/characters\/([\w-]+)$/, async ({ req, params, space }) => {
  const character = findCharacter(space, params[0]);
  const body = await readJsonBody(req);
  if (body.images !== undefined) character.images = characterImages(space, body.images);
  if (body.name !== undefined) character.name = characterName(body.name);
  if (body.description !== undefined) character.description = String(body.description || '').trim().slice(0, 2000);
  character.updatedAt = Date.now();
  space.save('characters');
  return character;
});

route('DELETE', /^\/api\/characters\/([\w-]+)$/, async ({ params, space }) => {
  space.characters.splice(space.characters.indexOf(findCharacter(space, params[0])), 1);
  space.save('characters');
  return null;
});

// ---------- 技能 ----------
// 一个技能是一套写提示词的规则：用户只写一句简单的话，发送前让文本模型按规则扩写成完整的提示词。
// 官方技能登记在 shared/skills.ts，不能改；用户自己建的存在 skills.json。

const SKILL_TYPES = ['video', 'image'];
const allSkills = (space) => [...OFFICIAL_SKILLS, ...[...space.skills].sort((a, b) => b.updatedAt - a.updatedAt)];
export function findSkill(space, id) {
  const skill = allSkills(space).find((item) => item.id === id);
  if (!skill) throw new HttpError(404, 'not_found', '技能不存在');
  return skill;
}
function ownSkill(space, id) {
  const skill = findSkill(space, id);
  if (skill.official) throw new HttpError(400, 'invalid_request', '官方技能不可修改');
  return skill;
}
// 标签：去掉空的和重复的，每个最多 10 个字，最多留 3 个。
function skillTags(value) {
  if (!Array.isArray(value)) throw new HttpError(400, 'invalid_request', '标签格式不正确');
  return [...new Set(value.map((tag) => String(tag ?? '').trim().slice(0, 10)).filter(Boolean))].slice(0, 3);
}
// 名称、说明、规则都要有；规则太短等于没有规则。
function skillFields(body, current = {}) {
  const next = {
    name: body.name === undefined ? current.name : String(body.name || '').trim().slice(0, 30),
    description: body.description === undefined ? current.description : String(body.description || '').trim().slice(0, 120),
    type: body.type === undefined ? current.type : body.type,
    tags: body.tags === undefined ? current.tags || [] : skillTags(body.tags),
    rules: body.rules === undefined ? current.rules : String(body.rules || '').trim(),
  };
  if (!next.name) throw new HttpError(400, 'invalid_request', '请输入技能名称');
  if (!SKILL_TYPES.includes(next.type)) throw new HttpError(400, 'invalid_request', '技能仅支持视频或图片');
  if (next.rules.length < 10) throw new HttpError(400, 'invalid_request', '请输入技能规则');
  if (next.rules.length > 8000) throw new HttpError(400, 'invalid_request', '规则太长，最多 8000 字');
  return next;
}

route('GET', /^\/api\/skills$/, async ({ space }) => ({ items: allSkills(space) }));

route('POST', /^\/api\/skills$/, async ({ req, space }) => {
  const now = Date.now();
  const skill = { id: newId('sk'), ...skillFields(await readJsonBody(req)), createdAt: now, updatedAt: now };
  space.skills.push(skill);
  space.save('skills');
  return skill;
});

route('PUT', /^\/api\/skills\/([\w-]+)$/, async ({ req, params, space }) => {
  const skill = ownSkill(space, params[0]);
  Object.assign(skill, skillFields(await readJsonBody(req), skill), { updatedAt: Date.now() });
  space.save('skills');
  return skill;
});

route('DELETE', /^\/api\/skills\/([\w-]+)$/, async ({ params, space }) => {
  space.skills.splice(space.skills.indexOf(ownSkill(space, params[0])), 1);
  space.save('skills');
  return null;
});
