// v11 前置检查：36 张评审过的 riv 上，代码量的虹膜比例 vs AI 定点量的，及与评审 iris_size 的一致性
import fs from 'node:fs';
import { openLab, projectInput, readJson, writeJson, labPath } from './lab.mjs';
import { startVmOf } from './start-vm.mjs';
const judged = readJson('results/judge/devcmp/summary.json');
const out = {};
const lab = await openLab();
try {
  for (const id of Object.keys(judged)) {
    const info = await lab.call('loadProject', projectInput(id));
    const start = { ...startVmOf(info.savedVm, await lab.call('tunableParams')), Head_scale: 100 };
    for (const method of Object.keys(judged[id])) {
      const vm = method === 'start' ? start : JSON.parse(fs.readFileSync(labPath(`results/${method}/${id.slice(0, 8)}/trace.json`), 'utf8')).finalVm;
      await lab.call('loadProject', projectInput(id));
      const texF = labPath(`results/${method}/${id.slice(0, 8)}/textures.json`);
      if (method.startsWith('agent/') && fs.existsSync(texF)) await lab.call('restoreTextures', JSON.parse(fs.readFileSync(texF, 'utf8')));
      (out[id] ??= {})[method] = await lab.call('irisCode', vm);
      console.log(id.slice(0, 8), method, JSON.stringify(out[id][method]));
    }
  }
} finally { await lab.close(); }
writeJson('results/metric-check/iris-code.json', out);
