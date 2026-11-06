// 第 10 条：度量 vs 评审逐项一致性。每项给几种口径（不同尺子），算 riv 与主图的相对差距，
// 看差距能否区分评审 pass 与 partial/fail：AUC = 随机取一对（不合格, 合格），不合格那张差距更大的概率（0.5 = 无关）
import { readJson, writeJson } from './lab.mjs';

const raw = readJson('results/metric-check/raw.json');
const judged = readJson('results/judge/devcmp/summary.json');
const ok = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const med = (v) => { v = v.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : NaN; };
// 3 次定点逐点取中位数
const medPts = (list) => {
  const out = {};
  for (const k of new Set(list.filter(Boolean).flatMap(Object.keys))) {
    const ps = list.map((l) => l?.[k]).filter(ok);
    if (ps.length) out[k] = [med(ps.map((p) => p[0])), med(ps.map((p) => p[1]))];
  }
  return out;
};
// 基础量（像素）
function base(p) {
  const g = (k) => (ok(p[k]) ? p[k] : null);
  const v = {};
  const mid = (a, b) => (g(a) && g(b) ? [(p[a][0] + p[b][0]) / 2, (p[a][1] + p[b][1]) / 2] : null);
  const eye = mid('eye_l', 'eye_r'), brow = mid('brow_l', 'brow_r'), mouth = mid('mouth_l', 'mouth_r'), sh = mid('shoulder_l', 'shoulder_r');
  if (g('nose') && g('chin')) v.U = p.chin[1] - p.nose[1];
  if (g('cheek_l') && g('cheek_r')) v.FW = p.cheek_r[0] - p.cheek_l[0];
  if (brow && g('chin')) v.FL = p.chin[1] - brow[1];
  if (eye && g('chin')) v.EC = p.chin[1] - eye[1];
  if (g('eye_l') && g('eye_r')) v.eyeDx = p.eye_r[0] - p.eye_l[0];
  if (g('shoulder_l') && g('shoulder_r')) v.SW = p.shoulder_r[0] - p.shoulder_l[0];
  if (sh && g('chin')) v.neck = sh[1] - p.chin[1];
  if (eye && brow) v.browEye = eye[1] - brow[1];
  if (g('eye_l_outer') && g('eye_l_inner')) v.eyeW = Math.abs(p.eye_l_inner[0] - p.eye_l_outer[0]);
  if (g('eye_l_top') && g('eye_l_bottom')) v.eyeH = p.eye_l_bottom[1] - p.eye_l_top[1];
  if (g('iris_l_left') && g('iris_l_right')) v.irisW = p.iris_l_right[0] - p.iris_l_left[0];
  if (g('iris_l_center') && g('eye_l')) { v.irisDx = p.iris_l_center[0] - p.eye_l[0]; v.irisDy = p.iris_l_center[1] - p.eye_l[1]; }
  if (mouth && g('nose')) v.noseMouth = mouth[1] - p.nose[1];
  if (mouth && g('chin')) v.mouthChin = p.chin[1] - mouth[1];
  if (g('mouth_l') && g('mouth_r')) v.mouthW = p.mouth_r[0] - p.mouth_l[0];
  if (eye && g('bang_center')) v.bangs = eye[1] - p.bang_center[1];
  if (g('head_top') && g('chin')) v.headH = p.chin[1] - p.head_top[1];
  return v;
}
const r = (a, b) => (a != null && b != null && b !== 0 ? a / b : NaN);
// 每个评审项：口径名 → 比值；多值口径取各分量差距的最大值
const ITEMS = {
  body_ratio: { 'SW/U(现)': (v) => [r(v.SW, v.U)], 'SW/FW': (v) => [r(v.SW, v.FW)] },
  neck: { 'neck/U(现)': (v) => [r(v.neck, v.U)], 'neck/FL': (v) => [r(v.neck, v.FL)] },
  face_width: { 'FW/U(现)': (v) => [r(v.FW, v.U)], 'FW/SW': (v) => [r(v.FW, v.SW)], 'FW/FL': (v) => [r(v.FW, v.FL)] },
  face_length: { 'FL/FW': (v) => [r(v.FL, v.FW)], 'U/FL': (v) => [r(v.U, v.FL)] },
  hair_front: { 'bangs/U(现)': (v) => [r(v.bangs, v.U)], 'bangs/browEye': (v) => [r(v.bangs, v.browEye)], 'bangs/FW': (v) => [r(v.bangs, v.FW)] },
  hair_outline: { 'headH/U(现)': (v) => [r(v.headH, v.U)], 'headH/FL': (v) => [r(v.headH, v.FL)] },
  brow_eye: { 'browEye/U(现)': (v) => [r(v.browEye, v.U)], 'browEye/FW': (v) => [r(v.browEye, v.FW)] },
  eye_spacing: { 'eyeDx/U(现)': (v) => [r(v.eyeDx, v.U)], 'eyeDx/FW': (v) => [r(v.eyeDx, v.FW)] },
  eye_size: { 'eyeWH/U(现)': (v) => [r(v.eyeW, v.U), r(v.eyeH, v.U)], 'eyeWH/FW': (v) => [r(v.eyeW, v.FW), r(v.eyeH, v.FW)] },
  iris_size: { 'irisW/eyeW(现)': (v) => [r(v.irisW, v.eyeW)] },
  iris_position: { 'iris/eye(现)': (v) => [r(v.irisDx, v.eyeW), r(v.irisDy, v.eyeH)] },
  nose_mouth: { 'noseMouth/U(现)': (v) => [r(v.noseMouth, v.U)], 'noseMouth/FL': (v) => [r(v.noseMouth, v.FL)] },
  mouth_chin: { 'mouthChin/U': (v) => [r(v.mouthChin, v.U)], 'mouthChin/FL': (v) => [r(v.mouthChin, v.FL)] },
  mouth_width: { 'mouthW/U(现)': (v) => [r(v.mouthW, v.U)], 'mouthW/FW': (v) => [r(v.mouthW, v.FW)] },
};
// 差距：比值类按相对差；位置类（iris_position）按绝对差
const gapOf = (item, a, b) => Math.max(...a.map((x, i) => (item === 'iris_position' ? Math.abs(x - b[i]) : Math.abs(x - b[i]) / Math.abs(b[i]))).filter(Number.isFinite));

const rows = [];
for (const [id, methods] of Object.entries(raw)) {
  const mv = base(medPts(methods.master));
  for (const [method, pts] of Object.entries(methods)) {
    if (method === 'master' || !judged[id]?.[method]) continue;
    const rv = base(medPts(pts));
    for (const [item, defs] of Object.entries(ITEMS)) {
      const verdict = judged[id][method].majority[item];
      const gaps = Object.fromEntries(Object.entries(defs).map(([n, f]) => [n, gapOf(item, f(rv), f(mv))]));
      rows.push({ id: id.slice(0, 8), method, item, verdict, gaps });
    }
  }
}
const auc = (bad, good) => { let s = 0, n = 0; for (const b of bad) for (const g of good) { n++; s += b > g ? 1 : b === g ? 0.5 : 0; } return n ? s / n : NaN; };
const report = {};
for (const [item, defs] of Object.entries(ITEMS)) {
  const rs = rows.filter((x) => x.item === item);
  const cnt = { pass: rs.filter((x) => x.verdict === 'pass').length, partial: rs.filter((x) => x.verdict === 'partial').length, fail: rs.filter((x) => x.verdict === 'fail').length };
  report[item] = { cnt, defs: {} };
  for (const n of Object.keys(defs)) {
    const g = (v) => rs.filter((x) => v.includes(x.verdict)).map((x) => x.gaps[n]).filter(Number.isFinite);
    const mean = (a) => (a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(3) : null);
    report[item].defs[n] = { auc: +auc(g(['partial', 'fail']), g(['pass'])).toFixed(2), passGap: mean(g(['pass'])), partialGap: mean(g(['partial'])), failGap: mean(g(['fail'])) };
  }
}
writeJson('results/metric-check/agree.json', { report, rows });
for (const [item, { cnt, defs }] of Object.entries(report)) {
  console.log(`${item}  (pass ${cnt.pass} / partial ${cnt.partial} / fail ${cnt.fail})`);
  for (const [n, d] of Object.entries(defs)) console.log(`   ${n.padEnd(18)} AUC ${d.auc}  差距 pass ${d.passGap} partial ${d.partialGap} fail ${d.failGap}`);
}
