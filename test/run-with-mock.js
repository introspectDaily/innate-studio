// 用模拟接口启动一份独立的应用，方便调界面：不花钱，也不碰真实的 data/。
// 用法：pnpm dev:mock
// 可选 MOCK_SAMPLE=/path/to/video.mp4、MOCK_IMAGE=/path/to/image.jpg、MOCK_AUDIO=/path/to/audio.mp3，让生成结果是能看能听的真实文件。
// 可选 MOCK_TASK_SECONDS：模拟的任务要多少秒才处理完。整体走查要在两分钟内跑完，跑它时调小一点。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock, MOCK_ARK_KEY, MOCK_SPEECH_KEY, MOCK_AUTODL_TOKEN } from './mock-ark.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(root, 'test', '.tmp', 'dev-data');
const appPort = Number(process.env.PORT) || 5179;

fs.mkdirSync(dataDir, { recursive: true });
const configFile = path.join(dataDir, 'config.json');
if (!fs.existsSync(configFile)) fs.writeFileSync(configFile, JSON.stringify({ arkKey: MOCK_ARK_KEY, doubaoSpeechKey: MOCK_SPEECH_KEY, autodlToken: MOCK_AUTODL_TOKEN }));

const mock = await startMock({
  port: Number(process.env.MOCK_PORT) || 5999,
  sampleFile: process.env.MOCK_SAMPLE || '',
  imageFile: process.env.MOCK_IMAGE || '',
  audioFile: process.env.MOCK_AUDIO || '',
  ...(process.env.MOCK_TASK_SECONDS ? { taskSeconds: Number(process.env.MOCK_TASK_SECONDS) } : {}),
});
console.log(`模拟火山引擎：${mock.url}`);

const app = spawn(process.execPath, ['server.js'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PORT: String(appPort), ARK_BASE_URL: mock.url, DOUBAO_SPEECH_BASE_URL: mock.url, VOLC_BILLING_BASE_URL: mock.url, MINIMAX_BASE_URL: mock.url, MINIMAX_CN_API_KEY: '', AIHUBMIX_BASE_URL: mock.url, AIHUBMIX_API_KEY: '', AIHUBMIX_MANAGE_KEY: '', AUTODL_BASE_URL: mock.url, AUTODL_ART_API_KEY: '', AUTODL_TOKEN: '', INNATE_DATA_DIR: dataDir, ARK_API_KEY: '', DOUBAO_SPEECH_API_KEY: '', VOLC_ACCESS_KEY_ID: '', VOLC_SECRET_ACCESS_KEY: '' },
});

const stop = () => {
  app.kill();
  mock.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
app.on('exit', (code) => mock.close().then(() => process.exit(code ?? 0)));
