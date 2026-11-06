import { openLab, projectInput, readJson, writeJson } from './lab.mjs';
const id = readJson('data/selection.json').dev[0];
const lab = await openLab();
lab.page.on('response', (r) => { if (r.status() >= 400) console.log(r.status(), r.url().slice(0, 120)); });
try {
  const info = await lab.call('loadProject', projectInput(id));
  const res = await lab.call('runA', info.savedVm);
  console.log('ms', res.ms, 'unsolved', JSON.stringify(res.unsolved), 'notes', res.notes, 'clamped', JSON.stringify(res.clamped));
  console.log(res.rows.map((r) => `${r.metric}:${r.errPx == null ? '-' : r.errPx.toFixed(1)}`).join(' '));
  writeJson(`results/a-smoke-${id.slice(0, 8)}.json`, res);
} finally { await lab.close(); }
