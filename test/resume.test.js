// 服务重启之后要接着跑：平台上还在跑的任务继续查，跑完了的结果继续存到本机。
// 这些都是纯函数 + 假空间，不碰网络。

import test from 'node:test';
import assert from 'node:assert/strict';
import { absUrl, resumePending } from '../server/tasks.js';

// 一个够用的假空间：resumePending 只用 history 和 save。
const fakeSpace = (history) => {
  const saved = [];
  return { history, saved, save: (name) => saved.push(name) };
};

test('结果地址：平台没给域名时用自己的完整地址（RunningHub 的结果在对象存储上）', () => {
  // 以前这里拿空串当基准，new URL 会抛 Invalid URL，结果是任务跑完了文件却下不下来。
  const target = absUrl('https://rh-hk-images.cdn.example.com/a/b.mp4', { baseUrl: '' });
  assert.equal(target.href, 'https://rh-hk-images.cdn.example.com/a/b.mp4');
  // 有域名时，相对地址按它拼。
  assert.equal(absUrl('/media/x.mp4', { baseUrl: 'https://api.example.com' }).href, 'https://api.example.com/media/x.mp4');
  assert.equal(absUrl('https://cdn.example.com/x.mp4', { baseUrl: 'https://api.example.com' }).href, 'https://cdn.example.com/x.mp4');
});

test('重启后：还在跑的任务保持进行中，报告接上了几个', () => {
  const space = fakeSpace([
    { id: 'a', status: 'in_progress', provider: 'runninghub' },
    { id: 'b', status: 'queued', provider: 'ark' },
    { id: 'c', status: 'completed', provider: 'ark', localFile: 'c.mp4' },
    { id: 'd', status: 'failed', provider: 'ark' },
  ]);
  const resumed = resumePending(space);
  assert.equal(resumed, 2);
  assert.equal(space.history[0].status, 'in_progress');
  assert.equal(space.history[1].status, 'queued');
});

test('重启后：跑完了但没存下文件的，给一次新的机会重下', () => {
  const space = fakeSpace([
    // 以前失败 6 次就永远不再试了，卡在「保存失败」。
    { id: 'a', status: 'completed', provider: 'runninghub', remoteUrl: 'https://cdn.example.com/a.mp4', downloadAttempts: 6 },
    // 还没试满的：不动，交给轮询循环按节奏重试。
    { id: 'b', status: 'completed', provider: 'runninghub', remoteUrl: 'https://cdn.example.com/b.mp4', downloadAttempts: 2 },
    // 已经存好了的：不动。
    { id: 'c', status: 'completed', provider: 'ark', localFile: 'c.mp4', remoteUrl: 'https://cdn.example.com/c.mp4', downloadAttempts: 9 },
  ]);
  resumePending(space);
  assert.equal(space.history[0].downloadAttempts, 0);
  assert.equal(space.history[1].downloadAttempts, 2);
  assert.equal(space.history[2].downloadAttempts, 9);
  assert.deepEqual(space.saved, ['history']);
});
