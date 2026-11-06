import { openLab, projectInput, readJson } from '../scripts/lab.mjs';
import { locate, aggregate, POINTS, POINTS_WHITE } from '../scripts/landmarks.mjs';
const id = '41e01792-7a2c-4ce2-801d-704c1e08f4e7';
const lab = await openLab();
try {
  await lab.call('loadProject', projectInput(id));
  const t = readJson('results/agent/v9/41e01792/trace.json');
  const m = await lab.call('masterForPoints'), r = await lab.call('rivForPoints', t.finalVm);
  for (const [name, defs] of [['眼线口径', POINTS], ['眼白口径', POINTS_WHITE]]) {
    const am = aggregate(await Promise.all([1, 2, 3].map(() => locate('gpt-6-astra', m, defs))));
    const ar = aggregate(await Promise.all([1, 2, 3].map(() => locate('gpt-6-astra', r, defs))));
    console.log(name, ['eye_w', 'eye_h', 'iris_ratio'].map((k) => `${k} 主图 ${am[k]?.value.toFixed(3)} riv ${ar[k]?.value.toFixed(3)}`).join(' | '));
  }
} finally { await lab.close(); }
