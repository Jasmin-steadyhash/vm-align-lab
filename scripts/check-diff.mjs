import { openLab, projectInput, readJson } from './lab.mjs';
const sel = readJson('data/selection.json');
const lab = await openLab();
lab.page.on('response', (r) => { if (r.status() === 404) console.log('404', r.url()); });
try {
  for (const id of sel.dev.concat(sel.test.slice(0, 2))) {
    const info = await lab.call('loadProject', projectInput(id));
    console.log(id.slice(0, 8), JSON.stringify(await lab.call('renderDiff', info.savedVm, { n: 4 })));
  }
} finally { await lab.close(); }
