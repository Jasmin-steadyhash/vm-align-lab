// 驱动 lab 渲染页：起 vite（page/）、用本机 Google Chrome（Playwright channel: chrome）打开，返回调 window.lab 的句柄
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const LAB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(LAB, '..', 'package.json'));
const { createServer } = await import(require.resolve('vite'));

export const readJson = (p) => JSON.parse(fs.readFileSync(path.join(LAB, p), 'utf8'));
export const writeJson = (p, v) => { fs.mkdirSync(path.dirname(path.join(LAB, p)), { recursive: true }); fs.writeFileSync(path.join(LAB, p), JSON.stringify(v, null, 2)); };
export const labPath = (p) => path.join(LAB, p);

export async function openLab({ headless = true } = {}) {
  const server = await createServer({ configFile: path.join(LAB, 'vite.config.mjs'), logLevel: 'warn' });
  await server.listen();
  const browser = await chromium.launch({ channel: 'chrome', headless, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const token = fs.readFileSync(path.join(LAB, 'data/token.txt'), 'utf8').trim();
  await page.addInitScript((t) => localStorage.setItem('builder_jwt', t), token);
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  page.on('console', (m) => { if (process.env.LAB_VERBOSE || m.type() === 'error') console.log(`[page ${m.type()}]`, m.text().slice(0, 300)); });
  await page.goto(`http://localhost:${process.env.LAB_PORT || 5180}/`);
  await page.waitForFunction(() => window.lab?.ready, null, { timeout: 120000 });
  const call = (fn, ...args) => page.evaluate(([f, a]) => window.lab[f](...a), [fn, args]);
  const close = async () => { await browser.close(); await server.close(); };
  return { page, call, close };
}

// 完整流程生成的项目：id = e2e-<名字>，数据在 data/e2e/<名字>/（主图、各组件最终贴图、候选池）
export const isE2E = (id) => String(id).startsWith('e2e-');
// 结果目录 / 用量标签里用的项目简称：线上项目取 id 前 8 位，完整流程项目用全名
export const projKey = (id) => (isE2E(id) ? id : String(id).slice(0, 8));
// 线上项目：每个项目一个目录 data/projects/<完整 id>/（project.json、jobs.json、img/ 图片 + img/map.json 线上 URL → 文件名），
// 由 scripts/fetch-project.mjs 准备；删项目 = 删这个目录
export function projectInput(id) {
  if (isE2E(id)) return { project: readJson(`data/e2e/${id.slice(4)}/project.json`), jobs: {} };
  const dir = `data/projects/${id}`;
  if (!fs.existsSync(path.join(LAB, dir, 'project.json'))) throw new Error(`没有项目数据 ${dir}，先跑 node scripts/fetch-project.mjs ${id}`);
  return { project: readJson(`${dir}/project.json`), jobs: readJson(`${dir}/jobs.json`), imgMap: readJson(`${dir}/img/map.json`), imgBase: `/projects/${id}/img/` };
}
