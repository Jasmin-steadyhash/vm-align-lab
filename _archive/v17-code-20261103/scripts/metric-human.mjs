// 第 3 轮：度量 vs 人工标注。20 组（去重复），每个评审项若干口径：riv 与主图的相对差距能否区分人工判定
//   AUC(不过) = 区分「人工 pass」与「partial/fail」；AUC(明显) = 区分「人工 fail」与其余。0.5 = 无关
import { readJson, writeJson } from './lab.mjs';
const H = readJson('results/human/labels.json');
const key = readJson('results/human/key.json').filter((k) => !k.dup);
const raw = readJson(process.env.RAW || 'results/metric-check/raw.json');  // RAW=…raw-gpt-6.1-sol.json 换定点模型对比
const irisCode = readJson('results/metric-check/iris-code.json');
const fullId = Object.fromEntries(Object.keys(raw).map((k) => [k.slice(0, 8), k]));
const ok = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const med = (v) => { v = v.filter(Number.isFinite).sort((a, b) => a - b); return v[v.length >> 1]; };
const mp = (l) => { const o = {}; for (const k of new Set(l.filter(Boolean).flatMap(Object.keys))) { const ps = l.map((x) => x?.[k]).filter(ok); if (ps.length) o[k] = [med(ps.map((p) => p[0])), med(ps.map((p) => p[1]))]; } return o; };
function base(p) {
  const v = {}, g = (k) => (ok(p[k]) ? p[k] : null);
  const mid = (a, b) => (g(a) && g(b) ? [(p[a][0] + p[b][0]) / 2, (p[a][1] + p[b][1]) / 2] : null);
  const eye = mid('eye_l', 'eye_r'), brow = mid('brow_l', 'brow_r'), mouth = mid('mouth_l', 'mouth_r'), sh = mid('shoulder_l', 'shoulder_r');
  if (g('nose') && g('chin')) v.U = p.chin[1] - p.nose[1];
  if (g('cheek_l') && g('cheek_r')) v.FW = p.cheek_r[0] - p.cheek_l[0];
  if (brow && g('chin')) v.FL = p.chin[1] - brow[1];
  if (v.FW && v.FL) v.G = Math.sqrt(v.FW * v.FL);
  if (g('eye_l') && g('eye_r')) v.eyeDx = p.eye_r[0] - p.eye_l[0];
  if (g('shoulder_l') && g('shoulder_r')) v.SW = p.shoulder_r[0] - p.shoulder_l[0];
  if (eye && brow) v.browEye = eye[1] - brow[1];
  if (g('eye_l_top') && brow) v.browLid = p.eye_l_top[1] - brow[1];
  if (g('eye_l_outer') && g('eye_l_inner')) v.eyeW = Math.abs(p.eye_l_inner[0] - p.eye_l_outer[0]);
  if (g('eye_l_top') && g('eye_l_bottom')) v.eyeH = p.eye_l_bottom[1] - p.eye_l_top[1];
  if (g('iris_l_left') && g('iris_l_right') && v.eyeW) v.irisR = (p.iris_l_right[0] - p.iris_l_left[0]) / v.eyeW;
  if (g('iris_l_center') && g('eye_l') && v.eyeW && v.eyeH) { v.irisX = (p.iris_l_center[0] - p.eye_l[0]) / v.eyeW; v.irisY = (p.iris_l_center[1] - p.eye_l[1]) / v.eyeH; }
  if (eye && g('bang_center')) v.bangs = eye[1] - p.bang_center[1];
  if (g('head_top') && g('chin')) v.headH = p.chin[1] - p.head_top[1];
  // 身体中线偏移：两肩中点和鼻子的水平差（÷ 脸宽 / 两眼距）
  if (sh && g('nose')) v.centerOff = sh[0] - p.nose[0];
  return v;
};
const r = (a, b) => (a != null && b ? a / b : NaN);
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);
const ITEMS = {
  body_ratio: { '肩宽/U': (v) => r(v.SW, v.U), '肩宽/脸宽': (v) => r(v.SW, v.FW), '肩宽/脸长': (v) => r(v.SW, v.FL), '肩宽/合用': (v) => r(v.SW, v.G), '肩宽/两眼距': (v) => r(v.SW, v.eyeDx) },
  face_width: { '脸宽/脸长': (v) => r(v.FW, v.FL), '脸宽/肩宽': (v) => r(v.FW, v.SW), '脸宽/U': (v) => r(v.FW, v.U) },
  brow_eye: { '眉中-眼中/脸宽': (v) => r(v.browEye, v.FW), '眉中-眼中/合用': (v) => r(v.browEye, v.G), '眉-上眼睑/脸宽': (v) => r(v.browLid, v.FW), '眉-上眼睑/合用': (v) => r(v.browLid, v.G), '眉-上眼睑/眼高': (v) => r(v.browLid, v.eyeH) },
  eye_size: { '眼宽高/U': (v) => [r(v.eyeW, v.U), r(v.eyeH, v.U)], '眼宽高/脸宽': (v) => [r(v.eyeW, v.FW), r(v.eyeH, v.FW)], '眼宽高/合用': (v) => [r(v.eyeW, v.G), r(v.eyeH, v.G)], '眼宽高/两眼距': (v) => [r(v.eyeW, v.eyeDx), r(v.eyeH, v.eyeDx)] },
  iris_size: { '虹膜比(AI)': (v) => v.irisR, '虹膜比(riv 代码)': (v) => v.irisCode },
  iris_position: { '虹膜偏移': (v) => [v.irisX, v.irisY] },
  hair_front: { '刘海-眼/脸长': (v) => r(v.bangs, v.FL), '刘海-眼/合用': (v) => r(v.bangs, v.G), '头高/脸长': (v) => r(v.headH, v.FL) },
  body_center: { '中线偏移/脸宽': (v) => r(v.centerOff, v.FW), '中线偏移/两眼距': (v) => r(v.centerOff, v.eyeDx) },
};
const ABS = new Set(['iris_position', 'body_center']);  // 绝对差（目标可能接近 0）
const gap = (item, a, b) => { const A = [a].flat(), B = [b].flat(); return Math.max(...A.map((x, i) => (ABS.has(item) ? Math.abs(x - B[i]) : rel(x, B[i]))).filter(Number.isFinite)); };
const auc = (bad, good) => { let s = 0, n = 0; for (const b of bad) for (const g of good) { n++; s += b > g ? 1 : b === g ? 0.5 : 0; } return n ? s / n : NaN; };
const report = {};
for (const [item, defs] of Object.entries(ITEMS)) {
  report[item] = {};
  for (const [name, f] of Object.entries(defs)) {
    const rows = [];
    for (const { no, id: p8, method } of key) {
      const id = fullId[p8];
      const mv = base(mp(raw[id].master)), rv = base(mp(raw[id][method]));
      rv.irisCode = irisCode[id]?.[method]?.iris_ratio; mv.irisCode = mv.irisR;  // 主图侧只有 AI 定点
      const g = gap(item, f(rv), f(mv));
      if (Number.isFinite(g)) rows.push({ g, h: H[no][item] });
    }
    const pick = (fn) => rows.filter(fn).map((x) => x.g);
    report[item][name] = { n: rows.length, notPass: +auc(pick((x) => x.h !== 'pass'), pick((x) => x.h === 'pass')).toFixed(2), fail: +auc(pick((x) => x.h === 'fail'), pick((x) => x.h !== 'fail')).toFixed(2) };
  }
}
writeJson('results/metric-check/metric-human.json', report);
for (const [item, d] of Object.entries(report)) {
  const cnt = ['pass', 'partial', 'fail'].map((v) => key.filter((k) => H[k.no][item] === v).length).join('/');
  console.log(`${item}（人工 ✓/~/✗ ${cnt}）`);
  for (const [n, x] of Object.entries(d)) console.log(`   ${n.padEnd(18)} AUC(不过) ${String(x.notPass).padEnd(5)} AUC(明显) ${x.fail}`);
}
