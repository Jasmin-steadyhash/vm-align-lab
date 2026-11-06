import { openLab, projectInput, readJson } from './lab.mjs';
import { startVmOf } from './start-vm.mjs';
const st = readJson('agent/v4/stages.json');
const lab = await openLab();
try {
  const info = await lab.call('loadProject', projectInput(process.argv[2]));
  await lab.call('loadMaster');
  const vm = { ...startVmOf(info.savedVm, await lab.call('tunableParams')), ...st.fixed };
  await lab.call('freezeFrame', vm);
  for (const s of st.stages) console.log(s.id, JSON.stringify(await lab.call('stageEffects', vm, s.roles, s.params)));
} finally { await lab.close(); }
