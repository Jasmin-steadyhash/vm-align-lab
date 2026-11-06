import { openLab, projectInput, writeJson } from './lab.mjs';
import { startVmOf } from './start-vm.mjs';
const ids = process.argv.slice(2);
const lab = await openLab();
try {
  const all = {};
  for (const id of ids) {
    const info = await lab.call('loadProject', projectInput(id));
    const specs = await lab.call('tunableParams');
    all[id] = await lab.call(process.env.ISOLATED ? 'couplingIsolated' : 'couplingMap', startVmOf(info.savedVm, specs), specs);
    console.log(id.slice(0, 8), 'parts', all[id].parts.join(','));
  }
  writeJson(process.env.ISOLATED ? 'results/coupling-isolated.json' : 'results/coupling.json', all);
} finally { await lab.close(); }
