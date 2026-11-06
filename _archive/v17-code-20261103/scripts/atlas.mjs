// 参数说明表：results/param-atlas.json（每个项目一份，用来确认不同项目结论一致）
import { openLab, projectInput, writeJson } from './lab.mjs';
import { startVmOf } from './start-vm.mjs';
const lab = await openLab();
try {
  const all = {};
  for (const id of process.argv.slice(2)) {
    const info = await lab.call('loadProject', projectInput(id));
    const specs = await lab.call('tunableParams');
    const vm = { ...startVmOf(info.savedVm, specs), Head_scale: 100 };
    const t0 = Date.now();
    all[id] = await lab.call('paramAtlas', vm, specs.map((p) => p.name));
    console.log(id.slice(0, 8), Object.keys(all[id]).length, 'params with effect', Math.round((Date.now() - t0) / 1000), 's');
    writeJson('results/param-atlas.json', all);
  }
} finally { await lab.close(); }
