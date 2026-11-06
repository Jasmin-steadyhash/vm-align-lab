// lab 渲染页：直接 import ava-studio 的 client/src、shared 的渲染、贴图处理、对齐代码；/img、/riv 指向 data/，/api 转到本地 worker（8790）
// 本仓库没有装 vite 和渲染依赖，都用 ava-studio 的 node_modules，所以这里不 import 'vite'
import path from 'node:path';
import { createRequire } from 'node:module';

// ava-studio 位置，规则和 scripts/lab.mjs 的 AVA 一致
const repo = path.resolve(process.env.AVA_STUDIO_DIR || path.join(__dirname, '..', 'ava-studio'));
const require = createRequire(path.join(repo, 'package.json'));
const riveCanvasVersion = require('@rive-app/canvas/package.json').version;

export default {
  root: path.resolve(__dirname, 'page'),
  // 每个端口一份依赖缓存：几个 lab 同时跑时，一个重建缓存会把别的页面刷掉（v6 两组同时被刷崩）
  cacheDir: path.resolve(__dirname, `.vite-cache/${process.env.LAB_PORT || 5180}`),
  publicDir: path.resolve(__dirname, 'data'),
  define: { __RIVE_CANVAS_VERSION__: JSON.stringify(riveCanvasVersion) },
  worker: { format: 'es' },
  resolve: {
    alias: {
      '@client': path.join(repo, 'client/src'),
      '@shared': path.join(repo, 'shared'),
      // page/ 往上找不到 ava-studio 的 node_modules，指过去；和 client/src 里的 import 落到同一份
      '@rive-app/canvas': path.join(repo, 'node_modules/@rive-app/canvas'),
    },
  },
  server: {
    port: Number(process.env.LAB_PORT || 5180),
    strictPort: true,
    // 改 lab 代码时不要把正在跑的页面刷掉
    hmr: false,
    watch: null,
    fs: { allow: [repo, __dirname] },
    proxy: {
      '/api': { target: 'http://localhost:8790', changeOrigin: true },
      // 本地 worker 存的生图结果、job-inputs（本地 R2），同源取避免跨域
      '/tenants': { target: 'http://localhost:8790', changeOrigin: true },
      '/job-inputs': { target: 'http://localhost:8790', changeOrigin: true },
    },
  },
};
