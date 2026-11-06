// 补算人工标注 20 组里缺的 riv 侧代码量虹膜比例（results/metric-check/iris-code.json）
import fs from 'node:fs';
import { openLab, projectInput, readJson, writeJson, labPath } from './lab.mjs';
import { startVmOf } from './start-vm.mjs';
const key = readJson('results/human/key.json').filter((k) => !k.dup);
const out = readJson('results/metric-check/iris-code.json');
const fullId = Object.fromEntries(Object.keys(out).map((k) => [k.slice(0, 8), k]));
const lab = await openLab();
try {
  for (const { id: p8, method } of key) {
    const id = fullId[p8];
    if (out[id]?.[method]) continue;
    const info = await lab.call('loadProject', projectInput(id));
    const start = { ...startVmOf(info.savedVm, await lab.call('tunableParams')), Head_scale: 100 };
    const dir = labPath(`results/${method}/${p8}`);
    const vm = method === 'start' ? start : JSON.parse(fs.readFileSync(`${dir}/trace.json`, 'utf8')).finalVm;
    if (method !== 'start' && fs.existsSync(`${dir}/textures.json`)) await lab.call('restoreTextures', JSON.parse(fs.readFileSync(`${dir}/textures.json`, 'utf8')));
    out[id][method] = await lab.call('irisCode', vm);
    console.log(p8, method, out[id][method]?.iris_ratio);
  }
} finally { await lab.close(); }
writeJson('results/metric-check/iris-code.json', out);
