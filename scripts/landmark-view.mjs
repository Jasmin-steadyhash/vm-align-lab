// 标点查看页：把代码真值点和模型标的点画到图上，人工看对不对。不调模型，0 花费。
//   riv 20 组（人工标注那批）：绿色 = 代码真值（7 个点），彩色 = 所选结果 3 次标点，连线 = 同一个点模型和真值的偏差
//   主图 3 张：没有真值，只画所选结果 3 次标的全部点
// 模型的点只来自 results/landmark-bench/*.json（landmark-bench.mjs 跑的）；results/metric-check/raw.json 是别的脚本用的旧标点，不读
// 用法：node scripts/landmark-view.mjs   →  http://localhost:5260/landmarks/index.html（node scripts/human-server.mjs）
// 新跑了标点结果，重跑本脚本即可（图片已存在就不重新渲染）
import fs from 'node:fs';
import { openLab, projectInput, readJson, writeJson, labPath } from './lab.mjs';
import { startVmOf } from './start-vm.mjs';
import { POINTS_WHITE } from './landmarks.mjs';

const OUT = 'results/human/landmarks';
fs.mkdirSync(labPath(OUT), { recursive: true });
const key = readJson('results/human/key.json').filter((k) => !k.dup);
const fullId = Object.fromEntries(fs.readFileSync(labPath('data/dev-ids.txt'), 'utf8').trim().split('\n').map((k) => [k.slice(0, 8), k]));
const truth = readJson('results/metric-check/truth.json');

// 结果来源：名字 → { 项目 id: { master: [3 次], <method>: [3 次] } }
const BENCH = 'results/landmark-bench';
const sources = Object.fromEntries((fs.existsSync(labPath(BENCH)) ? fs.readdirSync(labPath(BENCH)) : []).filter((f) => f.endsWith('.json')).sort()
  .map((f) => [f.slice(0, -5), readJson(`${BENCH}/${f}`)]));
const pointsOf = (id, src) => Object.fromEntries(Object.entries(sources).map(([name, raw]) => [name, raw[id]?.[src] ?? null]).filter(([, v]) => v));

const saveB64 = (file, b64) => fs.writeFileSync(labPath(`${OUT}/${file}`), Buffer.from(b64, 'base64'));
const sizeOf = (file) => { const b = fs.readFileSync(labPath(`${OUT}/${file}`)); return { W: b.readUInt32BE(16), H: b.readUInt32BE(20) }; };

// pointDefs：页面右侧的点含义说明，直接取标点用的定义，不另写一份
const data = { sources: Object.keys(sources), pointDefs: POINTS_WHITE, masters: [], cases: [] };
const lab = await openLab();
try {
  for (const p8 of [...new Set(key.map((k) => k.id))]) {
    const id = fullId[p8];
    const info = await lab.call('loadProject', projectInput(id));
    await lab.call('loadMaster');
    const start = { ...startVmOf(info.savedVm, await lab.call('tunableParams')), Head_scale: 100 };
    const mFile = `${p8}-master.png`;
    if (!fs.existsSync(labPath(`${OUT}/${mFile}`))) saveB64(mFile, (await lab.call('masterForPoints')).png);
    data.masters.push({ p8, img: mFile, ...sizeOf(mFile), points: pointsOf(id, 'master') });

    for (const { no, method } of key.filter((k) => k.id === p8)) {
      const file = `riv-${no}.png`;
      if (!fs.existsSync(labPath(`${OUT}/${file}`))) {
        await lab.call('loadProject', projectInput(id));
        const dir = labPath(`results/${method}/${p8}`);
        const vm = method === 'start' ? start : JSON.parse(fs.readFileSync(`${dir}/trace.json`, 'utf8')).finalVm;
        if (method !== 'start' && fs.existsSync(`${dir}/textures.json`)) await lab.call('restoreTextures', JSON.parse(fs.readFileSync(`${dir}/textures.json`, 'utf8')));
        saveB64(file, (await lab.call('rivForPoints', vm)).png);
      }
      data.cases.push({ no, p8, method, img: file, ...sizeOf(file), truth: truth[no]?.truth ?? null, faceWidthPx: truth[no]?.faceWidthPx ?? null, points: pointsOf(id, method) });
      console.log(no, p8, method);
    }
  }
} finally { await lab.close(); }
writeJson(`${OUT}/data.json`, data);
fs.copyFileSync(labPath('scripts/landmark-view.html'), labPath(`${OUT}/index.html`));
console.log(`${data.cases.length} 组 riv、${data.masters.length} 张主图、${data.sources.length} 份结果 → http://localhost:5260/landmarks/index.html`);
