// lab 渲染页：直接 import 仓库 client/src 的渲染、贴图处理、对齐代码；/img、/riv 指向 data/，/api 转到本地 worker（8790）
import { defineConfig } from 'vite';
import path from 'node:path';
import { createRequire } from 'node:module';

const repo = path.resolve(__dirname, '..');
const require = createRequire(path.join(repo, 'package.json'));
const riveCanvasVersion = require('@rive-app/canvas/package.json').version;

export default defineConfig({
  root: path.resolve(__dirname, 'page'),
  // 每个端口一份依赖缓存：几个 lab 同时跑时，一个重建缓存会把别的页面刷掉（v6 两组同时被刷崩）
  cacheDir: path.resolve(__dirname, `.vite-cache/${process.env.LAB_PORT || 5180}`),
  publicDir: path.resolve(__dirname, 'data'),
  define: { __RIVE_CANVAS_VERSION__: JSON.stringify(riveCanvasVersion) },
  worker: { format: 'es' },
  resolve: { alias: { '@client': path.join(repo, 'client/src') } },
  server: {
    port: Number(process.env.LAB_PORT || 5180),
    strictPort: true,
    // 改 lab 代码时不要把正在跑的页面刷掉
    hmr: false,
    watch: null,
    fs: { allow: [repo] },
    proxy: {
      '/api': { target: 'http://localhost:8790', changeOrigin: true },
      // 本地 worker 存的生图结果、job-inputs（本地 R2），同源取避免跨域
      '/tenants': { target: 'http://localhost:8790', changeOrigin: true },
      '/job-inputs': { target: 'http://localhost:8790', changeOrigin: true },
    },
  },
});
