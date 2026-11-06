// v17 贴图挑选（方案见 results/v17-pick-spec.md，验证见 results/v17-validation.md）
// 按组件：① 代码完整性检查 → ② 测量淘汰（面部 F1/F2/F3、眼眶朝向 E1）→ ③ AI 逐方面打分 + "缺失或画坏"否决；不试调参数，只看贴图本身。
// 起始贴图和候选地位相同（N 选 1）；pickParallel 时各组件并发挑（后发要参考已选前发，等前发挑完）
import fs from 'node:fs';
import { decode } from './png-decode.mjs';
import { locate } from './landmarks.mjs';
import { logUsage } from './usage.mjs';
import { avaPath } from './lab.mjs';

const MODEL = 'gpt-6.1-sol', KEY = fs.readFileSync(avaPath('.dev.vars'), 'utf8').match(/^IMAGE_API_KEY=(.*)$/m)[1].trim();
const med = (v) => { v = v.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : NaN; };
const img = (b64) => decode(Buffer.from(b64, 'base64'));
const A = (t, x, y) => t.d[(y * t.w + x) * 4 + 3];
const toLab = ([r, g, b]) => { const f = (c) => { c /= 255; return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92; }; const R = f(r), G = f(g), B = f(b); const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883; const h = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116); return [116 * h(Y) - 16, 500 * (h(X) - h(Y)), 200 * (h(Y) - h(Z))]; };

// 组件 → 候选池文件前缀、贴图角色；顺序即挑选顺序
const COMPONENTS = [
  { comp: 'head', pool: 'head', roles: ['head'] },
  { comp: 'body', pool: 'body', roles: ['body'] },
  { comp: 'hair_front', pool: 'hair', roles: ['hair_front'] },
  { comp: 'hair_back', pool: 'hair', roles: ['hair_back'], after: 'hair_front' },
  { comp: 'sclera', pool: 'sclera', roles: ['sclera'] },
  { comp: 'pupil', pool: 'pupil', roles: ['pupil'] },
  { comp: 'mouth', pool: 'mouth', roles: ['mouth_up', 'mouth_down'] },
];
// 宽高可分别调的组件：候选拉到同批宽高比中位数再给 AI 看
const STRETCH = new Set(['sclera', 'mouth']);

// ─── AI 层：各组件的填空 ───
const SPEC = {
  head: { comp: '脸部', part: '脸部', has: '脸部轮廓、眉毛、鼻子、耳朵、肤色和脸上的阴影红晕', other: '眼睛、嘴、头发', extra: '候选上之后会被前发盖住的额头和两鬓不比。', adj: '整体大小和位置',
    aspects: ['脸部轮廓：下颌线走向，下巴尖、圆或方，两颊饱满程度', '脸的宽窄：贴图自身的脸宽与脸长之比', '眉毛：形状、粗细、走向，在脸上的高低', '鼻子：形状和画法，在眉和下巴之间的高低', '耳朵：形状、露出多少', '肤色与红晕：深浅冷暖，红晕的有无和位置'] },
  body: { comp: '身体', part: '脖子到身体', has: '脖子、肩、上身服装', other: '头、脸、头发', extra: '贴图顶部之后会被头盖住的部分、候选比主图多出来的下半身、脖子露出多长（由位置决定）都不比；候选上画着的头发只看是否和主图对应。', adj: '大小、上下左右位置',
    aspects: ['领口：领子类型、开口形状和深浅、左右是否对称', '肩形：平肩还是溜肩、肩线弧度', '脖子：粗细相对肩宽', '服装结构：门襟、领带或领结、扣子、口袋、外套层次', '颜色：服装各部分的颜色'] },
  hair_front: { comp: '前发', part: '头发', has: '前发（刘海、鬓发）', other: '后发、脸、五官', extra: '候选中间露空是正常的。', adj: '大小、上下位置（包括刘海盖到眉毛的哪里）',
    aspects: ['分缝：有无、位置、朝哪边梳', '刘海形态：齐、斜、碎、空气感；发束的数量、粗细、尖端走向', '刘海下沿：平直、弧形或参差，左右是否对称', '鬓发：有无，长度相对刘海宽度', '发色与高光', '发饰：发饰、呆毛的有无和位置'] },
  hair_back: { comp: '后发', part: '头发（头顶到发尾）', has: '后发', other: '前发、脸、身体', extra: '中间被脸、身体、前发挡住的部分不比。第二格是已经选好的前发，只作参考，不是候选。', adj: '大小、位置',
    aspects: ['长短：贴图自身的长度相对宽度（不看它会落在肩、胸还是腰）', '外轮廓：直、卷、波浪，内扣或外翘，蓬松程度', '结构：披发、马尾、辫子、盘发，以及位置', '发尾：发尾形态', '发色：发色与高光，和已选前发是否协调', '发饰：有无、位置'] },
  sclera: { comp: '眼眶', part: '双眼', has: '眼线、睫毛、眼白', other: '虹膜、瞳孔、眉、脸', extra: '候选画的是画面左侧那只眼（外眼角在左），画面右侧那只由它镜像得到；以主图里看得更清楚的那只眼为准，看右眼时按镜像后比较。', adj: '宽、高、位置（候选已拉成统一宽高）',
    aspects: ['上眼线：粗细、走势、末端是否延长或上挑', '睫毛：有无、数量、长短、长在哪一段', '下眼线：有无、覆盖范围', '眼形：上眼睑最高点偏内还是偏外，内外眼角的高低', '眼尾朝向：外眼角是否在左', '双眼皮线：有无、位置', '颜色：眼线颜色、眼白颜色'] },
  pupil: { comp: '瞳孔（虹膜）', part: '眼睛', has: '虹膜和瞳孔（候选是完整圆形，贴上后会被眼眶遮住一部分）', other: '眼眶、眼白、眼睑', extra: '主图被眼睑、睫毛、头发挡住的部分不比，候选画完整不算错。', adj: '大小、位置',
    aspects: ['主色与渐变：主色，上下、内外的明暗方向', '纹理：放射纹、环纹、纯色', '瞳孔：中心深色区的形状、相对虹膜的大小', '外圈描边：有无、粗细', '高光：数量、位置、形状'] },
  mouth: { comp: '嘴', part: '嘴', has: '上唇和下唇', other: '脸、鼻、下巴', extra: '', adj: '宽窄、整体厚薄、位置（候选已拉成统一宽高比）',
    aspects: ['开合：闭、微张、张开，露不露牙或舌', '嘴角：上扬、平、下垂', '唇形：唇峰的 M 形、下唇弧度', '上下唇比例：谁厚、差多少（只比两者之比）', '唇线与颜色：描边、唇色、高光'] },
};
const promptOf = (s) => `你在为 2D 角色挑选「${s.comp}」图层贴图。第一格是主图的${s.part}，后面 A、B、C… 是候选贴图，单独显示。
这个图层只含：${s.has}。${s.other}属于别的图层，候选上本来就没有，不比。${s.extra}
${s.adj}之后都能用参数调，不比。主图是插画、候选是模板贴图，画风、线条粗细、光影质感的差异不比。
主图里被头发、手、帽子、耳机、道具等挡住或在画面外的部分，判「看不见」，不比，也不要猜。
先写出主图在每个方面的特征（看不见写 null），再把每张候选按下面的方面逐一和主图对比，不要凭整体印象。每项判：一致 / 接近 / 不同 / 缺失或画坏 / 看不见。
「缺失或画坏」只用于：主图上看得见、候选上没有；或候选这一部分残缺、变形、画坏。
方面：
${s.aspects.map((a, i) => `${i + 1}. ${a}`).join('\n')}
${s.aspects.length + 1}. 其他：上面没覆盖到的、候选和主图明显不一致，或候选多出主图没有的东西（没有就判一致）。
方面名用冒号前的词（最后一项叫"其他"）。只输出 JSON：{"master":{"方面":"特征或null"},"scores":{"A":{"方面":"一致|接近|不同|缺失或画坏|看不见"}},"best":"字母","reason":"一句话"}`;
const aspectNames = (s) => [...s.aspects.map((a) => a.split('：')[0]), '其他'];

async function ask(sys, png) {
  if (process.env.PICK_DRY) return null;  // 空跑：只验证流程，不调用模型
  for (let attempt = 1; attempt <= 15; attempt++) {
    const t0 = Date.now();
    const res = await fetch('https://tenantapi.anispark.ai/llm/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(240000),
      body: JSON.stringify({ model: MODEL, temperature: 0.2, messages: [{ role: 'system', content: sys }, { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }] }], response_format: { type: 'json_object' }, max_tokens: 4000 }) }).catch(() => null);
    if (res?.ok) { const j = await res.json(); logUsage('pick', MODEL, j.usage, { ms: Date.now() - t0 }); try { return JSON.parse(j.choices[0].message.content); } catch { continue; } }
    await new Promise((o) => setTimeout(o, res?.status === 429 ? 20000 : 5000));
  }
  return null;
}

// ─── ① 完整性：半透明残留（alpha 16–128 外框超出不透明外框）、贴画布边 ───
function integrity(t) {
  let x0 = t.w, y0 = t.h, x1 = -1, y1 = -1, fx0 = t.w, fy0 = t.h, fx1 = -1, fy1 = -1;
  for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) { const a = A(t, x, y); if (a > 16) { fx0 = Math.min(fx0, x); fx1 = Math.max(fx1, x); fy0 = Math.min(fy0, y); fy1 = Math.max(fy1, y); } if (a >= 128) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } }
  if (x1 < 0) return { empty: true };
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  return { faint: Math.max(y0 - fy0, fy1 - y1) / bh + Math.max(x0 - fx0, fx1 - x1) / bw, edge: [x0 === 0 ? 'L' : '', x1 === t.w - 1 ? 'R' : '', y0 === 0 ? 'T' : '', y1 === t.h - 1 ? 'B' : ''].join(''), box: [x0, y0, x1, y1], bw, bh };
}
const FAINT_MAX = 0.25;  // 离线验证：正常贴图最大 0.167，坏掉的身体 0.627；取第二大 × 1.5

// ─── E1 眼尾朝向：候选和模板默认贴图正 / 翻转的 IoU 之差 ───
const N = 48;
function maskOf(t, flip = false) {
  const s = integrity(t), [x0, y0] = s.box, m = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const sx = Math.round(x0 + ((flip ? N - 1 - x : x) + 0.5) / N * s.bw - 0.5), sy = Math.round(y0 + (y + 0.5) / N * s.bh - 0.5); m[y * N + x] = A(t, Math.min(t.w - 1, sx), Math.min(t.h - 1, sy)) >= 128 ? 1 : 0; }
  return m;
}
const iou = (a, b) => { let i = 0, u = 0; for (let k = 0; k < a.length; k++) { i += a[k] & b[k]; u += a[k] | b[k]; } return u ? i / u : 0; };
const e1Of = (t, tpl) => iou(maskOf(t), maskOf(tpl)) - iou(maskOf(t), maskOf(tpl, true));

// ─── 面部：眉线（代码找最暗行）、下巴（alpha 下沿）、F1、F3 ───
function faceCode(t, noseRel) {
  const s = integrity(t), [x0, y0, x1, y1] = s.box, cx = (x0 + x1) / 2;
  const lum = (x, y) => { const k = (y * t.w + x) * 4; return t.d[k + 3] < 128 ? 255 : 0.3 * t.d[k] + 0.59 * t.d[k + 1] + 0.11 * t.d[k + 2]; };
  const browOf = (xa, xb) => { let best = 1e9, by = -1; for (let y = Math.round(y0 + 0.25 * s.bh); y < y0 + 0.55 * s.bh; y++) { const v = []; for (let x = xa; x < xb; x++) v.push(lum(x, y)); v.sort((a, b) => a - b); const n = Math.max(4, v.length >> 3), m = v.slice(0, n).reduce((a, c) => a + c, 0) / n; if (m < best) { best = m; by = y; } } return by; };
  const brow = (browOf(Math.round(x0 + 0.08 * s.bw), Math.round(cx - 3)) + browOf(Math.round(cx + 3), Math.round(x1 - 0.08 * s.bw))) / 2, fl = y1 - brow;
  const row = Math.round(brow + fl * noseRel); let a = -1, c = -1; for (let x = 0; x < t.w; x++) if (A(t, x, row) >= 128) { if (a < 0) a = x; c = x; }
  const fw = c - a + 1, px = [];
  for (const sx of [-1, 1]) for (let dx = -0.03; dx <= 0.03; dx += 0.005) for (let dy = -0.04; dy <= 0.04; dy += 0.005) { const x = Math.round(cx + sx * 0.3 * fw + dx * fw), y = Math.round(brow + fl * noseRel - 0.12 * fl + dy * fl); if (x < 0 || y < 0 || x >= t.w || y >= t.h || A(t, x, y) < 128) continue; const k = (y * t.w + x) * 4; px.push(toLab([t.d[k], t.d[k + 1], t.d[k + 2]])); }
  return { brow, chin: y1, F1: fw / fl, skin: [0, 1, 2].map((i) => med(px.map((l) => l[i]))) };
}
// 主图：9 次标点各算一次，中位数为目标；相对中位数的离散 > 3% 视为不稳（这一项跳过）
function faceMaster(pts, W, H, masterRgba) {
  const per = pts.filter(Boolean).map((p) => {
    const ok = (n) => Array.isArray(p[n]) && p[n].every(Number.isFinite);
    if (!['brow_l', 'brow_r', 'chin', 'nose', 'cheek_l', 'cheek_r'].every(ok)) return null;
    const browY = (p.brow_l[1] + p.brow_r[1]) / 2, FL = p.chin[1] - browY;
    return { F1: (p.cheek_r[0] - p.cheek_l[0]) / FL, noseRel: (p.nose[1] - browY) / FL, browY, FL, FW: p.cheek_r[0] - p.cheek_l[0], cx: (p.cheek_l[0] + p.cheek_r[0]) / 2, nose: p.nose[1] };
  });
  const v = per.filter(Boolean);
  const stat = (k) => { const m = med(v.map((x) => x[k])), se = med(v.map((x) => Math.abs(x[k] - m))); return { value: m, ok: v.length >= 3 && v.length * 3 >= per.length * 2 && se / Math.abs(m) <= 0.03 }; };
  const out = { F1: stat('F1'), noseRel: stat('noseRel') };
  // 主图肤色（按主图原尺寸取色）
  if (masterRgba && v.length) {
    const s = masterRgba.w / W, g = (k) => med(v.map((x) => x[k])) * s, px = [];
    for (const sx of [-1, 1]) for (let dx = -0.03; dx <= 0.03; dx += 0.005) for (let dy = -0.04; dy <= 0.04; dy += 0.005) { const x = Math.round(g('cx') + sx * 0.3 * g('FW') + dx * g('FW')), y = Math.round(g('nose') - 0.12 * g('FL') + dy * g('FL')); if (x < 0 || y < 0 || x >= masterRgba.w || y >= masterRgba.h) continue; const k = (y * masterRgba.w + x) * 4; px.push(toLab([masterRgba.d[k], masterRgba.d[k + 1], masterRgba.d[k + 2]])); }
    out.skin = [0, 1, 2].map((i) => med(px.map((l) => l[i])));
  }
  return out;
}
// 通用测量淘汰：误差 > abs 且比同批最好的差 ≥ rel；最好的那张永不淘汰
const relCut = (errs, abs, rel) => { const fin = errs.filter(Number.isFinite); if (!fin.length) return errs.map(() => false); const best = Math.min(...fin); return errs.map((e) => Number.isFinite(e) && e > abs && e - best >= rel); };

// ─── ③ AI：循环换位；前 2 问并发，第一相同且领先 ≥0.1 就停，否则问完所有移位 ───
const SC = { 一致: 2, 接近: 1, 不同: 0, 缺失或画坏: 0 };
async function aiPick(c, cands, imgs) {
  const s = SPEC[c.comp], sys = promptOf(s), names = aspectNames(s), n = cands.length;
  const rot = Array.from({ length: n }, (_, k) => Array.from({ length: n }, (_, i) => (i - k + n) % n));
  const scoreOf = (a, order) => {
    const out = Array.from({ length: n }, () => ({ score: NaN, bad: [] }));
    order.forEach((ci, pos) => {
      const sc = a?.scores?.[String.fromCharCode(65 + pos)] || {}; let sum = 0, cnt = 0;
      for (const nm of names) { if (a?.master?.[nm] == null && nm !== '其他') continue; const v = sc[nm]; if (v in SC) { sum += SC[v]; cnt++; } if (v === '缺失或画坏') out[ci].bad.push(nm); }
      out[ci].score = cnt ? sum / (2 * cnt) : NaN;
    });
    return out;
  };
  const run = async (q) => { const a = await ask(sys, imgs[q]); return a ? { q, order: rot[q], a, s: scoreOf(a, rot[q]) } : null; };
  const asks = (await Promise.all([0, 1].slice(0, n).map(run))).filter(Boolean);
  const avg = () => cands.map((_, i) => { const v = asks.map((x) => x.s[i].score).filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; });
  const firstOf = (x) => x.s.map((y, i) => [Number.isFinite(y.score) ? y.score : -1, i]).sort((a, b) => b[0] - a[0])[0][1];
  const sorted = () => avg().map((x, i) => [Number.isFinite(x) ? x : -1, i]).sort((a, b) => b[0] - a[0]);
  let t = sorted();
  if (!(asks.length >= 2 && firstOf(asks[0]) === firstOf(asks[1]) && t[0][0] - (t[1]?.[0] ?? -1) >= 0.1)) {
    for (let q = 2; q < n; q++) { const r = await run(q); if (r) asks.push(r); }
  }
  if (!asks.length) return { failed: true };
  // 否决：同一候选同一方面 ≥2 问判"缺失或画坏"（主图该方面非 null）；同批该方面全被判掉只作废这一方面；全部出局则否决作废
  const badCnt = cands.map((_, i) => { const m = {}; asks.forEach((x) => x.s[i].bad.forEach((nm) => { if (x.a.master?.[nm] != null || nm === '其他') m[nm] = (m[nm] || 0) + 1; })); return m; });
  const vetoA = cands.map((_, i) => Object.keys(badCnt[i]).filter((nm) => badCnt[i][nm] >= 2));
  const voidA = new Set(names.filter((nm) => cands.every((_, i) => vetoA[i].includes(nm))));
  let out = cands.map((_, i) => vetoA[i].some((nm) => !voidA.has(nm)));
  if (out.every(Boolean)) out = out.map(() => false);
  const sc = avg();
  return { asks: asks.map((x) => ({ order: x.order, best: x.a.best, reason: x.a.reason, scores: x.s.map((y) => +(y.score || 0).toFixed(2)), bad: x.s.map((y) => y.bad) })), avg: sc, veto: cands.map((_, i) => (out[i] ? vetoA[i].filter((nm) => !voidA.has(nm)) : [])), out };
}

/**
 * @param lab  lab 页面（当前项目、主图已加载）
 * @param poolDir  候选池目录（<池名>-<i>.json）
 * @param pts  主图 9 次标点（定点图坐标），W/H 为定点图尺寸
 * @returns poolLog（每个组件一条），并已把选中的贴图换到 lab 里
 */
export async function pickV17({ lab, poolDir, pts, W, H, cfg = {}, tag = '' }) {
  const med2 = (n, i) => med(pts.map((p) => p?.[n]?.[i]));
  const roleTex = await lab.call('roleTextures'), tplAll = await lab.call('templateTextures');
  const aidOf = Object.fromEntries(Object.entries(roleTex).map(([r, v]) => [r, String(v.assetId)]));
  const masterRgba = await (async () => { try { const m = await lab.call('masterForPoints'); return decode(Buffer.from(m.png, 'base64')); } catch { return null; } })();  // 和标点同一尺寸
  const fm = faceMaster(pts, W, H, masterRgba);
  // 主图裁剪框（定点图坐标 → 相对框）
  const browY = (med2('brow_l', 1) + med2('brow_r', 1)) / 2, chin = med2('chin', 1), FL = chin - browY, FW = med2('cheek_r', 0) - med2('cheek_l', 0), cx = (med2('cheek_l', 0) + med2('cheek_r', 0)) / 2;
  const ew = Math.abs(med2('eye_l_inner', 0) - med2('eye_l_outer', 0)), eh = Math.abs(med2('eye_l_bottom', 1) - med2('eye_l_top', 1)), mw = med2('mouth_r', 0) - med2('mouth_l', 0), my = (med2('mouth_l', 1) + med2('mouth_r', 1)) / 2, mx = (med2('mouth_l', 0) + med2('mouth_r', 0)) / 2;
  const rel = (x0, y0, x1, y1) => [Math.max(0, x0) / W, Math.max(0, y0) / H, (Math.min(W, x1) - Math.max(0, x0)) / W, (Math.min(H, y1) - Math.max(0, y0)) / H];
  const half = Math.max(FW, FL) * 0.75, top = med2('head_top', 1);
  const BOX = {
    head: rel(cx - half, browY - 0.45 * FL, cx + half, chin + 0.15 * FL),
    body: rel(0, chin - 0.2 * FL, W, H),
    hair_front: rel(cx - 1.6 * half, (Number.isFinite(top) ? top : browY - FL) - 0.05 * FL, cx + 1.6 * half, chin),
    hair_back: rel(0, (Number.isFinite(top) ? top : browY - FL) - 0.05 * FL, W, H),
    pupil: rel(med2('iris_l_center', 0) - 0.75 * ew, med2('iris_l_center', 1) - 0.75 * ew, med2('iris_l_center', 0) + 0.75 * ew, med2('iris_l_center', 1) + 0.75 * ew),
    mouth: rel(mx - mw, my - 0.6 * mw, mx + mw, my + 0.6 * mw),
    sclera: rel(Math.min(med2('eye_l_outer', 0), med2('eye_l_inner', 0)) - 0.4 * ew, (med2('brow_l', 1) + med2('eye_l', 1)) / 2, med2('eye_r', 0) + ew * 0.9, med2('eye_l_bottom', 1) + 1.2 * eh),
  };
  // 候选：起始贴图 + 池里的 <池名>-<i>.json
  const candsOf = (c) => {
    const aids = c.roles.map((r) => aidOf[r]).filter(Boolean);
    if (aids.length !== c.roles.length) return [];
    const start = { name: '起始', tex: Object.fromEntries(c.roles.map((r) => [aidOf[r], roleTex[r].png])) };
    const files = fs.existsSync(poolDir) ? fs.readdirSync(poolDir).filter((f) => f.startsWith(`${c.pool}-`)).sort() : [];
    const pool = files.map((f) => { const j = JSON.parse(fs.readFileSync(`${poolDir}/${f}`, 'utf8')); return { name: f.replace('.json', ''), tex: Object.fromEntries(aids.map((a) => [a, j.textures[a]])), vmPatch: j.viewModelPatch ?? null }; }).filter((x) => aids.every((a) => x.tex[a]));
    return [start, ...pool].map((x) => ({ ...x, layers: aids.map((a) => x.tex[a]), log: [] }));
  };
  const log = [], chosen = {};
  const doComp = async (c) => {
    const all = candsOf(c);
    if (all.length < 2) { log.push({ component: c.comp, picked: all[0]?.name ?? '起始', rows: all.map((x) => ({ name: x.name, dist: '只有一张' })) }); chosen[c.comp] = all[0]; return; }
    const tpl = c.roles.map((r) => tplAll[aidOf[r]]);
    // ① 完整性
    for (const x of all) {
      x.layers.forEach((b, j) => {
        const s = integrity(img(b)), ts = tpl[j] ? integrity(img(tpl[j])) : null;
        if (s.empty) x.log.push('空贴图');
        else { if (s.faint > FAINT_MAX) x.log.push(`半透明残留 ${s.faint.toFixed(2)}`); const extra = s.edge.split('').filter((e) => e && !(ts?.edge ?? '').includes(e)); if (extra.length && all.filter((y) => integrity(img(y.layers[j])).edge.includes(extra[0])).length * 2 < all.length) x.log.push(`贴画布边 ${extra.join('')}`); }
      });
    }
    let alive = all.filter((x) => !x.log.length);
    if (!alive.length) { alive = all; all.forEach((x) => x.log.push('（整批不合格，完整性检查作废）')); }
    // ② 测量
    if (c.comp === 'head') {
      const rows = await Promise.all(alive.map(async (x) => {
        const t = img(x.layers[0]), fc = faceCode(t, fm.noseRel.value);
        const w = await lab.call('onWhite', x.layers[0]);
        const p = process.env.PICK_DRY ? { nose: [0, (fc.brow + fc.chin) / 2] } : await locate(MODEL, w, { nose: '鼻底（鼻尖下沿）。这张图是单独的脸部贴图，没有眼睛和嘴；如果没画鼻子，给 null' });
        const ny = p?.nose?.[1], f2 = Number.isFinite(ny) ? (ny - fc.brow) / (fc.chin - fc.brow) : NaN;
        return { x, F1err: fm.F1.ok ? Math.abs(fc.F1 / fm.F1.value - 1) : NaN, F2err: fm.noseRel.ok && Number.isFinite(f2) ? Math.abs(f2 / fm.noseRel.value - 1) : NaN, noNose: fm.noseRel.ok && !Number.isFinite(ny), dE: fm.skin && fc.skin.every(Number.isFinite) ? Math.hypot(...fc.skin.map((v, i) => v - fm.skin[i])) : NaN };
      }));
      const c1 = relCut(rows.map((r) => r.F1err), 0.12, 0.10), c2 = relCut(rows.map((r) => r.F2err), 0.12, 0.10), c3 = relCut(rows.map((r) => r.dE / 100), 0.12, 0.06);
      const allNoNose = rows.every((r) => r.noNose);
      rows.forEach((r, i) => {
        r.x.measure = { F1: r.F1err, F2: r.F2err, dE: r.dE, noNose: r.noNose };
        if (c1[i]) r.x.log.push(`脸宽÷脸长 差 ${(r.F1err * 100).toFixed(0)}%`);
        if (c2[i]) r.x.log.push(`鼻底高度 差 ${(r.F2err * 100).toFixed(0)}%`);
        if (c3[i]) r.x.log.push(`肤色 ΔE ${r.dE.toFixed(1)}`);
        if (r.noNose && !allNoNose) r.x.log.push('主图看得到鼻底，候选上标不出');
      });
      if (!fm.F1.ok) log.push({ component: 'head', note: '主图脸宽÷脸长不稳，跳过' });
      if (!fm.noseRel.ok) log.push({ component: 'head', note: '主图鼻底高度不稳，跳过鼻底相关项' });
    }
    if (c.comp === 'sclera' && tpl[0]) {
      const tt = img(tpl[0]);
      for (const x of alive) { const e = e1Of(img(x.layers[0]), tt); x.measure = { e1: e }; if (e <= -0.08) x.log.push(`眼尾朝向画反（${e.toFixed(2)}）`); }
    }
    let alive2 = alive.filter((x) => !x.log.length);
    if (!alive2.length) alive2 = [alive.reduce((a, b) => a)];  // 最好的永不淘汰：测量全淘汰时保留第一张（不会发生在 relCut 下，兜底）
    // ③ AI
    let picked = alive2[0], ai = null;
    if (alive2.length > 1) {
      const aspect = STRETCH.has(c.comp) ? med(alive2.map((x) => { const ims = x.layers.map(img); let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1; for (const t of ims) { const s = integrity(t); if (s.empty) continue; x0 = Math.min(x0, s.box[0]); y0 = Math.min(y0, s.box[1]); x1 = Math.max(x1, s.box[2]); y1 = Math.max(y1, s.box[3]); } return (x1 - x0 + 1) / (y1 - y0 + 1); })) : null;
      const n = alive2.length, imgs = [];
      const ref = c.after ? chosen[c.after]?.layers : null;
      for (let k = 0; k < n; k++) { const order = Array.from({ length: n }, (_, i) => (i - k + n) % n); imgs.push(await renderLock(() => lab.call('choiceImage2', BOX[c.comp], order.map((i) => alive2[i].layers), { aspect, ref }))); }
      ai = await aiPick(c, alive2, imgs);
      if (!ai.failed) {
        alive2.forEach((x, i) => { x.ai = +(ai.avg[i] || 0).toFixed(2); if (ai.out[i]) x.log.push(`AI 否决：${ai.veto[i].join('、')}`); });
        const ok = alive2.map((x, i) => [ai.avg[i], i]).filter(([, i]) => !ai.out[i]).sort((a, b) => b[0] - a[0]);
        picked = alive2[ok[0][1]];
        if (ok.length > 1 && ok[0][0] - ok[1][0] < 0.05) picked.lowConf = true;
      }
    }
    chosen[c.comp] = picked;
    log.push({ component: c.comp, picked: picked.name, lowConf: !!picked.lowConf, aiFailed: !!ai?.failed, rows: all.map((x) => ({ name: x.name, dist: x.ai ?? '-', out: x.log, measure: x.measure ?? null })), asks: ai?.asks ?? null });
    console.log(tag, 'pick', c.comp, all.map((x) => `${x.name}${x.ai != null ? ':' + x.ai : ''}${x.log.length ? '(' + x.log.join('；') + ')' : ''}`).join(' '), '→', picked.name, picked.lowConf ? '（低置信）' : '');
  };
  // 拼图要用 lab 页面（单线程渲染），串行化；AI 请求可以并发
  let lock = Promise.resolve();
  const renderLock = (fn) => { const p = lock.then(fn); lock = p.catch(() => {}); return p; };
  if (cfg.pickParallel) {
    await Promise.all(COMPONENTS.filter((c) => !c.after).map(doComp));
    for (const c of COMPONENTS.filter((c) => c.after)) await doComp(c);
  } else for (const c of COMPONENTS) await doComp(c);
  // 把选中的贴图换上（起始那张不用换）
  const patch = {}, vmPatch = {};
  for (const x of Object.values(chosen)) if (x && x.name !== '起始') { Object.assign(patch, x.tex); Object.assign(vmPatch, x.vmPatch ?? {}); }
  const snap = await lab.call('textureSnapshot');
  await lab.call('restoreTextures', { ...snap, ...patch });
  return { poolLog: log.filter((l) => l.picked), notes: log.filter((l) => l.note), vmPatch };
}
