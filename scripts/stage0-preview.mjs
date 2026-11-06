// v21 阶段 0：反事实预览（零模型费用）。在 2e70e494 的 v20 最终参数上，每张只改一个因素，按同一取景渲染给用户看：
//   C4 起点；V20 最终；C1 头整体缩约 9%（脖子比例不变）；C2 眼高按宽高比降约 8%；
//   C3a / C3b v21 构图：身体按模板原始身体贴图的肩宽 / 肩线 / 中线，脸回起点，Head_scale 分别按「共识中位数」「鼻底行脸宽」对主图的头身比，Head_Y 对主图脖子比例
// riv 侧全部用代码按图层量，用 v20 最终那一刻的 AI 标点（results/points-v21/2e70e494/points.json）标定口径；主图用同一文件里 AI 标点的中位数
// 用法：node scripts/stage0-preview.mjs  → results/stage0/2e70e494/（图、numbers.json）和 results/human/e2e/2e70e494-stage0.html
import fs from 'node:fs';
import { openLab, projectInput, writeJson, labPath } from './lab.mjs';

const ID = '2e70e494-da6d-40bf-ab72-5bc89cdd8e55', OUT = 'results/stage0/2e70e494', BODY_ASSET = '6845564';
const t = JSON.parse(fs.readFileSync(labPath('results/agent/v20/2e70e494/trace.json'), 'utf8'));
const P = JSON.parse(fs.readFileSync(labPath('results/points-v21/2e70e494/points.json'), 'utf8'));
fs.mkdirSync(labPath(OUT), { recursive: true });
const med = (a) => { a = a.filter(Number.isFinite).sort((x, y) => x - y); return a[a.length >> 1]; };

// ── 主图目标（AI 3 次中位数）和 v20 最终 riv 的 AI 值（标定用）──
const ai = (side) => {
  const R = P[side], b = (k, i) => med(R.map((r) => r.base[k][i])), row = (k) => med(R.map((r) => r.row[k])), rows = (k) => med(R.map((r) => r.rows[k]));
  const eye = rows('eye'), chin = b('chin', 1), shY = (b('shoulder_l', 1) + b('shoulder_r', 1)) / 2;
  return { shoulderW: b('shoulder_r', 0) - b('shoulder_l', 0), fwEye: row('face_eye_r') - row('face_eye_l'), fwNose: b('cheek_r', 0) - b('cheek_l', 0), L: chin - eye, neck: shY - chin, eye, nose: rows('nose'), chin };
};
const M = ai('master'), V = ai('riv');
const TARGET = { eye: M.shoulderW / M.fwEye, nose: M.shoulderW / M.fwNose, L: M.shoulderW / M.L, neck: M.neck / M.L };

const lab = await openLab();
try {
  await lab.call('loadProject', projectInput(ID));
  await lab.call('loadMaster');
  const projTex = await lab.call('textureSnapshot');
  // 行锚定在脸部贴图上：v20 最终时眼睛行、鼻底行在脸部图层外框里的相对高度（脸部贴图上的位置，不随眼睛图层动）
  const h0 = await lab.call('soloGeom', t.finalVm, 'head');
  const REL = { eye: (V.eye - h0.y0) / h0.h, nose: (V.nose - h0.y0) / h0.h };
  // riv 代码量：肩宽、肩线 y、下巴 y、两行脸宽、脸长 L（锚定眼睛行到下巴）
  const codeMeasure = async (vm) => {
    const [h, b] = [await lab.call('soloGeom', vm, 'head'), await lab.call('soloGeom', vm, 'body')];
    const eyeY = h.y0 + REL.eye * h.h, noseY = h.y0 + REL.nose * h.h;
    const e = await lab.call('rowEdges', vm, { eye: eyeY, nose: noseY });
    const fw = (r) => (r?.face ? r.face[1] - r.face[0] + 1 : NaN);
    return { shoulderW: b.shoulderW, shoulderY: b.shoulderY, shoulderCx: b.shoulderCx, chin: h.y1 + 1, fwEye: fw(e.eye), fwNose: fw(e.nose), L: h.y1 + 1 - eyeY, eyeY };
  };
  // 口径标定：v20 最终那一刻 AI ÷ 代码（宽度、长度按比例），肩线和下巴的距离按比例标定
  const C0 = await codeMeasure(t.finalVm);
  const K = { shoulderW: V.shoulderW / C0.shoulderW, fwEye: V.fwEye / C0.fwEye, fwNose: V.fwNose / C0.fwNose, L: V.L / C0.L, neck: V.neck / (C0.shoulderY - C0.chin) };
  const est = (c) => ({ eye: (c.shoulderW * K.shoulderW) / (c.fwEye * K.fwEye), nose: (c.shoulderW * K.shoulderW) / (c.fwNose * K.fwNose), L: (c.shoulderW * K.shoulderW) / (c.L * K.L), neck: ((c.shoulderY - c.chin) * K.neck) / (c.L * K.L) });
  const errs = (c) => { const e = est(c); return Object.fromEntries(Object.keys(TARGET).map((k) => [k, (e[k] - TARGET[k]) / TARGET[k]])); };

  // 二分：f(x) 单调，找 f = 0
  const solve = async (f, lo, hi, step) => {
    let flo = await f(lo), fhi = await f(hi);
    if (Math.sign(flo) === Math.sign(fhi)) return Math.abs(flo) < Math.abs(fhi) ? lo : hi;
    while (hi - lo > step) { const mid = (lo + hi) / 2, fm = await f(mid); if (Math.sign(fm) === Math.sign(flo)) { lo = mid; flo = fm; } else { hi = mid; fhi = fm; } }
    return Math.round(((lo + hi) / 2) / step) * step;
  };
  // 给定 Head_scale，解 Head_Y 让脖子比例 = 目标
  const fitHeadY = (vm, target) => solve(async (y) => errs(await codeMeasure({ ...vm, Head_Y: y })).neck - (target ?? 0), -150, 150, 1);

  // ── 模板原始身体贴图：默认参数下的肩宽、肩线、肩中点 ──
  const tpl = await lab.call('templateTextures');
  await lab.call('restoreTextures', { ...projTex, [BODY_ASSET]: tpl[BODY_ASSET] });
  const tplBody = await lab.call('soloGeom', t.startVm, 'body');
  await lab.call('restoreTextures', projTex);

  const VMS = { C4: { ...t.startVm }, V20: { ...t.finalVm } };
  // C1：头整体缩到共识（三把尺子偏差的中位数），脖子比例保持 v20 最终时的值
  const v20e = errs(C0), cons = med([v20e.eye, v20e.nose, v20e.L]);
  const c1Head = Math.round(100 * (1 + cons));  // 比例是「肩宽 ÷ 头」：头小 1% → 比例大 1%，所以偏差为负（头偏大）就按同样比例缩头
  VMS.C1 = { ...t.finalVm, Head_scale: c1Head };
  VMS.C1.Head_Y = await fitHeadY(VMS.C1, v20e.neck);
  // C2：眼高按宽高比（主图 0.404 / riv 0.438，points.json 中位数）
  const ar = (side) => med(P[side].map((r) => (r.base.eye_l_bottom[1] - r.base.eye_l_top[1]) / Math.abs(r.base.eye_l_inner[0] - r.base.eye_l_outer[0])));
  VMS.C2 = { ...t.finalVm, Eye_scale_Y: Math.round(t.finalVm.Eye_scale_Y * ar('master') / ar('riv')) };
  // C3：身体按模板原始构图（肩宽 → Body_scale，肩线 → Body_Y，肩中点 → Body_X），脸回起点
  let c3 = { ...t.finalVm, Face_scale: t.startVm.Face_scale, Face_Y: t.startVm.Face_Y };
  c3.Body_scale = await solve(async (s) => (await lab.call('soloGeom', { ...c3, Body_scale: s }, 'body')).shoulderW - tplBody.shoulderW, 50, 300, 1);
  c3.Body_Y = await solve(async (y) => (await lab.call('soloGeom', { ...c3, Body_Y: y }, 'body')).shoulderY - tplBody.shoulderY, -200, 200, 1);
  c3.Body_X = await solve(async (x) => (await lab.call('soloGeom', { ...c3, Body_X: x }, 'body')).shoulderCx - tplBody.shoulderCx, -200, 200, 1);
  // Head_scale：共识 = 三把尺子偏差的中位数为 0；鼻底行 = 只看鼻底行脸宽。每个 Head_scale 先解 Head_Y 对主图脖子
  const headFit = async (mode) => {
    const f = async (s) => { const v = { ...c3, Head_scale: s }; v.Head_Y = await fitHeadY(v, 0); const e = errs(await codeMeasure(v)); return mode === 'consensus' ? med([e.eye, e.nose, e.L]) : e[mode]; };
    const s = await solve(f, 50, 200, 1); const v = { ...c3, Head_scale: s }; v.Head_Y = await fitHeadY(v, 0); return v;
  };
  VMS.C3a = await headFit('consensus');
  VMS.C3b = await headFit('nose');
  VMS.C3c = await headFit('eye');   // 只用眼睛行脸宽
  VMS.C3d = await headFit('L');     // 只用脸长

  // ── 同一取景渲染 ──
  const boxes = []; for (const v of Object.values(VMS)) boxes.push(await lab.call('contentBox', v));
  const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y)), x1 = Math.max(...boxes.map((b) => b.x + b.w)), y1 = Math.max(...boxes.map((b) => b.y + b.h));
  await lab.call('setFrame', { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  const numbers = { target: TARGET, calibration: K, templateBody: tplBody, cases: {} };
  for (const [k, vm] of Object.entries(VMS)) {
    const c = await codeMeasure(vm), e = errs(c);
    const im = await lab.call('judgeImages', vm);
    for (const part of ['full', 'grid', 'eyes']) if (im[part]) fs.writeFileSync(labPath(`${OUT}/${k}-${part}.png`), Buffer.from(im[part], 'base64'));
    const changed = Object.fromEntries(['Head_scale', 'Head_Y', 'Body_scale', 'Body_Y', 'Body_X', 'Face_scale', 'Face_Y', 'Eye_scale_Y'].map((n) => [n, vm[n]]));
    numbers.cases[k] = { params: changed, errors: e, shoulderW_vs_template: c.shoulderW / tplBody.shoulderW - 1 };
    console.log(k.padEnd(4), JSON.stringify(changed), '| 头身偏差 眼行', (e.eye * 100).toFixed(1) + '% 鼻底行', (e.nose * 100).toFixed(1) + '% 脸长', (e.L * 100).toFixed(1) + '% 脖子', (e.neck * 100).toFixed(1) + '%');
  }
  writeJson(`${OUT}/numbers.json`, numbers);
} finally { await Promise.race([lab.close(), new Promise((o) => setTimeout(o, 15000))]); }
process.exit(0);
