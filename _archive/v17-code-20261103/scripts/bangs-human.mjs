// 前发大小的替代量法：眉、眼、鼻三个高度上「露出的皮肤宽度」÷ 两眼距离，主图 vs riv，和人工 hair_front 对照
import fs from 'node:fs';
import { openLab, projectInput, readJson, writeJson, labPath } from './lab.mjs';
import { startVmOf } from './start-vm.mjs';
const H = readJson('results/human/labels.json');
const key = readJson('results/human/key.json').filter((k) => !k.dup);
const raw = readJson('results/metric-check/raw.json');
const fullId = Object.fromEntries(Object.keys(raw).map((k) => [k.slice(0, 8), k]));
const med = (v) => { v = v.filter(Number.isFinite).sort((a, b) => a - b); return v[v.length >> 1]; };
const P = (L, n, i) => med(L.map((p) => p?.[n]?.[i]));
// 定点 → 扫描参数（坐标系同定点图）
const geo = (L) => {
  const browY = (P(L, 'brow_l', 1) + P(L, 'brow_r', 1)) / 2, eyeY = (P(L, 'eye_l', 1) + P(L, 'eye_r', 1)) / 2, noseY = P(L, 'nose', 1), cx = P(L, 'nose', 0);
  return { cx, ys: [browY, eyeY, (eyeY + noseY) / 2], skinAt: [cx, noseY - (noseY - eyeY) * 0.35], ruler: P(L, 'eye_r', 0) - P(L, 'eye_l', 0) };
};
const out = {};
const lab = await openLab();
try {
  for (const id of new Set(key.map((k) => fullId[k.id]))) {
    const p8 = id.slice(0, 8);
    const info = await lab.call('loadProject', projectInput(id)); await lab.call('loadMaster');
    const start = { ...startVmOf(info.savedVm, await lab.call('tunableParams')), Head_scale: 100 };
    const m = await lab.call('masterForPoints'), dim = await lab.call('masterSize'), k = dim.w / m.W;
    const g = geo(raw[id].master);
    const sp = await lab.call('skinMaster', g.cx * k, g.ys.map((y) => y * k), [g.skinAt[0] * k, g.skinAt[1] * k]);
    out[`master-${p8}`] = sp.map((w) => w / (g.ruler * k));
    for (const { no, method } of key.filter((x) => fullId[x.id] === id)) {
      await lab.call('loadProject', projectInput(id));
      const dir = labPath(`results/${method}/${p8}`);
      const vm = method === 'start' ? start : JSON.parse(fs.readFileSync(`${dir}/trace.json`, 'utf8')).finalVm;
      if (method !== 'start' && fs.existsSync(`${dir}/textures.json`)) await lab.call('restoreTextures', JSON.parse(fs.readFileSync(`${dir}/textures.json`, 'utf8')));
      const rg = geo(raw[id][method]);
      const rs = await lab.call('skinRiv', vm, rg.cx, rg.ys, rg.skinAt, 2);
      out[no] = rs.map((w) => w / (rg.ruler * 2));
      console.log(no, p8, method.padEnd(11), '主图', out[`master-${p8}`].map((x) => x.toFixed(2)).join('/'), ' riv', out[no].map((x) => x.toFixed(2)).join('/'), ' 你判', H[no].hair_front);
    }
  }
} finally { await lab.close(); }
writeJson('results/metric-check/bangs-human.json', out);
const auc = (b, g) => { let s = 0, n = 0; for (const x of b) for (const y of g) { n++; s += x > y ? 1 : x === y ? 0.5 : 0; } return n ? (s / n).toFixed(2) : '-'; };
for (const [name, idx] of [['眉高度', [0]], ['眼高度', [1]], ['眼鼻之间', [2]], ['三处取最大差', [0, 1, 2]]]) {
  const rows = key.map((k) => ({ g: Math.max(...idx.map((i) => Math.abs(out[k.no][i] - out[`master-${k.id}`][i]) / out[`master-${k.id}`][i])), h: H[k.no].hair_front }));
  const pick = (fn) => rows.filter(fn).map((x) => x.g);
  console.log(name.padEnd(8), 'AUC(不过)', auc(pick((x) => x.h !== 'pass'), pick((x) => x.h === 'pass')), ' AUC(明显)', auc(pick((x) => x.h === 'fail'), pick((x) => x.h !== 'fail')));
}
