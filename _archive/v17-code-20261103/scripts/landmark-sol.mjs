// 定点模型对比：gpt-6.1-sol 在主图 3 张 + 人工标注 20 组 riv 上各标 3 次（POINTS_WHITE，同 agent 用的点），
// 存 results/metric-check/raw-sol.json（结构同 raw.json）；riv 上同时存代码真值 results/metric-check/truth.json
import fs from 'node:fs';
import { openLab, projectInput, readJson, writeJson, labPath } from './lab.mjs';
import { startVmOf } from './start-vm.mjs';
import { locate, POINTS_WHITE } from './landmarks.mjs';
import { setUsageTag } from './usage.mjs';
const MODEL = process.env.LM_MODEL || 'gpt-6.1-sol';
const key = readJson('results/human/key.json').filter((k) => !k.dup);
const fullId = Object.fromEntries(Object.keys(readJson('results/metric-check/raw.json')).map((k) => [k.slice(0, 8), k]));
const OUT = `results/metric-check/raw-${MODEL.replace(/[^a-z0-9.]/gi, '_')}.json`;
const raw = fs.existsSync(labPath(OUT)) ? readJson(OUT) : {};
const truth = fs.existsSync(labPath('results/metric-check/truth.json')) ? readJson('results/metric-check/truth.json') : {};
const three = (img) => Promise.all([1, 2, 3].map(() => locate(MODEL, img, POINTS_WHITE)));
setUsageTag(`landmark-bench/${MODEL}`);
const lab = await openLab();
try {
  for (const id of new Set(key.map((k) => fullId[k.id]))) {
    const p8 = id.slice(0, 8), r = (raw[id] ??= {});
    const info = await lab.call('loadProject', projectInput(id)); await lab.call('loadMaster');
    const start = { ...startVmOf(info.savedVm, await lab.call('tunableParams')), Head_scale: 100 };
    if (!r.master) { r.master = await three(await lab.call('masterForPoints')); writeJson(OUT, raw); }
    for (const { no, method } of key.filter((x) => fullId[x.id] === id)) {
      if (r[method] && truth[no]) continue;
      await lab.call('loadProject', projectInput(id));
      const dir = labPath(`results/${method}/${p8}`);
      const vm = method === 'start' ? start : JSON.parse(fs.readFileSync(`${dir}/trace.json`, 'utf8')).finalVm;
      if (method !== 'start' && fs.existsSync(`${dir}/textures.json`)) await lab.call('restoreTextures', JSON.parse(fs.readFileSync(`${dir}/textures.json`, 'utf8')));
      if (!r[method]) { r[method] = await three(await lab.call('rivForPoints', vm)); writeJson(OUT, raw); }
      if (!truth[no]) { const t = await lab.call('landmarkTruth', vm); truth[no] = { truth: t.truth, faceWidthPx: t.faceWidthPx }; writeJson('results/metric-check/truth.json', truth); }
      console.log(no, p8, method, r[method].filter(Boolean).length, '/3');
    }
  }
} finally { await lab.close(); }
