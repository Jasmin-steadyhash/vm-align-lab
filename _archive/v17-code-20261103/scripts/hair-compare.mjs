// 前发 scale 改成和后发一致的效果：主图 | 最终版本 | 前发 = 后发 scale，头肩区域；存 results/human/hair/NN.png
import fs from 'node:fs';
import { openLab, projectInput, readJson, labPath } from './lab.mjs';
const key = readJson('results/human/key.json');
const fullId = Object.fromEntries(Object.keys(readJson('results/metric-check/raw.json')).map((k) => [k.slice(0, 8), k]));
const lab = await openLab();
try {
  for (const no of process.argv.slice(2)) {
    const { id: p8, method } = key.find((k) => k.no === no);
    await lab.call('loadProject', projectInput(fullId[p8])); await lab.call('loadMaster');
    const t = JSON.parse(fs.readFileSync(labPath(`results/${method}/${p8}/trace.json`), 'utf8'));
    const dir = labPath(`results/${method}/${p8}`);
    if (fs.existsSync(`${dir}/textures.json`)) await lab.call('restoreTextures', JSON.parse(fs.readFileSync(`${dir}/textures.json`, 'utf8')));
    await lab.call('freezeFrame', t.startVm);
    const vm = t.finalVm, alt = { ...vm, Hair_top_scale: vm.Hair_back_scale };
    const box = (await lab.call('partBoxes', vm)).headShoulder ?? [0, 0, 1, 0.6];
    fs.writeFileSync(labPath(`results/human/hair/${no}.png`), Buffer.from(await lab.call('obsCandidates', [vm, alt], box, 480), 'base64'));
    console.log(no, p8, method, `前发 ${vm.Hair_top_scale} → ${alt.Hair_top_scale}`);
  }
} finally { await lab.close(); }
