// 定点模型对比汇总：astra（raw.json）vs sol（raw-gpt_6.1_sol.json），同一批图（主图 3 + riv 20）
//   1) riv 上和代码真值比的误差（÷ 两眼外沿宽）；2) 同图 3 次的重复误差（各度量单次标准差）
import { readJson } from './lab.mjs';
import { metricsOf, METRIC_LABEL_FACE } from './landmarks.mjs';
const key = readJson('results/human/key.json').filter((k) => !k.dup);
const truth = readJson('results/metric-check/truth.json');
const M = { 'gpt-6-astra': readJson('results/metric-check/raw.json'), 'gpt-6.1-sol': readJson('results/metric-check/raw-gpt_6.1_sol.json') };
const fullId = Object.fromEntries(Object.keys(M['gpt-6-astra']).map((k) => [k.slice(0, 8), k]));
const ok = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const med = (v) => { v = v.filter(Number.isFinite).sort((a, b) => a - b); return v[v.length >> 1]; };
const PAIRS = { 眼睛中心: [['eye_l', 'left_eye_center'], ['eye_r', 'right_eye_center']], 虹膜中心: [['iris_l_center', 'left_iris_center']], 嘴角: [['mouth_l', 'mouth_left_corner'], ['mouth_r', 'mouth_right_corner']], 下巴: [['chin', 'chin']] };
console.log('1) riv 上和代码真值的误差（中位，÷ 两眼外沿宽）');
for (const [model, raw] of Object.entries(M)) {
  const row = Object.entries(PAIRS).map(([name, prs]) => {
    const errs = [];
    for (const { no, id, method } of key) {
      const runs = raw[fullId[id]]?.[method]; const t = truth[no]; if (!runs || !t) continue;
      for (const p of runs) if (p) for (const [a, b] of prs) if (ok(p[a]) && t.truth[b]) errs.push(Math.hypot(p[a][0] - t.truth[b][0], p[a][1] - t.truth[b][1]) / t.faceWidthPx * 100);
    }
    return `${name} ${med(errs).toFixed(1)}%`;
  });
  console.log('  ', model.padEnd(12), row.join('  '));
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
for (const k of Object.keys(METRIC_LABEL_FACE)) if (S['gpt-6-astra'][k] && S['gpt-6.1-sol'][k]) console.log('  ', METRIC_LABEL_FACE[k].slice(0, 16).padEnd(16), 'astra', med(S['gpt-6-astra'][k]).toFixed(1).padStart(5) + '%', '  sol', med(S['gpt-6.1-sol'][k]).toFixed(1).padStart(5) + '%');
