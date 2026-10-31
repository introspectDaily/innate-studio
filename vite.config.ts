import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 页面源码在 web/，构建结果在 web/dist/，由 server.js 托管。
// pnpm dev 时页面由 Vite 提供（改了代码立刻生效），接口和媒体文件转给本地服务。
// 本地服务只认自己这个地址发来的请求，所以转发时把来源改成它。
const local = `http://127.0.0.1:${process.env.PORT || 5178}`;
const toLocal = { target: local, changeOrigin: true, headers: { origin: local } };

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  // 页面要读仓库根目录下的 shared/，开发模式下得允许它读 web/ 以外的文件。
  server: { host: '127.0.0.1', port: 5173, fs: { allow: ['..'] }, proxy: { '/api': toLocal, '/media': toLocal } },
});
