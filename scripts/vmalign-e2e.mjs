// 真实 Studio 页面端到端（模型用假服务，不花钱）：点自动对齐 → 进度 → 写回 → 保存 → 撤销；统计 PATCH 次数，核对写回值和虹膜不被联动，截图。
// 用法：node scripts/vmalign-e2e.mjs <项目 id> <截图目录> [超时分钟]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
const [projectId, shotDir, minutes = '15'] = process.argv.slice(2);
fs.mkdirSync(shotDir, { recursive: true });
const token = fs.readFileSync(new URL('../data/token.txt', import.meta.url), 'utf8').trim();
const API = 'http://localhost:8788';
const getProject = async () => (await (await fetch(`${API}/api/projects/${projectId}`, { headers: { Authorization: `Bearer ${token}` } })).json());
const vmOf = (p) => JSON.parse(p.draftStateJson || '{}').viewModelState ?? {};
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
await page.addInitScript((t) => localStorage.setItem('builder_jwt', t), token);
const patches = []; let llm = 0;
page.on('request', (r) => {
  if (r.method() === 'PATCH' && /\/api\/projects\//.test(r.url())) { let keys = []; try { const b = JSON.parse(r.postData()); keys = Object.keys(b.draftStatePatch ?? {}).concat(Object.keys(b).filter((k) => k !== 'draftStatePatch')); } catch {} patches.push({ at: Date.now(), keys }); }
  if (/vm-align\/llm/.test(r.url())) llm++;
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));
const shot = (name) => page.screenshot({ path: path.join(shotDir, `${name}.png`) });
const barShot = async (name) => { const el = page.locator('.gp-studio-right').first(); await el.screenshot({ path: path.join(shotDir, `${name}.png`) }); };
await page.goto(`http://localhost:5174/generate?project=${projectId}`);
const button = page.getByRole('button', { name: /^(自动对齐|Auto Align)$/ });
await button.waitFor({ timeout: 120000 });
await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /^(自动对齐|Auto Align)$/.test(b.textContent.trim()) && !b.disabled), null, { timeout: 180000 });
await shot('1-idle-full'); await barShot('1-idle');
const before = vmOf(await getProject());
const patchesBefore = patches.length;
console.log('点击开始，起点已保存 VM key 数', Object.keys(before).length);
await button.click();
await page.waitForTimeout(8000); await barShot('2-running-early');
const deadline = Date.now() + Number(minutes) * 60000; let midShot = false;
for (;;) {
  const txt = await page.locator('.gp-studio-right').first().innerText();
  if (/已对齐|Aligned|无需调整|重新对齐|Align Again|应用结果|Apply Result/.test(txt)) break;
  if (!midShot && /第 1\d 步|step 1\d/.test(txt)) { await barShot('3-running-mid'); await shot('3-running-mid-full'); midShot = true; }
  if (Date.now() > deadline) { console.log('超时，当前文字：', txt.slice(0, 200)); break; }
  await page.waitForTimeout(3000);
}
await barShot('4-finished'); await shot('4-finished-full');
const finished = (await page.locator('.gp-studio-right').first().innerText()).split('\n').slice(0, 4).join(' | ');
console.log('结束文字：', finished, '| 模型代理调用', llm);
if (/应用结果|Apply Result/.test(finished)) { await barShot('4b-confirming'); await page.getByRole('button', { name: /应用结果|Apply Result/ }).click(); await page.waitForTimeout(500); await barShot('4c-saving'); await page.getByText(/已对齐|Aligned/).waitFor({ timeout: 30000 }).catch(() => console.log('等已对齐超时')); await barShot('4d-done'); }
await page.waitForTimeout(3000);
const after = vmOf(await getProject());
console.log('写回后 PATCH 次数', patches.length - patchesBefore, JSON.stringify(patches.slice(patchesBefore).map((p) => p.keys)));
const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]);
console.log('已保存 VM 变化：', changed.map((k) => `${k} ${before[k]}→${after[k]}`).join(', '));
// 过程记录：finalVm 和已保存的值逐个比，确认虹膜没被联动改掉
const undoBtn = page.getByRole('button', { name: /撤销对齐|Undo Alignment/ });
const noDownload = await undoBtn.count() === 0;
if (noDownload) console.log('没有撤销按钮');
else {
  const trace = await page.evaluate(() => null);
  const irisKeys = ['Eye_iris_R_X', 'Eye_iris_R_Y', 'Eye_iris_scale', 'Eye_scale_X', 'Eye_scale_Y'];
  console.log('眼睛相关已保存值', JSON.stringify(Object.fromEntries(irisKeys.map((k) => [k, after[k]]))));
  const patchesBeforeUndo = patches.length;
  await undoBtn.click();
  await page.waitForTimeout(500); await barShot('5-undoing');
  await page.waitForFunction(() => /已撤销对齐|Alignment undone/.test(document.querySelector('.gp-studio-right')?.innerText ?? ''), null, { timeout: 30000 }).catch(() => console.log('等撤销完成超时'));
  await barShot('6-undone');
  await page.waitForTimeout(2000);
  const undone = vmOf(await getProject());
  const diffs = [...new Set(changed)].filter((k) => before[k] !== undone[k]);
  console.log('撤销 PATCH 次数', patches.length - patchesBeforeUndo, '撤销后和起点不同的 key：', diffs.map((k) => `${k} ${before[k]}/${undone[k]}`).join(', ') || '无');
}
await browser.close();
process.exit(0);
