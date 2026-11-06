// 离线重算挑选规则：用已有运行记录的候选度量（poolLog.rows[].metrics），按新规则重新挑，比较能否避开缺陷、两次是否一致
// 新规则：只用该组件自己阶段的可靠度量；先比「最差一项的相对误差」，好出 MARGIN（默认 3.5%）才换；否则留原贴图
import fs from 'node:fs';
import { labPath } from './lab.mjs';
import { STAGE_METRICS_FACE, UNRELIABLE } from './landmarks.mjs';
// 两步：① 淘汰明显缺陷——最差一项比所有候选里最好的「最差一项」高出 GAP 以上（原贴图也会被淘汰）；
//       ② 剩下的按平均误差择优，原贴图还在时要好出 MARGIN 才换
const GAP = Number(process.env.GAP || 0.10), MARGIN = Number(process.env.MARGIN || 0.02);
const STAGE = { head: 'face', sclera: 'eye', pupil: 'iris', mouth: 'mouth' };
const pick = (t, log) => {
  const ks = (STAGE_METRICS_FACE[STAGE[log.component]] ?? []).filter((k) => !UNRELIABLE.has(k) && k in t.target);
  const err = (r) => ks.map((k) => (Number.isFinite(r.metrics[k]) ? Math.abs(r.metrics[k] - t.target[k]) / Math.max(0.1, Math.abs(t.target[k])) : 1));
  const rows = log.rows.map((r) => { const e = err(r); return { name: r.name, worst: Math.max(...e), mean: e.reduce((a, b) => a + b, 0) / e.length, out: r.rough > 0.4 }; });
  const orig = rows[0];
  const bestWorst = Math.min(...rows.filter((r) => !r.out).map((r) => r.worst));
  const ok = rows.filter((r) => !r.out && r.worst <= bestWorst + GAP);
  let best = ok.reduce((a, b) => (b.mean < a.mean ? b : a));
  // 换的门槛：按组件实测「同一候选两次运行平均误差之差」的 90 分位（2026-11-01 由 v12–v14 记录测得）
  const margin = process.env.MARGIN ? MARGIN : { head: 0.06, sclera: 0.094, pupil: 0.194, mouth: 0.129 }[log.component];
  if (ok.includes(orig) && best !== orig && best.mean > orig.mean - margin) best = orig;
  return { picked: best.name, rows, origOut: !ok.includes(orig) };
};
for (const p8 of ['9ee088da', '41e01792', '1cf5ecc9']) for (const [a, b] of [['v12', 'v12b'], ['v13', 'v13b'], ['v14', 'v14b']]) {
  const res = [a, b].map((v) => { const f = labPath(`results/agent/${v}/${p8}/trace.json`); if (!fs.existsSync(f)) return null; const t = JSON.parse(fs.readFileSync(f, 'utf8')); return Object.fromEntries((t.poolLog ?? []).map((l) => [l.component, { old: l.picked, ...pick(t, l) }])); });
  if (!res[0] || !res[1]) continue;
  const comps = Object.keys(res[0]);
  const same = (k) => comps.filter((c) => res[0][c][k] === res[1][c][k]).length;
  console.log(`${p8} ${(a + '/' + b).padEnd(9)} 原规则一致 ${same('old')}/4  新规则一致 ${same('picked')}/4 | 新规则选：${comps.map((c) => `${c}:${res[0][c].picked.replace(/^\w+-/, '')}${res[0][c].picked === res[1][c].picked ? '' : '≠' + res[1][c].picked.replace(/^\w+-/, '')}`).join(' ')}`);
  if (p8 === '1cf5ecc9') for (const [i, v] of [a, b].entries()) { const h = res[i].head; console.log(`      ${v} 头部：${h.rows.map((r) => `${r.name.replace(/^head-/, 'h')} 最差 ${(r.worst * 100).toFixed(0)}% 平均 ${(r.mean * 100).toFixed(0)}%`).join('；')} → ${h.picked}${h.origOut ? '（原贴图被淘汰）' : ''}`); }
}
