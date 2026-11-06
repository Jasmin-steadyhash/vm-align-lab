// 穿帮守卫的读数：起点、v4、v5 最终参数各量一次，看能不能区分出评审说的穿帮
import fs from 'node:fs';
import { openLab, projectInput, readJson, labPath } from './lab.mjs';
const ids = fs.readFileSync(labPath('data/dev-ids.txt'), 'utf8').trim().split('\n');
const lab = await openLab();
try {
  for (const id of ids) {
    await lab.call('loadProject', projectInput(id));
    for (const v of ['v4', 'v5']) {
      const t = readJson(`results/agent/${v}/${id.slice(0, 8)}/trace.json`);
      if (v === 'v4') console.log(id.slice(0, 8), 'start', JSON.stringify(await lab.call('glitchMetrics', t.startVm)));
      console.log(id.slice(0, 8), v, JSON.stringify(await lab.call('glitchMetrics', t.finalVm)));
    }
  }
} finally { await lab.close(); }
