import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// 页面源码在 web/，构建结果在 web/dist/，由 server.js 托管。
// pnpm dev 时页面由 Vite 提供（改了代码立刻生效），接口和媒体文件转给本地服务。
// 本地服务只认自己这个地址发来的请求，所以转发时把来源改成它。
const local = `http://127.0.0.1:${process.env.PORT || 5178}`;
const toLocal = { target: local, changeOrigin: true, headers: { origin: local } };

const root = dirname(fileURLToPath(import.meta.url));

// @ffmpeg/core 的实际版本号：浏览器存那份 32MB 的缓存要按它命名，换了 core 版本缓存自动作废，
// 免得留着一份对不上的旧核心。
const corePkg = join(root, 'node_modules/@ffmpeg/core/package.json');
const coreVersion = existsSync(corePkg) ? String(JSON.parse(readFileSync(corePkg, 'utf8')).version || 'unknown') : 'unknown';

// ffmpeg.wasm 的核心是一份 32MB 的二进制，它是依赖 @ffmpeg/core 的产物，不进版本库——
// 否则每次升级都要往里多塞一份同样大的副本，而 git 对二进制几乎压不动、也算不出差异。
// 改成每次开发/构建之前从依赖里取一份出来，放进 web/public/ffmpeg/，由 Vite 当静态资源托管在 /ffmpeg/ 下。
// 仓库里只记 package.json 里的版本号；换了版本，重新构建自动跟着换。
const CORE_FILES = ['ffmpeg-core.js', 'ffmpeg-core.wasm'];
function syncFfmpegCore(): Plugin {
  return {
    name: 'sync-ffmpeg-core',
    buildStart() {
      const fromDir = join(root, 'node_modules/@ffmpeg/core/dist/umd');
      const toDir = join(root, 'web/public/ffmpeg');
      if (!existsSync(fromDir)) {
        this.warn('没找到 @ffmpeg/core，跳过核心文件同步；剪辑会回退到 CDN。请先安装依赖。');
        return;
      }
      mkdirSync(toDir, { recursive: true });
      for (const file of CORE_FILES) {
        const from = join(fromDir, file);
        const to = join(toDir, file);
        if (!existsSync(from)) continue;
        // 已经在位且没变过就跳过，省得每次启动都重抄一遍 32MB。
        if (existsSync(to)) {
          const a = statSync(from);
          const b = statSync(to);
          if (a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1000) continue;
        }
        copyFileSync(from, to);
      }
    },
  };
}

export default defineConfig({
  root: 'web',
  plugins: [react(), syncFfmpegCore()],
  define: { __FFMPEG_CORE_VERSION__: JSON.stringify(coreVersion) },
  build: { outDir: 'dist', emptyOutDir: true },
  // 页面要读仓库根目录下的 shared/，开发模式下得允许它读 web/ 以外的文件。
  server: { host: '127.0.0.1', port: 5173, fs: { allow: ['..'] }, proxy: { '/api': toLocal, '/media': toLocal } },
});
