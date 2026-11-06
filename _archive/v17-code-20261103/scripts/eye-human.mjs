// v13 第 1 步验证：新眼睛 / 虹膜量法（主图 AI 粗定位 + 代码找边；riv 图层掩码 + 同一套代码）在人工标注 20 组上的一致性
// 尺子：脸宽、脸长（两侧都用已有的 AI 定点中位数）。结果存 results/metric-check/eye-human.json
import fs from 'node:fs';
import { openLab, projectInput, readJson, writeJson, labPath } from './lab.mjs';
import { startVmOf } from './start-vm.mjs';
const H = readJson('results/human/labels.json');
const key = readJson('results/human/key.json').filter((k) => !k.dup);
const raw = readJson('results/metric-check/raw.json');
const fullId = Object.fromEntries(Object.keys(raw).map((k) => [k.slice(0, 8), k]));
const med = (v) => { v = v.filter(Number.isFinite).sort((a, b) => a - b); return v[v.length >> 1]; };
const P = (L, n, i) => med(L.map((p) => p?.[n]?.[i]));
const rulers = (L, k) => ({ FW: (P(L, 'cheek_r', 0) - P(L, 'cheek_l', 0)) * k, FL: (P(L, 'chin', 1) - (P(L, 'brow_l', 1) + P(L, 'brow_r', 1)) / 2) * k });
const out = fs.existsSync(labPath('results/metric-check/eye-human.json')) ? readJson('results/metric-check/eye-human.json') : { master: {}, riv: {} };
const lab = await openLab();
try {
  for (const id of new Set(key.map((k) => fullId[k.id]))) {
    const p8 = id.slice(0, 8);
    const info = await lab.call('loadProject', projectInput(id)); await lab.call('loadMaster');
    const start = { ...startVmOf(info.savedVm, await lab.call('tunableParams')), Head_scale: 100 };
    if (!out.master[p8]) {
      const m = await lab.call('masterForPoints'), dim = await lab.call('masterSize'), k = dim.w / m.W, L = raw[id].master;
      const xs = [P(L, 'eye_l_outer', 0) * k, P(L, 'eye_l_inner', 0) * k];
      out.master[p8] = { ...(await lab.call('eyeMaster', [Math.min(...xs), P(L, 'eye_l_top', 1) * k, Math.max(...xs), P(L, 'eye_l_bottom', 1) * k])), ...rulers(L, k) };
    }
    for (const { no, method } of key.filter((x) => fullId[x.id] === id)) {
      if (out.riv[no]) continue;
      await lab.call('loadProject', projectInput(id));
      const dir = labPath(`results/${method}/${p8}`);
      const vm = method === 'start' ? start : JSON.parse(fs.readFileSync(`${dir}/trace.json`, 'utf8')).finalVm;
      if (method !== 'start' && fs.existsSync(`${dir}/textures.json`)) await lab.call('restoreTextures', JSON.parse(fs.readFileSync(`${dir}/textures.json`, 'utf8')));
      const e = await lab.call('eyeRiv', vm, 2);
      out.riv[no] = { ...e, ...rulers(raw[id][method], 2) };
      console.log(no, p8, method, e.eyeW, e.eyeH, e.irisW);
    }
  }
} finally { await lab.close(); }
writeJson('results/metric-check/eye-human.json', out);
// 一致性
const auc = (bad, good) => { let s = 0, n = 0; for (const b of bad) for (const g of good) { n++; s += b > g ? 1 : b === g ? 0.5 : 0; } return n ? (s / n).toFixed(2) : '-'; };
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);
const DEFS = {
  eye_size: { '眼宽高/脸宽': (e) => [e.eyeW / e.FW, e.eyeH / e.FW], '眼宽高/脸长': (e) => [e.eyeW / e.FL, e.eyeH / e.FL], '眼宽/脸宽': (e) => [e.eyeW / e.FW], '眼高/脸宽': (e) => [e.eyeH / e.FW] },
  iris_size: { '虹膜宽/眼白宽': (e) => [e.irisW / e.eyeW], '虹膜宽/脸宽': (e) => [e.irisW / e.FW], '虹膜宽/眼高': (e) => [e.irisW / e.eyeH] },
};
for (const [item, defs] of Object.entries(DEFS)) {
  console.log(item, '（人工 ✓/~/✗', ['pass', 'partial', 'fail'].map((v) => key.filter((k) => H[k.no][item] === v).length).join('/'), '）');
  for (const [name, f] of Object.entries(defs)) {
    const rows = key.map((k) => { const m = f(out.master[k.id]), r = f(out.riv[k.no]); return { g: Math.max(...r.map((x, i) => rel(x, m[i]))), h: H[k.no][item] }; }).filter((x) => Number.isFinite(x.g));
    const pick = (fn) => rows.filter(fn).map((x) => x.g);
    console.log('  ', name.padEnd(14), 'AUC(不过)', auc(pick((x) => x.h !== 'pass'), pick((x) => x.h === 'pass')), ' AUC(明显)', auc(pick((x) => x.h === 'fail'), pick((x) => x.h !== 'fail')));
  }
}
