// 第 10 条验证：在评审过的每张 riv 上重新 AI 定点（各 3 次），连同主图定点原始坐标存下来，离线对照评审逐项结论
// 用法：node scripts/verify-metrics.mjs <项目 id ...>
import fs from 'node:fs';
import { openLab, projectInput, readJson, writeJson, labPath } from './lab.mjs';
import { startVmOf } from './start-vm.mjs';
import { locate, POINTS_WHITE } from './landmarks.mjs';
import { setUsageTag } from './usage.mjs';

const MODEL = 'gpt-6-astra';
const OUT = 'results/metric-check/raw.json';
const raw = fs.existsSync(labPath(OUT)) ? readJson(OUT) : {};
const judged = readJson('results/judge/devcmp/summary.json');
const three = (img) => Promise.all([1, 2, 3].map(() => locate(MODEL, img, POINTS_WHITE)));
const lab = await openLab();
try {
  for (const id of process.argv.slice(2)) {
    const p = (raw[id] ??= {});
    setUsageTag(`metric-check/${id.slice(0, 8)}`);
    const info = await lab.call('loadProject', projectInput(id));
    await lab.call('loadMaster');
    const start = { ...startVmOf(info.savedVm, await lab.call('tunableParams')), Head_scale: 100 };
    if (!p.master) { p.master = await three(await lab.call('masterForPoints')); writeJson(OUT, raw); }
    for (const method of Object.keys(judged[id] || {})) {
      if (p[method]) continue;
      const vm = method === 'start' ? start : JSON.parse(fs.readFileSync(labPath(`results/${method}/${id.slice(0, 8)}/trace.json`), 'utf8')).finalVm;
      await lab.call('loadProject', projectInput(id));
      const texF = labPath(`results/${method}/${id.slice(0, 8)}/textures.json`);
      if (method.startsWith('agent/') && fs.existsSync(texF)) await lab.call('restoreTextures', JSON.parse(fs.readFileSync(texF, 'utf8')));
      p[method] = await three(await lab.call('rivForPoints', vm));
      writeJson(OUT, raw);
      console.log(id.slice(0, 8), method, 'ok', p[method].filter(Boolean).length);
    }
  }
} finally { await lab.close(); }
