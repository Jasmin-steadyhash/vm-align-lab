// 按 trace 的起点冻结取景，渲染最终参数的整图对比（主图 | riv），存 results/agent/<版本>/<项目>/final.png
import fs from 'node:fs';
import { openLab, projectInput, readJson, labPath } from './lab.mjs';
const [version, ...ids] = process.argv.slice(2);
const lab = await openLab();
try {
  for (const id of ids) {
    const t = readJson(`results/agent/${version}/${id.slice(0, 8)}/trace.json`);
    await lab.call('loadProject', projectInput(id));
    await lab.call('loadMaster');
    const texF = labPath(`results/agent/${version}/${id.slice(0, 8)}/textures.json`);
    if (fs.existsSync(texF)) await lab.call('restoreTextures', JSON.parse(fs.readFileSync(texF, 'utf8')));
    await lab.call('freezeFrame', t.startVm);
    fs.writeFileSync(labPath(`results/agent/${version}/${id.slice(0, 8)}/final.png`), Buffer.from(await lab.call('obsPair', t.finalVm, [0, 0, 1, 1]), 'base64'));
  }
} finally { await lab.close(); }
