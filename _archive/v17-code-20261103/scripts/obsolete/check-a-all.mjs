import { openLab, projectInput, readJson } from './lab.mjs';
const ids = process.argv.slice(2);
const lab = await openLab();
try {
  for (const id of ids) {
    const info = await lab.call('loadProject', projectInput(id));
    try {
      const res = await lab.call('runA', info.savedVm);
      console.log(id.slice(0, 8), 'ok', res.ms, 'ms unsolved', JSON.stringify(res.unsolved));
    } catch (e) { console.log(id.slice(0, 8), 'FAIL', e.message.split('\n')[0]); }
  }
} finally { await lab.close(); }
