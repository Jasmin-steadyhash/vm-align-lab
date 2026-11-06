import { openLab, projectInput } from './lab.mjs';
import { startVmOf } from './start-vm.mjs';
const lab = await openLab();
try {
  const info = await lab.call('loadProject', projectInput(process.argv[2]));
  const vm = startVmOf(info.savedVm, await lab.call('tunableParams'));
  for (const n of ['Eye_iris_R_X', 'Eye_iris_R_Y']) console.log(n, JSON.stringify(await lab.call('pupilHalves', vm, n, 10)));
  console.log('iris-like props in saved VM:', Object.keys(info.savedVm).filter((k) => /iris|pupil|Eye_/i.test(k)).join(','));
} finally { await lab.close(); }
