// 执行层验证 1：恢复项目、同一 VM 多次渲染是否逐像素一致、单张渲染耗时
import { openLab, projectInput, readJson } from './lab.mjs';
const sel = readJson('data/selection.json');
const lab = await openLab();
try {
  for (const id of [...sel.dev, ...sel.test]) {
    const t0 = Date.now();
    const info = await lab.call('loadProject', projectInput(id));
    const tLoad = Date.now() - t0;
    const hashes = [];
    const t1 = Date.now();
    for (let i = 0; i < 3; i++) hashes.push((await lab.call('renderHash', info.savedVm)).hash);
    const tRender = (Date.now() - t1) / 3;
    console.log(id.slice(0, 8), 'restored', info.restored.join(','), `load ${tLoad}ms`, `render ${tRender.toFixed(0)}ms`, 'deterministic', new Set(hashes).size === 1);
  }
} finally { await lab.close(); }
