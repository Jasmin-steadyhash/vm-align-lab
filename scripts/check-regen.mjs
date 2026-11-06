import fs from 'node:fs';
import { openLab, projectInput, labPath } from './lab.mjs';
const [id, role] = process.argv.slice(2);
const lab = await openLab();
try {
  const info = await lab.call('loadProject', projectInput(id));
  const r = await lab.call('regenerate', role);
  console.log(role, JSON.stringify(r).slice(0, 300));
  if (r.ok) fs.writeFileSync(labPath(`results/regen-${id.slice(0, 8)}-${role}.png`), Buffer.from(await lab.call('render', info.savedVm, { w: 540, h: 960 }), 'base64'));
} finally { await lab.close(); }
