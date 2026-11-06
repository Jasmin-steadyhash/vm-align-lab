import { openLab, projectInput } from './lab.mjs';
import { startVmOf } from './start-vm.mjs';
const lab = await openLab();
try {
  for (const id of process.argv.slice(2)) {
    const info = await lab.call('loadProject', projectInput(id));
    const vm = startVmOf(info.savedVm, await lab.call('tunableParams'));
    for (const role of (process.env.ROLES || 'sclera,pupil,mouth_up').split(',')) {
      console.log(id.slice(0, 8), role, 'Mouth_Y', vm.Mouth_Y, '→', vm.Mouth_Y + 14, JSON.stringify(await lab.call('isolatedDiff', role, vm, { ...vm, Mouth_Y: vm.Mouth_Y + 14 })));
    }
  }
} finally { await lab.close(); }
