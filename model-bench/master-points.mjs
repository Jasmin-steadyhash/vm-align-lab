import fs from 'node:fs';
import { openLab, projectInput, labPath } from '../scripts/lab.mjs';
import { startVmOf } from '../scripts/start-vm.mjs';
import { locate, aggregate, METRIC_LABEL } from '../scripts/landmarks.mjs';
const model = process.argv[2] || 'gpt-6-astra';
const ids = fs.readFileSync(labPath('data/dev-ids.txt'), 'utf8').trim().split('\n');
const lab = await openLab();
const out = {};
try {
  for (const id of ids) {
    const info = await lab.call('loadProject', projectInput(id));
    const m = await lab.call('masterForPoints');
    const r = await lab.call('rivForPoints', { ...startVmOf(info.savedVm, await lab.call('tunableParams')), Head_scale: 100 });
    const [mp, rp] = [await Promise.all([1, 2, 3].map(() => locate(model, m))), await Promise.all([1, 2, 3].map(() => locate(model, r)))];
    out[id] = { master: aggregate(mp), riv: aggregate(rp) };
    console.log(id.slice(0, 8));
    for (const k of Object.keys(METRIC_LABEL)) { const a = out[id].master[k], b = out[id].riv[k]; console.log('  ', k.padEnd(11), a ? `主图 ${a.value.toFixed(3)}±${a.spread.toFixed(3)}` : '主图 -', '|', b ? `riv ${b.value.toFixed(3)}±${b.spread.toFixed(3)}` : 'riv -'); }
  }
} finally { await lab.close(); }
fs.writeFileSync(labPath(`model-bench/master-points-${model}.json`), JSON.stringify(out, null, 2));
