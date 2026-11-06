// 标点测评汇总：results/landmark-bench/ 下每份结果一列（landmark-bench.mjs 跑出来的，每个 模型×推理强度×网关 一份），同一批图（主图 3 + riv 20）
//   1) riv 上和代码真值比的误差（÷ 两眼外沿宽）；2) 同图 3 次的重复误差（各度量单次标准差）
import fs from 'node:fs';
import { readJson, labPath } from './lab.mjs';
import { metricsOf, METRIC_LABEL_FACE } from './landmarks.mjs';
const key = readJson('results/human/key.json').filter((k) => !k.dup);
const truth = readJson('results/metric-check/truth.json');
// 列名 = 文件名去掉 .json，如 gpt-6.1-sol-effort-high.agent
const DIR = 'results/landmark-bench';
const M = Object.fromEntries(fs.readdirSync(labPath(DIR)).filter((f) => f.endsWith('.json')).sort()
  .map((f) => [f.slice(0, -5), readJson(`${DIR}/${f}`)]));
const fullId = Object.fromEntries(fs.readFileSync(labPath('data/dev-ids.txt'), 'utf8').trim().split('\n').map((k) => [k.slice(0, 8), k]));
const W = Math.max(...Object.keys(M).map((m) => m.length));
const ok = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const med = (v) => { v = v.filter(Number.isFinite).sort((a, b) => a - b); return v[v.length >> 1]; };
// 有代码真值的点，按类别汇总（真值点名和标点点名相同，见 page/main.js landmarkTruth）
const GROUPS = { 眼睛中心: ['eye_l', 'eye_r'], 眼白开口端点: ['eye_l_outer', 'eye_l_inner', 'eye_l_top', 'eye_l_bottom'], 虹膜中心: ['iris_l_center'], 虹膜左右沿: ['iris_l_left', 'iris_l_right'], 嘴角: ['mouth_l', 'mouth_r'], 下巴: ['chin'] };
console.log('1) riv 上和代码真值的误差（中位，÷ 两眼外沿宽）');
for (const [model, raw] of Object.entries(M)) {
  const row = Object.entries(GROUPS).map(([name, pts]) => {
    const errs = [];
    for (const { no, id, method } of key) {
      const runs = raw[fullId[id]]?.[method]; const t = truth[no]; if (!runs || !t) continue;
      for (const p of runs) if (p) for (const a of pts) if (ok(p[a]) && t.truth[a]) errs.push(Math.hypot(p[a][0] - t.truth[a][0], p[a][1] - t.truth[a][1]) / t.faceWidthPx * 100);
    }
    return `${name} ${med(errs).toFixed(1)}%`;
  });
  console.log('  ', model.padEnd(W), row.join('  '));
}
console.log('2) 同一张图标 3 次的重复误差（各度量单次标准差的中位）');
const spread = (raw) => {
  const acc = {};
  for (const { id, method } of key) for (const src of ['master', method]) {
    const runs = raw[fullId[id]]?.[src]; if (!runs) continue;
    const ms = runs.filter(Boolean).map((p) => metricsOf(p, 'face'));
    for (const k of Object.keys(METRIC_LABEL_FACE)) {
      const v = ms.map((x) => x[k]).filter(Number.isFinite); if (v.length < 3) continue;
      const mean = v.reduce((a, b) => a + b, 0) / 3, sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / 2);
      (acc[k] ??= []).push(['iris_x', 'iris_y'].includes(k) ? sd * 100 : (sd / Math.abs(mean)) * 100);
    }
  }
  return acc;
};
const S = Object.fromEntries(Object.entries(M).map(([m, r]) => [m, spread(r)]));
// 每列一个 模型×推理强度×网关，列号对应下面的图例；某列缺这项度量记 -
const names = Object.keys(M);
names.forEach((m, i) => console.log(`   [${i + 1}] ${m}`));
console.log('  ', ''.padEnd(16), names.map((_, i) => `[${i + 1}]`.padStart(7)).join(''));
for (const k of Object.keys(METRIC_LABEL_FACE)) {
  if (!names.some((m) => S[m][k])) continue;
  console.log('  ', METRIC_LABEL_FACE[k].slice(0, 16).padEnd(16), names.map((m) => (S[m][k] ? `${med(S[m][k]).toFixed(1)}%` : '-').padStart(7)).join(''));
}
