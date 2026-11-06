// v17 离线验证第二段：只用代码，在现有候选贴图上算测量层各项的分布，看阈值会不会误淘汰、已知坏贴图能不能拦下（不调用模型）
// 输入：/tmp/vm17/off/<项目>.json（v17-dump.mjs 导出）、results/pool、data/e2e、主图标点
import fs from 'node:fs';
import { decode } from './png-decode.mjs';
import { readJson, labPath } from './lab.mjs';

const OFF = '/tmp/vm17/off';
const AID = { hair_front: '6845561', head: '6845562', body: '6845564', sclera: '6845565', pupil: '6845574', mouth_down: '6845581', mouth_up: '6845582', hair_back: '7032921' };
const COMPS = ['head', 'body', 'sclera', 'pupil', 'mouth', 'hair_front', 'hair_back'];
const PROJ = ['1cf5ecc9', '41e01792', '9ee088da', 'dfb3bc24', '5e170e65'];
const E2E = { dfb3bc24: 'dfb3bc24-86fd-4619-b6e3-f85e1fcc4e29', '5e170e65': '5e170e65-4f1e-49ea-818d-ab6c79dfe176' };
const med = (v) => { v = v.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : NaN; };
const P = (pts, n, i) => med(pts.map((p) => p?.[n]?.[i]));
const img = (b64) => decode(Buffer.from(b64, 'base64'));
const A = (t, x, y) => t.d[(y * t.w + x) * 4 + 3];
const toLab = ([r, g, b]) => { const f = (c) => { c /= 255; return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92; }; const R = f(r), G = f(g), B = f(b); const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883; const h = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116); return [116 * h(Y) - 16, 500 * (h(X) - h(Y)), 200 * (h(Y) - h(Z))]; };

// ─── 候选集合：{ 项目: { 组件: [{ name, tex: { aid: b64 } }] } } ───
const sets = {}, dump = {};
for (const p of PROJ) {
  dump[p] = JSON.parse(fs.readFileSync(`${OFF}/${p}.json`, 'utf8'));
  sets[p] = {};
  const pick = (aids, src) => Object.fromEntries(aids.map((a) => [a, src[a]]).filter(([, v]) => v));
  for (const c of COMPS) {
    const aids = c === 'mouth' ? [AID.mouth_up, AID.mouth_down] : [AID[c]];
    const list = [];
    if (E2E[p]) {
      const dir = labPath(`data/e2e/${E2E[p]}`);
      const t1 = Object.fromEntries(aids.filter((a) => fs.existsSync(`${dir}/tex/${a}.png`)).map((a) => [a, fs.readFileSync(`${dir}/tex/${a}.png`).toString('base64')]));
      if (Object.keys(t1).length) list.push({ name: '候选1', tex: t1 });
      for (const i of [2, 3]) { const f = `${dir}/pool/${c}-${i}.json`; if (fs.existsSync(f)) list.push({ name: `候选${i}`, tex: readJson(`data/e2e/${E2E[p]}/pool/${c}-${i}.json`).textures }); }
    } else {
      const o = pick(aids, dump[p].original); if (Object.keys(o).length) list.push({ name: '原贴图', tex: o });
      const pc = c === 'head' ? 'head' : c;
      for (const i of [1, 2, 3]) { const f = labPath(`results/pool/${p}/${pc}-${i}.json`); if (fs.existsSync(f)) list.push({ name: `候选${i}`, tex: readJson(`results/pool/${p}/${pc}-${i}.json`).textures }); }
    }
    if (list.length) sets[p][c] = { list, template: pick(aids, dump[p].template) };
  }
}

// ─── ① 完整性检查 ───
function integrity(t) {
  const { w, h } = t; let x0 = w, y0 = h, x1 = -1, y1 = -1, fx0 = w, fy0 = h, fx1 = -1, fy1 = -1, n = 0;
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const a = A(t, x, y); if (a > 16) { fx0 = Math.min(fx0, x); fx1 = Math.max(fx1, x); fy0 = Math.min(fy0, y); fy1 = Math.max(fy1, y); } if (a >= 128) { n++; m[y * w + x] = 1; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } }
  if (!n) return { empty: true };
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  // 连通块（不透明）
  const lab = new Int32Array(w * h).fill(-1), sizes = [];
  for (let i = 0; i < w * h; i++) { if (!m[i] || lab[i] >= 0) continue; const q = [i]; lab[i] = sizes.length; let c = 0; while (q.length) { const j = q.pop(); c++; const xx = j % w; for (const k of [xx > 0 ? j - 1 : -1, xx < w - 1 ? j + 1 : -1, j - w, j + w]) if (k >= 0 && k < w * h && m[k] && lab[k] < 0) { lab[k] = sizes.length; q.push(k); } } sizes.push(c); }
  sizes.sort((a, b) => b - a);
  // 轮廓内破洞：不透明外框内、与外框边界不连通的透明像素
  const out = new Uint8Array(bw * bh), q = [];
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if ((x === 0 || y === 0 || x === bw - 1 || y === bh - 1) && !m[(y + y0) * w + x + x0]) { out[y * bw + x] = 1; q.push(y * bw + x); }
  while (q.length) { const j = q.pop(), xx = j % bw, yy = (j / bw) | 0; for (const [ax, ay] of [[xx + 1, yy], [xx - 1, yy], [xx, yy + 1], [xx, yy - 1]]) { if (ax < 0 || ay < 0 || ax >= bw || ay >= bh) continue; const k = ay * bw + ax; if (!out[k] && !m[(ay + y0) * w + ax + x0]) { out[k] = 1; q.push(k); } } }
  let holes = 0; for (let i = 0; i < bw * bh; i++) if (!out[i] && !m[(((i / bw) | 0) + y0) * w + (i % bw) + x0]) holes++;
  return {
    fill: n / (w * h),
    faint: Math.max(y0 - fy0, fy1 - y1) / bh + Math.max(x0 - fx0, fx1 - x1) / bw,
    small: (n - sizes[0]) / n,
    holes: holes / n,
    edge: [x0 === 0 ? 'L' : '', x1 === w - 1 ? 'R' : '', y0 === 0 ? 'T' : '', y1 === h - 1 ? 'B' : ''].join(''),
    box: [x0, y0, x1, y1], bw, bh,
  };
}

// ─── 嘴：上下唇组内比例 ───
const mouthRatio = (tex) => { const u = integrity(img(tex[AID.mouth_up])), d = integrity(img(tex[AID.mouth_down])); return { wr: d.bw / u.bw, hr: u.bh / d.bh }; };

// ─── 眼眶：E1 朝向（和模板正/翻转 IoU 之差）、E2 眼白面积 ───
const N = 48;
function maskOf(t, flip = false) {
  const s = integrity(t), [x0, y0] = s.box, m = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const sx = Math.round(x0 + ((flip ? N - 1 - x : x) + 0.5) / N * s.bw - 0.5), sy = Math.round(y0 + (y + 0.5) / N * s.bh - 0.5); m[y * N + x] = A(t, Math.min(t.w - 1, sx), Math.min(t.h - 1, sy)) >= 128 ? 1 : 0; }
  return m;
}
const iou = (a, b) => { let i = 0, u = 0; for (let k = 0; k < a.length; k++) { i += a[k] & b[k]; u += a[k] | b[k]; } return u ? i / u : 0; };
const flipTex = (t) => { const d = new Uint8Array(t.d.length); for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) for (let c = 0; c < 4; c++) d[(y * t.w + x) * 4 + c] = t.d[(y * t.w + (t.w - 1 - x)) * 4 + c]; return { ...t, d }; };
const e1 = (t, tpl) => iou(maskOf(t), maskOf(tpl)) - iou(maskOf(t), maskOf(tpl, true));
function eyeWhite(t) { let n = 0, op = 0; for (let i = 0; i < t.w * t.h; i++) { const k = i * 4; if (t.d[k + 3] < 128) continue; op++; const r = t.d[k], g = t.d[k + 1], b = t.d[k + 2]; if (Math.min(r, g, b) >= 170 && Math.max(r, g, b) - Math.min(r, g, b) <= 45) n++; } return n; }

// ─── 瞳孔：P1 虹膜颜色 Δab ───
function irisColorTex(t) {
  const s = integrity(t), [x0, y0, x1, y1] = s.box, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, r = Math.min(s.bw, s.bh) / 2, px = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const q = Math.hypot(x - cx, y - cy) / r; if (q < 0.5 || q > 0.85 || A(t, x, y) < 128) continue; const k = (y * t.w + x) * 4; px.push(toLab([t.d[k], t.d[k + 1], t.d[k + 2]])); }
  return labMed(px);
}
function labMed(px) {
  px = px.filter((l) => l[0] <= 90).sort((a, b) => a[0] - b[0]); px = px.slice(Math.floor(px.length * 0.15));
  if (px.length < 50) return null;
  return [0, 1, 2].map((c) => med(px.map((l) => l[c])));
}
function irisColorMaster(mi, eye) {
  if (!eye?.box) return null;
  const [x0, y0, x1, y1] = eye.box, eh = y1 - y0 + 1, px = [];
  const white = (k) => { const r = mi.d[k], g = mi.d[k + 1], b = mi.d[k + 2]; return Math.min(r, g, b) >= 170 && Math.max(r, g, b) - Math.min(r, g, b) <= 45; };
  for (let y = Math.max(y0, Math.round(eye.irisRow - 0.2 * eh)); y <= Math.min(y1, Math.round(eye.irisRow + 0.2 * eh)); y++) {
    // 这一行眼白段之间的最长间隔 = 虹膜
    const row = []; for (let x = x0; x <= x1; x++) row.push(white((y * mi.w + x) * 4));
    let first = row.indexOf(true), last = row.lastIndexOf(true); if (first < 0) continue;
    for (let x = first; x <= last; x++) if (!row[x]) { const k = (y * mi.w + x0 + x) * 4; px.push(toLab([mi.d[k], mi.d[k + 1], mi.d[k + 2]])); }
  }
  return labMed(px);
}
const dab = (a, b) => Math.hypot(a[1] - b[1], a[2] - b[2]);
const chroma = (l) => Math.hypot(l[1], l[2]);

// ─── 面部：F1 脸宽÷脸长（代码量）、F3 肤色 ΔE ───
function faceMetrics(t, noseRel) {
  const s = integrity(t), [x0, y0, x1, y1] = s.box, cxt = (x0 + x1) / 2;
  const lum = (x, y) => { const k = (y * t.w + x) * 4; return t.d[k + 3] < 128 ? 255 : 0.3 * t.d[k] + 0.59 * t.d[k + 1] + 0.11 * t.d[k + 2]; };
  const browOf = (xa, xb) => { let best = 1e9, by = -1; for (let y = Math.round(y0 + 0.25 * s.bh); y < y0 + 0.55 * s.bh; y++) { const v = []; for (let x = xa; x < xb; x++) v.push(lum(x, y)); v.sort((a, b) => a - b); const n = Math.max(4, v.length >> 3), m = v.slice(0, n).reduce((a, c) => a + c, 0) / n; if (m < best) { best = m; by = y; } } return by; };
  const by = (browOf(Math.round(x0 + 0.08 * s.bw), Math.round(cxt - 3)) + browOf(Math.round(cxt + 3), Math.round(x1 - 0.08 * s.bw))) / 2, fl = y1 - by;
  const row = Math.round(by + fl * noseRel); let a = -1, c = -1; for (let x = 0; x < t.w; x++) if (A(t, x, row) >= 128) { if (a < 0) a = x; c = x; }
  const fw = c - a + 1;
  const px = []; for (const sx of [-1, 1]) for (let dx = -0.03; dx <= 0.03; dx += 0.005) for (let dy = -0.04; dy <= 0.04; dy += 0.005) { const x = Math.round(cxt + sx * 0.3 * fw + dx * fw), y = Math.round(by + fl * noseRel - 0.12 * fl + dy * fl); if (x < 0 || y < 0 || x >= t.w || y >= t.h || A(t, x, y) < 128) continue; const k = (y * t.w + x) * 4; px.push(toLab([t.d[k], t.d[k + 1], t.d[k + 2]])); }
  return { F1: fw / fl, skin: [0, 1, 2].map((i) => med(px.map((l) => l[i]))) };
}
function faceMaster(mi, pts, s) {
  const Q = (n, i) => P(pts, n, i) * s, browY = (Q('brow_l', 1) + Q('brow_r', 1)) / 2, chin = Q('chin', 1), nose = Q('nose', 1), FL = chin - browY, FW = Q('cheek_r', 0) - Q('cheek_l', 0), cx = (Q('cheek_l', 0) + Q('cheek_r', 0)) / 2;
  const px = []; for (const sx of [-1, 1]) for (let dx = -0.03; dx <= 0.03; dx += 0.005) for (let dy = -0.04; dy <= 0.04; dy += 0.005) { const x = Math.round(cx + sx * 0.3 * FW + dx * FW), y = Math.round(nose - 0.12 * FL + dy * FL); const k = (y * mi.w + x) * 4; px.push(toLab([mi.d[k], mi.d[k + 1], mi.d[k + 2]])); }
  return { F1: FW / FL, noseRel: (nose - browY) / FL, skin: [0, 1, 2].map((i) => med(px.map((l) => l[i]))) };
}

// ─── 通用相对淘汰：误差 > abs 且比同批最好的差 ≥ rel ───
const relCut = (errs, abs, rel) => { const best = Math.min(...errs.filter(Number.isFinite)); return errs.map((e) => Number.isFinite(e) && e > abs && e - best >= rel); };

// ═══ 跑 ═══
const R = { integrity: [], mouth: [], e1: [], e2: [], p1: [], face: [] };
const raw = readJson('results/metric-check/raw.json'), PTS = { ...Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.slice(0, 8), v.master])), dfb3bc24: JSON.parse(fs.readFileSync('/tmp/master-pts.json', 'utf8')) };
for (const p of PROJ) {
  const mi = fs.existsSync(`/tmp/vm17/p1/m/${p}.png`) ? decode(fs.readFileSync(`/tmp/vm17/p1/m/${p}.png`)) : null;
  for (const [c, { list, template }] of Object.entries(sets[p])) {
    // ① 完整性：每张每个贴图
    for (const aid of Object.keys(list[0].tex)) {
      const tp = template[aid] ? integrity(img(template[aid])) : null;
      for (const it of list) if (it.tex[aid]) R.integrity.push({ p, c, aid, name: it.name, ...integrity(img(it.tex[aid])), tplEdge: tp?.edge ?? '', tpl: tp });
    }
    if (c === 'mouth' && template[AID.mouth_up]) {
      const tr = mouthRatio(template);
      for (const it of list) if (it.tex[AID.mouth_up] && it.tex[AID.mouth_down]) R.mouth.push({ p, name: it.name, ...mouthRatio(it.tex), tpl: tr });
    }
    if (c === 'sclera' && template[AID.sclera]) {
      const tpl = img(template[AID.sclera]), tw = eyeWhite(tpl);
      for (const it of list) { const t = img(it.tex[AID.sclera]); R.e1.push({ p, name: it.name, e1: e1(t, tpl), e1flip: e1(flipTex(t), tpl) }); R.e2.push({ p, name: it.name, white: eyeWhite(t) / tw }); }
    }
    if (c === 'pupil' && mi) {
      const mc = irisColorMaster(mi, dump[p].eye);
      for (const it of list) { const l = irisColorTex(img(it.tex[AID.pupil])); R.p1.push({ p, name: it.name, master: mc, lab: l, dab: mc && l ? dab(l, mc) : NaN, skip: !mc ? '主图虹膜量不出' : chroma(mc) < 10 || (l && chroma(l) < 10) ? '彩度<10' : '' }); }
    }
    if (c === 'head' && mi && PTS[p]) {
      const fm = faceMaster(mi, PTS[p], dump[p].masterScale);
      for (const it of list) { const f = faceMetrics(img(it.tex[AID.head]), fm.noseRel); R.face.push({ p, name: it.name, F1err: Math.abs(f.F1 / fm.F1 - 1), F1signed: f.F1 / fm.F1 - 1, dE: Math.hypot(...f.skin.map((v, i) => v - fm.skin[i])) }); }
    }
  }
}

// ═══ 报告 ═══
const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : '-');
const L = [];
L.push('## ① 完整性检查（各指标：数值 / 模板）');
const byComp = {}; for (const r of R.integrity) (byComp[`${r.c}/${r.aid}`] ??= []).push(r);
const flags = [];
for (const [k, rows] of Object.entries(byComp)) {
  for (const f of ['fill', 'faint', 'small', 'holes']) {
    const vals = rows.map((r) => r[f]);
    for (const r of rows) {
      const batch = med(rows.filter((x) => x.p === r.p).map((x) => x[f])), tv = r.tpl?.[f];
      // 离群：相对模板和同批中位数都偏离（比值 > 1.5 或 < 1/1.5，且绝对差超过该指标全体的极差 10%）
      const span = Math.max(...vals) - Math.min(...vals), out = (ref) => Number.isFinite(ref) && Math.abs(r[f] - ref) > Math.max(span * 0.1, 0.01) && (r[f] / (ref || 1e-6) > 1.5 || r[f] / (ref || 1e-6) < 1 / 1.5);
      if (out(tv) && out(batch)) flags.push(`${r.p} ${k} ${r.name} ${f}=${r[f].toFixed(3)}（模板 ${tv?.toFixed(3)}，同批中位 ${batch.toFixed(3)}）`);
    }
  }
  for (const r of rows) if (r.edge.split('').some((e) => e && !r.tplEdge.includes(e))) flags.push(`${r.p} ${k} ${r.name} 贴画布边 ${r.edge}（模板 ${r.tplEdge || '无'}）`);
}
L.push(`共 ${R.integrity.length} 张贴图，标出 ${flags.length} 条：`, ...flags.map((f) => '- ' + f));
L.push('', '## 嘴：上下唇组内比例（下唇宽÷上唇宽 wr，上唇厚÷下唇厚 hr；淘汰=同时偏离模板和同批中位 >15%）');
for (const p of PROJ) { const rows = R.mouth.filter((r) => r.p === p); if (!rows.length) continue; const mw = med(rows.map((r) => r.wr)), mh = med(rows.map((r) => r.hr)); for (const r of rows) { const cut = ['wr', 'hr'].some((k) => Math.abs(r[k] / r.tpl[k] - 1) > 0.15 && Math.abs(r[k] / (k === 'wr' ? mw : mh) - 1) > 0.15); L.push(`- ${p} ${r.name} wr=${r.wr.toFixed(2)} hr=${r.hr.toFixed(2)}（模板 ${r.tpl.wr.toFixed(2)} / ${r.tpl.hr.toFixed(2)}）${cut ? ' ← 淘汰' : ''}`); } }
L.push('', '## 眼眶 E1 朝向（IoU 正 − IoU 翻；≤ −0.08 判画反）及人为翻转后的值');
for (const r of R.e1) L.push(`- ${r.p} ${r.name} 原样 ${r.e1.toFixed(3)}${r.e1 <= -0.08 ? ' ← 误判画反' : ''}，翻转后 ${r.e1flip.toFixed(3)}${r.e1flip <= -0.08 ? '（能判出）' : '（判不出）'}`);
L.push('', '## 眼眶 E2 眼白面积 ÷ 模板（< 0.5 淘汰）');
for (const r of R.e2) L.push(`- ${r.p} ${r.name} ${r.white.toFixed(2)}${r.white < 0.5 ? ' ← 淘汰' : ''}`);
L.push('', '## 瞳孔 P1 虹膜颜色 Δab（淘汰 = Δab>25 且比最好的大 ≥10）');
for (const p of PROJ) { const rows = R.p1.filter((r) => r.p === p); if (!rows.length) continue; const cut = relCut(rows.map((r) => (r.skip ? NaN : r.dab / 100)), 0.25, 0.10); rows.forEach((r, i) => L.push(`- ${p} ${r.name} ${r.skip ? '跳过：' + r.skip : 'Δab=' + r.dab.toFixed(1)}${cut[i] ? ' ← 淘汰' : ''}`)); }
L.push('', '## 面部 F1 脸宽÷脸长（代码量，误差 >12% 且比最好的差 ≥10 个点淘汰）、F3 肤色 ΔE（>12 且比最好的大 ≥6 淘汰）');
for (const p of PROJ) { const rows = R.face.filter((r) => r.p === p); if (!rows.length) continue; const c1 = relCut(rows.map((r) => r.F1err), 0.12, 0.10), c3 = relCut(rows.map((r) => r.dE / 100), 0.12, 0.06); rows.forEach((r, i) => L.push(`- ${p} ${r.name} F1 ${r.F1signed >= 0 ? '+' : ''}${pct(r.F1signed)}${c1[i] ? ' ← 淘汰' : ''}，ΔE ${r.dE.toFixed(1)}${c3[i] ? ' ← 淘汰' : ''}`)); }
fs.writeFileSync(labPath('results/v17-offline.md'), L.join('\n'));
console.log(L.join('\n'));

// ─── 完整性：按"正常最大值 × 1.5"定阈值（每个指标在全部贴图上，排除最大的那一个后取最大值）───
console.log('\n## 完整性各指标分布（全部贴图）');
for (const f of ['fill', 'faint', 'small', 'holes']) {
  const v = R.integrity.map((r) => ({ r, x: r[f] })).sort((a, b) => b.x - a.x);
  console.log(f, 'top5', v.slice(0, 5).map(({ r, x }) => `${r.p}/${r.c}/${r.name}=${x.toFixed(3)}`).join('  '), ' 第2大×1.5=', (v[1].x * 1.5).toFixed(3));
}
