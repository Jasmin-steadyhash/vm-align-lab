// 存每个项目当前保存 VM 的打分截图，和主图一起看
import fs from 'node:fs';
import { openLab, projectInput, readJson, labPath } from './lab.mjs';
const ids = process.argv.slice(2);
const lab = await openLab();
fs.mkdirSync(labPath('results/snap'), { recursive: true });
try {
  for (const id of ids) {
    const info = await lab.call('loadProject', projectInput(id));
    fs.writeFileSync(labPath(`results/snap/${id.slice(0, 8)}.png`), Buffer.from(await lab.call('scoreCapture', info.savedVm), 'base64'));
  }
} finally { await lab.close(); }
