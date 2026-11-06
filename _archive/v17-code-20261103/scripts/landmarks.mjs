// AI 定点 + 代码算比例：主图、riv 各标一组关键点，按同一把尺子（鼻底到下巴 U）算比例，代码给出差多少。
import fs from 'node:fs';
import { labPath } from './lab.mjs';
import { logUsage } from './usage.mjs';

const KEY = fs.readFileSync(labPath('../.dev.vars'), 'utf8').match(/^IMAGE_API_KEY=(.*)$/m)[1].trim();
export const POINTS = {
  head_top: '头发最高点', bang_center: '刘海在脸正中处的下沿',
  brow_l: '画面左侧眉毛的中点', brow_r: '画面右侧眉毛的中点',
  eye_l: '画面左侧眼睛（眼白开口）的中心', eye_r: '画面右侧眼睛（眼白开口）的中心',
  eye_l_outer: '画面左侧眼睛的外眼角（靠脸外侧）', eye_l_inner: '画面左侧眼睛的内眼角（靠鼻子）',
  eye_l_top: '画面左侧眼睛上眼睑在眼睛正中处', eye_l_bottom: '画面左侧眼睛下眼睑在眼睛正中处',
  iris_l_left: '画面左侧眼睛虹膜的最左沿', iris_l_right: '画面左侧眼睛虹膜的最右沿', iris_l_center: '画面左侧眼睛虹膜的中心',
  nose: '鼻底（鼻尖下沿）', mouth_l: '嘴的左嘴角', mouth_r: '嘴的右嘴角', chin: '下巴最低点',
  cheek_l: '鼻底高度处脸的左边缘', cheek_r: '鼻底高度处脸的右边缘',
  shoulder_l: '左肩最外侧的上沿（肩膀和手臂交界）', shoulder_r: '右肩最外侧的上沿',
};
// v10：眼睛的宽高按眼白开口定义（不算眼线、睫毛），和评审「眼睛开口」的口径一致
export const POINTS_WHITE = {
  ...POINTS,
  eye_l_outer: '画面左侧眼睛眼白开口的最左端（只看眼白露出的范围，不算眼线、睫毛、眼影）',
  eye_l_inner: '画面左侧眼睛眼白开口的最右端（只看眼白露出的范围，不算眼线、睫毛、眼影）',
  eye_l_top: '画面左侧眼睛眼白开口在正中处的上沿（上眼睑内缘）',
  eye_l_bottom: '画面左侧眼睛眼白开口在正中处的下沿（下眼睑内缘）',
};
const prompt = (W, H, defs = POINTS) => `这是一张 ${W}×${H} 像素的 2D 角色图。给出下列点的像素坐标（x 向右、y 向下，原点左上角）。"左/右"指画面左右。看不到的点给 null。\n${Object.entries(defs).map(([k, v]) => `- ${k}：${v}`).join('\n')}\n只输出 JSON：{"head_top":[x,y],...}`;

export async function locate(model0, { png, W, H }, defs = POINTS) {
  let model = model0;
  for (let attempt = 1; attempt <= 15; attempt++) {
    const t0 = Date.now();
    const res = await fetch('https://tenantapi.anispark.ai/llm/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt(W, H, defs) }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }] }], response_format: { type: 'json_object' }, max_tokens: 3000 }),
      signal: AbortSignal.timeout(180000),  // 网关偶尔不返回，不设超时会一直挂住
    }).catch((e) => ({ ok: false, status: 0, text: async () => `timeout: ${e.message}` }));
    if (res.status === 429) { await new Promise((o) => setTimeout(o, 20000)); continue; }
    if (res.status === 400 && attempt < 6) { if (attempt === 3) model = model === 'gpt-6-astra' ? 'pe-g/gpt-6-astra' : model; continue; }
    if (!res.ok) { if (attempt >= 3) return null; await new Promise((o) => setTimeout(o, 3000)); continue; }
    const j = await res.json();
    logUsage('landmark', model, j.usage, { ms: Date.now() - t0 });  // 单次调用耗时（成功那次，不含重试等待）
    try { return JSON.parse(j.choices[0].message.content); } catch { return null; }
  }
  return null;
}

const ok = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
/** 关键点 → 比例（单位 U = 鼻底到下巴竖直距离；眼内比例按眼宽/眼高） */
export function metricsOf(p, ruler = 'U') {
  if (ruler === 'face') return metricsFace(p);
  const need = (...ks) => ks.every((k) => ok(p?.[k]));
  if (!need('nose', 'chin')) return {};
  const U = p.chin[1] - p.nose[1];
  if (!(U > 0)) return {};
  const m = {};
  const eyeY = need('eye_l', 'eye_r') ? (p.eye_l[1] + p.eye_r[1]) / 2 : null;
  if (need('cheek_l', 'cheek_r')) m.face_w = (p.cheek_r[0] - p.cheek_l[0]) / U;
  if (need('shoulder_l', 'shoulder_r')) { m.shoulder_w = (p.shoulder_r[0] - p.shoulder_l[0]) / U; m.neck = ((p.shoulder_l[1] + p.shoulder_r[1]) / 2 - p.chin[1]) / U; }
  if (eyeY != null && need('brow_l', 'brow_r')) m.brow_eye = (eyeY - (p.brow_l[1] + p.brow_r[1]) / 2) / U;
  if (eyeY != null) { m.eye_nose = (p.nose[1] - eyeY) / U; m.eye_dx = (p.eye_r[0] - p.eye_l[0]) / U; }
  const ew = need('eye_l_outer', 'eye_l_inner') ? Math.abs(p.eye_l_inner[0] - p.eye_l_outer[0]) : null;
  const eh = need('eye_l_top', 'eye_l_bottom') ? p.eye_l_bottom[1] - p.eye_l_top[1] : null;
  if (ew) m.eye_w = ew / U;
  if (eh) m.eye_h = eh / U;
  if (ew && need('iris_l_left', 'iris_l_right')) m.iris_ratio = (p.iris_l_right[0] - p.iris_l_left[0]) / ew;
  if (ew && need('iris_l_center', 'eye_l')) m.iris_x = (p.iris_l_center[0] - p.eye_l[0]) / ew;
  if (eh && need('iris_l_center', 'eye_l')) m.iris_y = (p.iris_l_center[1] - p.eye_l[1]) / eh;
  if (need('mouth_l', 'mouth_r')) { m.nose_mouth = ((p.mouth_l[1] + p.mouth_r[1]) / 2 - p.nose[1]) / U; m.mouth_w = (p.mouth_r[0] - p.mouth_l[0]) / U; }
  if (eyeY != null && need('bang_center')) m.bangs_eye = (eyeY - p.bang_center[1]) / U;
  if (need('head_top')) m.head_h = (p.chin[1] - p.head_top[1]) / U;
  return m;
}
export const METRIC_LABEL = {
  face_w: '脸宽（鼻底高度）', shoulder_w: '肩宽', neck: '下巴到肩线', brow_eye: '眉到眼（竖直）', eye_nose: '眼到鼻底（竖直）',
  eye_dx: '两眼中心间距', eye_w: '单眼宽（眼白开口）', eye_h: '单眼开口高（眼白）', iris_ratio: '虹膜宽 ÷ 眼白开口宽', iris_x: '虹膜偏左右（÷ 眼宽，正=向画面右）',
  iris_y: '虹膜偏上下（÷ 眼高，正=向下）', nose_mouth: '鼻底到嘴', mouth_w: '嘴宽', bangs_eye: '刘海下沿到眼睛（竖直）', head_h: '头顶到下巴',
};
export const STAGE_METRICS = {
  head: ['neck', 'head_h'], body: ['shoulder_w', 'neck'], face: ['face_w', 'eye_nose', 'brow_eye'], hair_front: ['bangs_eye', 'head_h'],
  hair_back: ['head_h'], eye: ['brow_eye', 'eye_nose', 'eye_dx', 'eye_w', 'eye_h'], iris: ['iris_ratio', 'iris_x', 'iris_y'], mouth: ['nose_mouth', 'mouth_w'],
};
/** 多次定点 → 每个比例的中位数和离散（最大 - 最小） */
export function aggregate(list, ruler = 'U') {
  const ms = list.map((p) => metricsOf(p, ruler)).filter((m) => Object.keys(m).length);
  const out = {};
  for (const k of new Set(ms.flatMap(Object.keys))) {
    const v = ms.map((m) => m[k]).filter(Number.isFinite).sort((a, b) => a - b);
    if (v.length) out[k] = { value: v[v.length >> 1], spread: v[v.length - 1] - v[0], n: v.length };
  }
  return out;
}

// v11：尺子改为脸宽 FW（鼻底高度处脸的宽度）和脸长 FL（两眉中点到下巴）——和评审 rubric「相对脸宽/脸长」同一口径
// （results/metric-check：U 为尺子时多数项和评审无关，换成脸宽/脸长后 11 项里 10 项更一致）
function metricsFace(p) {
  const need = (...ks) => ks.every((k) => ok(p?.[k]));
  if (!need('cheek_l', 'cheek_r', 'brow_l', 'brow_r', 'chin')) return {};
  const FW = p.cheek_r[0] - p.cheek_l[0], browY = (p.brow_l[1] + p.brow_r[1]) / 2, FL = p.chin[1] - browY;
  if (!(FW > 0 && FL > 0)) return {};
  const m = { face_w: FW / FL };
  const eyeY = need('eye_l', 'eye_r') ? (p.eye_l[1] + p.eye_r[1]) / 2 : null;
  if (need('shoulder_l', 'shoulder_r')) { m.shoulder_w = (p.shoulder_r[0] - p.shoulder_l[0]) / FW; m.neck = ((p.shoulder_l[1] + p.shoulder_r[1]) / 2 - p.chin[1]) / FL; }
  // v13 身体对齐：两肩中点和鼻尖的水平偏移（正 = 身体偏向画面右）；人工对照 AUC 0.87
  if (need('shoulder_l', 'shoulder_r', 'nose')) m.center_off = ((p.shoulder_l[0] + p.shoulder_r[0]) / 2 - p.nose[0]) / FW;
  if (eyeY != null) { m.brow_eye = (eyeY - browY) / FW; m.eye_dx = (p.eye_r[0] - p.eye_l[0]) / FW; if (need('nose')) m.eye_nose = (p.nose[1] - eyeY) / FL; }
  const ew = need('eye_l_outer', 'eye_l_inner') ? Math.abs(p.eye_l_inner[0] - p.eye_l_outer[0]) : null;
  const eh = need('eye_l_top', 'eye_l_bottom') ? p.eye_l_bottom[1] - p.eye_l_top[1] : null;
  if (ew) m.eye_w = ew / FW;
  if (eh) m.eye_h = eh / FW;
  if (ew && need('iris_l_left', 'iris_l_right')) m.iris_ratio = (p.iris_l_right[0] - p.iris_l_left[0]) / ew;
  if (ew && need('iris_l_center', 'eye_l')) m.iris_x = (p.iris_l_center[0] - p.eye_l[0]) / ew;
  if (eh && need('iris_l_center', 'eye_l')) m.iris_y = (p.iris_l_center[1] - p.eye_l[1]) / eh;
  if (need('mouth_l', 'mouth_r')) {
    const my = (p.mouth_l[1] + p.mouth_r[1]) / 2;
    if (need('nose')) m.nose_mouth = (my - p.nose[1]) / FL;
    m.mouth_chin = (p.chin[1] - my) / FL;
    m.mouth_w = (p.mouth_r[0] - p.mouth_l[0]) / FW;
  }
  if (eyeY != null && need('bang_center')) m.bangs_eye = (eyeY - p.bang_center[1]) / FL;
  if (need('head_top')) m.head_h = (p.chin[1] - p.head_top[1]) / FL;
  return m;
}
export const METRIC_LABEL_FACE = {
  face_w: '脸宽 ÷ 脸长（眉到下巴）', shoulder_w: '肩宽 ÷ 脸宽', neck: '下巴到肩线 ÷ 脸长', brow_eye: '眉到眼（竖直）÷ 脸宽', eye_nose: '眼到鼻底 ÷ 脸长',
  eye_dx: '两眼中心间距 ÷ 脸宽', eye_w: '单眼宽（眼白开口）÷ 脸宽', eye_h: '单眼开口高 ÷ 脸宽', iris_ratio: '虹膜宽 ÷ 眼白开口宽（riv 侧代码量）',
  iris_x: '虹膜偏内外（画面左侧那只眼，÷ 眼宽，正=向鼻子一侧，和 Eye_iris_R_X 增大的方向一致）', iris_y: '虹膜偏上下（÷ 眼高，正=向下）', nose_mouth: '鼻底到嘴 ÷ 脸长', mouth_chin: '嘴到下巴 ÷ 脸长',
  mouth_w: '嘴宽 ÷ 脸宽', bangs_eye: '刘海下沿到眼睛 ÷ 脸长', head_h: '头顶到下巴 ÷ 脸长',
  center_off: '身体中线偏移（两肩中点 - 鼻尖，÷ 脸宽，正=身体偏画面右）',
};
export const STAGE_METRICS_FACE = { ...STAGE_METRICS, body: ['shoulder_w', 'neck', 'center_off'], face: ['face_w', 'eye_nose', 'brow_eye'], mouth: ['nose_mouth', 'mouth_chin', 'mouth_w'] };
// v13 第 1 步对照人工：量不准、不拿来择优 / 当守护项的度量（只用于淘汰离谱的）
export const UNRELIABLE = new Set(['eye_w', 'eye_h', 'bangs_eye', 'head_h']);

// ════════════ 多尺子（2026-11-02）════════════
// 每项度量 = 某个距离 ÷ 尺子。尺子有多把候选（都取在脸部贴图上、调参时不动的部位），按优先级排；
// 每个项目在主图上检查每把尺子稳不稳，默认那把不稳就自动换下一把；主图和 riv 用同一把；全都不稳 → 这项没有可靠目标。
const P_ = (p, k) => (ok(p?.[k]) ? p[k] : null);
const mid_ = (p, a, b) => (P_(p, a) && P_(p, b) ? [(p[a][0] + p[b][0]) / 2, (p[a][1] + p[b][1]) / 2] : null);
export const RULERS = {
  FW: { label: '脸宽（鼻底高度两侧脸颊）', f: (p) => (P_(p, 'cheek_l') && P_(p, 'cheek_r') ? p.cheek_r[0] - p.cheek_l[0] : null) },
  FL: { label: '脸长（两眉中点到下巴）', f: (p) => { const b = mid_(p, 'brow_l', 'brow_r'); return b && P_(p, 'chin') ? p.chin[1] - b[1] : null; } },
  BN: { label: '眉到鼻底', f: (p) => { const b = mid_(p, 'brow_l', 'brow_r'); return b && P_(p, 'nose') ? p.nose[1] - b[1] : null; } },
  U: { label: '鼻底到下巴', f: (p) => (P_(p, 'nose') && P_(p, 'chin') ? p.chin[1] - p.nose[1] : null) },
  // 眼内尺子：虹膜位置以眼睛自身为尺子（不是脸）
  EW: { label: '眼白开口宽', eye: true, f: (p) => (P_(p, 'eye_l_outer') && P_(p, 'eye_l_inner') ? Math.abs(p.eye_l_inner[0] - p.eye_l_outer[0]) : null) },
  EH: { label: '眼白开口高', eye: true, f: (p) => (P_(p, 'eye_l_top') && P_(p, 'eye_l_bottom') ? p.eye_l_bottom[1] - p.eye_l_top[1] : null) },
};
// 度量：分子（距离）+ 尺子优先级（和评审口径最一致的在前）。abs = 目标可能接近 0，误差按绝对值看
export const METRICS_MULTI = {
  face_w: { num: (p) => RULERS.FW.f(p), rulers: ['FL'], label: '脸宽 ÷ 脸长' },
  shoulder_w: { num: (p) => (P_(p, 'shoulder_l') && P_(p, 'shoulder_r') ? p.shoulder_r[0] - p.shoulder_l[0] : null), rulers: ['FW', 'FL', 'BN', 'U'], label: '肩宽' },
  neck: { num: (p) => { const s = mid_(p, 'shoulder_l', 'shoulder_r'); return s && P_(p, 'chin') ? s[1] - p.chin[1] : null; }, rulers: ['FL', 'U', 'BN'], label: '下巴到肩线' },
  center_off: { num: (p) => { const s = mid_(p, 'shoulder_l', 'shoulder_r'); return s && P_(p, 'nose') ? s[0] - p.nose[0] : null; }, rulers: ['FW', 'FL', 'U'], abs: true, label: '身体中线偏移（两肩中点 - 鼻尖，正=偏画面右）' },
  brow_eye: { num: (p) => { const e = mid_(p, 'eye_l', 'eye_r'), b = mid_(p, 'brow_l', 'brow_r'); return e && b ? e[1] - b[1] : null; }, rulers: ['FW', 'FL', 'U'], label: '眉到眼（竖直）' },
  eye_nose: { num: (p) => { const e = mid_(p, 'eye_l', 'eye_r'); return e && P_(p, 'nose') ? p.nose[1] - e[1] : null; }, rulers: ['FL', 'FW', 'U'], label: '眼到鼻底' },
  eye_dx: { num: (p) => (P_(p, 'eye_l') && P_(p, 'eye_r') ? p.eye_r[0] - p.eye_l[0] : null), rulers: ['FW', 'FL', 'BN', 'U'], label: '两眼中心间距' },
  eye_w: { num: (p) => (P_(p, 'eye_l_outer') && P_(p, 'eye_l_inner') ? Math.abs(p.eye_l_inner[0] - p.eye_l_outer[0]) : null), rulers: ['FW', 'FL', 'U'], label: '单眼宽（眼白开口）' },
  eye_h: { num: (p) => (P_(p, 'eye_l_top') && P_(p, 'eye_l_bottom') ? p.eye_l_bottom[1] - p.eye_l_top[1] : null), rulers: ['FW', 'FL', 'U'], label: '单眼开口高' },
  nose_mouth: { num: (p) => { const m = mid_(p, 'mouth_l', 'mouth_r'); return m && P_(p, 'nose') ? m[1] - p.nose[1] : null; }, rulers: ['FL', 'U', 'BN'], label: '鼻底到嘴' },
  mouth_chin: { num: (p) => { const m = mid_(p, 'mouth_l', 'mouth_r'); return m && P_(p, 'chin') ? p.chin[1] - m[1] : null; }, rulers: ['FL', 'BN'], label: '嘴到下巴' },
  mouth_w: { num: (p) => (P_(p, 'mouth_l') && P_(p, 'mouth_r') ? p.mouth_r[0] - p.mouth_l[0] : null), rulers: ['FW', 'FL', 'U'], label: '嘴宽' },
  bangs_eye: { num: (p) => { const e = mid_(p, 'eye_l', 'eye_r'); return e && P_(p, 'bang_center') ? e[1] - p.bang_center[1] : null; }, rulers: ['FL', 'U', 'BN'], label: '刘海下沿到眼睛' },
  head_h: { num: (p) => (P_(p, 'head_top') && P_(p, 'chin') ? p.chin[1] - p.head_top[1] : null), rulers: ['FL', 'U'], label: '头顶到下巴' },
  // 虹膜位置：画面左侧那只眼，虹膜中心相对眼白开口中心（正 = 向鼻子一侧 / 向下）；虹膜大小（iris_ratio）由代码找边量，不在这里
  iris_x: { num: (p) => (P_(p, 'iris_l_center') && P_(p, 'eye_l') ? p.iris_l_center[0] - p.eye_l[0] : null), rulers: ['EW'], abs: true, label: '虹膜偏内外' },
  iris_y: { num: (p) => (P_(p, 'iris_l_center') && P_(p, 'eye_l') ? p.iris_l_center[1] - p.eye_l[1] : null), rulers: ['EH'], abs: true, label: '虹膜偏上下' },
};
// 稳健统计：中位数 + 中位数的误差（1.4826·MAD 当标准差，中位数标准误 ≈ 1.253·σ/√n）
// 误差下限：次数少时 MAD 可能碰巧为 0，按单次测量典型误差（相对 1.5%，接近 0 的度量绝对 0.01）÷ √n 兜底
const robust = (v, abs = false) => {
  v = v.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length < 3) return null;
  const med = v[v.length >> 1], d = v.map((x) => Math.abs(x - med)).sort((a, b) => a - b), mad = d[d.length >> 1];
  const floor = (abs ? 0.01 : 0.015 * Math.abs(med)) / Math.sqrt(v.length);
  return { med, se: Math.max((1.253 * 1.4826 * mad) / Math.sqrt(v.length), floor), n: v.length };
};
const REL_OK = 0.03, ABS_OK = 0.01;  // 中位数误差 ≤ 3%（接近 0 的度量 ≤ 0.01）才算可靠
/** 主图多次定点 → 每把尺子是否可靠、每项度量用哪把尺子、目标值；没可靠尺子 / 自身不稳的度量列入 unavailable */
export function multiTargets(ptsList) {
  const pts = ptsList.filter(Boolean);
  const rulerStat = {};
  for (const [k, r] of Object.entries(RULERS)) { const s = robust(pts.map(r.f)); rulerStat[k] = s ? { ...s, ok: s.se / Math.abs(s.med) <= REL_OK } : { ok: false }; }
  const target = {}, rulerOf = {}, unavailable = {};
  for (const [m, d] of Object.entries(METRICS_MULTI)) {
    let why = '没有可用的尺子';
    for (const rk of d.rulers) {
      if (!rulerStat[rk].ok) continue;
      const s = robust(pts.map((p) => { const n = d.num(p), r = RULERS[rk].f(p); return n != null && r ? n / r : NaN; }), d.abs);
      if (!s) { why = '点标不出'; continue; }
      const okk = d.abs ? s.se <= ABS_OK : s.se / Math.abs(s.med) <= REL_OK;
      if (okk) { target[m] = s.med; rulerOf[m] = rk; break; }
      why = `用 ${rk} 量时自身不稳（误差 ${d.abs ? s.se.toFixed(3) : (s.se / Math.abs(s.med) * 100).toFixed(1) + '%'}）`;
    }
    if (!(m in target)) unavailable[m] = why;
  }
  return { target, rulerOf, unavailable, rulerStat };
}
/** riv 单次定点 → 按主图选定的尺子算各度量（和主图同一把尺子） */
export function metricsWith(p, rulerOf) {
  const out = {};
  for (const [m, rk] of Object.entries(rulerOf)) { const n = METRICS_MULTI[m].num(p), r = RULERS[rk].f(p); if (n != null && r) out[m] = n / r; }
  return out;
}
