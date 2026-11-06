// v21 标点验证：两步标点（先基础点定行，再在行上标脸 / 头发边缘和上下唇），主图和 riv 各标 N 次，riv 侧附代码量的参考答案。
// 用法：GATEWAY=agent node scripts/points-v21-test.mjs <项目完整 id> <结果目录（含 trace.json，可选 textures.json）> [次数 3]
// 产出 results/points-v21/<项目前 8 位>/：points.json、标了点的图（整图 + 头部放大）
import fs from 'node:fs';
import { openLab, projectInput, writeJson, labPath } from './lab.mjs';
import { locate, POINTS_WHITE } from './landmarks.mjs';
import { LLM_URL, LLM_KEY, maxTok, postJson } from './gateway.mjs';
import { logUsage, setUsageTag } from './usage.mjs';

const [ID, RUN_DIR, NS = '3'] = process.argv.slice(2);
const N = Number(NS), MODEL = 'gpt-6.1-sol', OUT = `results/points-v21/${ID.slice(0, 8)}`;
setUsageTag(`points-v21/${ID.slice(0, 8)}`);
fs.mkdirSync(labPath(OUT), { recursive: true });

// 第二步要标的点：行上的边缘只给 x，上下唇给 [x, y]
const ROW_POINTS = {
  hair_brow_l: ['brow', '这条线上，整团头发（前发、后发、鬓发都算）在画面左侧的最外边缘'],
  hair_brow_r: ['brow', '这条线上，整团头发在画面右侧的最外边缘'],
  hair_eye_l: ['eye', '这条线上，整团头发在画面左侧的最外边缘'],
  hair_eye_r: ['eye', '这条线上，整团头发在画面右侧的最外边缘'],
  face_eye_l: ['eye', '这条线上，看得见的脸部皮肤在画面左侧的最外边缘（不含耳朵；被头发、耳机等挡住时取看得见的皮肤边缘）'],
  face_eye_r: ['eye', '这条线上，看得见的脸部皮肤在画面右侧的最外边缘（同上）'],
  face_mouth_l: ['mouth', '这条线上，看得见的脸部皮肤在画面左侧的最外边缘（同上）'],
  face_mouth_r: ['mouth', '这条线上，看得见的脸部皮肤在画面右侧的最外边缘（同上）'],
};
const LIP_POINTS = { lip_top: '上唇上沿的正中点（两个唇峰之间的凹点）', lip_bottom: '下唇下沿的正中点' };
const LINE_LABEL = { brow: 'A 眉毛行（红）', eye: 'B 眼睛行（绿）', mouth: 'C 嘴行（蓝）' };
const LINE_COLOR = { brow: '#e6194b', eye: '#3cb44b', mouth: '#4363d8' };

/** 第一步的基础点 → 各行 y：眼睛行 = 两眼中心平均；眉毛行 = 眼睛行往上「眼到鼻底」那么远；嘴行 = 两嘴角平均 */
const rowsOf = (p) => {
  const ok = (k) => Array.isArray(p?.[k]);
  if (!ok('eye_l') || !ok('eye_r') || !ok('nose')) return null;
  const eye = (p.eye_l[1] + p.eye_r[1]) / 2, nose = p.nose[1];
  return { brow: eye - (nose - eye), eye, nose, mouth: ok('mouth_l') && ok('mouth_r') ? (p.mouth_l[1] + p.mouth_r[1]) / 2 : null };
};

const lab = await openLab();
// 在图上画水平线和标签
const drawLines = (png, rows) => lab.page.evaluate(async ([png, rows, LINE_LABEL, LINE_COLOR]) => {
  const bm = await createImageBitmap(new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], { type: 'image/png' }));
  const c = new OffscreenCanvas(bm.width, bm.height), g = c.getContext('2d'); g.drawImage(bm, 0, 0);
  for (const [k, y] of Object.entries(rows)) { if (!LINE_LABEL[k] || y == null) continue; g.strokeStyle = LINE_COLOR[k]; g.lineWidth = 1; g.beginPath(); g.moveTo(0, y); g.lineTo(bm.width, y); g.stroke(); g.fillStyle = LINE_COLOR[k]; g.font = 'bold 14px sans-serif'; g.fillText(LINE_LABEL[k], 4, y - 4); }
  const b = await c.convertToBlob({ type: 'image/png' }); const u = new Uint8Array(await b.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode(...u.subarray(i, i + 32768)); return btoa(s);
}, [png, rows, LINE_LABEL, LINE_COLOR]);

async function step2(png, W, H, rows) {
  const lines = Object.entries(LINE_LABEL).map(([k, l]) => `- ${l}：y = ${Math.round(rows[k])}`).join('\n');
  const text = `这是一张 ${W}×${H} 像素的 2D 角色图，图上画了几条水平线：\n${lines}\n"左/右"指画面左右。下面这些点都在对应的线上，只给 x 坐标（整数）；看不到的给 null，不要猜：\n${Object.entries(ROW_POINTS).map(([k, [line, d]]) => `- ${k}（${LINE_LABEL[line]}）：${d}`).join('\n')}\n另外给出这两个点的 [x, y]：\n${Object.entries(LIP_POINTS).map(([k, d]) => `- ${k}：${d}`).join('\n')}\n只输出 JSON：{"hair_brow_l":x,...,"lip_top":[x,y],"lip_bottom":[x,y]}`;
  for (let attempt = 1; attempt <= 8; attempt++) {
    const t0 = Date.now();
    const r = await postJson(LLM_URL, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` }, body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }] }], response_format: { type: 'json_object' }, ...maxTok(3000) }), signal: AbortSignal.timeout(180000) });
    if (r.ok) { logUsage('landmark-rows', MODEL, r.data.usage, { ms: Date.now() - t0 }); try { return JSON.parse(r.data.choices[0].message.content); } catch { return null; } }
    if (r.status === 429) { await new Promise((o) => setTimeout(o, 20000)); continue; }
    await new Promise((o) => setTimeout(o, 5000 * attempt));
  }
  return null;
}

// 结果画图：点（第 1 次红、2 次绿、3 次蓝）+ 行线；crop 为头部放大框
const drawPoints = (png, sets, rowsList, crop) => lab.page.evaluate(async ([png, sets, rowsList, crop]) => {
  const bm = await createImageBitmap(new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], { type: 'image/png' }));
  const [x0, y0, w, h] = crop ?? [0, 0, bm.width, bm.height], k = crop ? Math.max(1, Math.round(900 / w)) : 1;
  const c = new OffscreenCanvas(w * k, h * k), g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.drawImage(bm, x0, y0, w, h, 0, 0, w * k, h * k);
  const colors = ['#e6194b', '#3cb44b', '#4363d8', '#ff9900'];
  rowsList.forEach((rows, i) => { g.strokeStyle = colors[i % 4]; g.globalAlpha = 0.35; for (const y of Object.values(rows)) { if (y == null) continue; g.beginPath(); g.moveTo(0, (y - y0) * k); g.lineTo(w * k, (y - y0) * k); g.stroke(); } g.globalAlpha = 1; });
  sets.forEach((pts, i) => { for (const [n, p] of Object.entries(pts || {})) { if (!Array.isArray(p)) continue; const px = (p[0] - x0) * k, py = (p[1] - y0) * k; g.fillStyle = colors[i % 4]; g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.arc(px, py, n.startsWith('ref:') ? 7 : 4, 0, 7); if (n.startsWith('ref:')) { g.lineWidth = 2.5; g.strokeStyle = '#ff9900'; g.stroke(); } else { g.fill(); g.stroke(); } } });
  const b = await c.convertToBlob({ type: 'image/png' }); const u = new Uint8Array(await b.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode(...u.subarray(i, i + 32768)); return btoa(s);
}, [png, sets, rowsList, crop]);

try {
  const trace = JSON.parse(fs.readFileSync(labPath(`${RUN_DIR}/trace.json`), 'utf8'));
  await lab.call('loadProject', projectInput(ID));
  await lab.call('loadMaster');
  if (fs.existsSync(labPath(`${RUN_DIR}/textures.json`))) await lab.call('restoreTextures', JSON.parse(fs.readFileSync(labPath(`${RUN_DIR}/textures.json`), 'utf8')));
  const imgs = { master: await lab.call('masterForPoints'), riv: await lab.call('rivForPoints', trace.finalVm) };
  const out = { id: ID, runDir: RUN_DIR, model: MODEL, defs: { base: POINTS_WHITE, rows: ROW_POINTS, lips: LIP_POINTS }, master: [], riv: [], rivRef: null };
  for (const side of ['master', 'riv']) {
    const im = imgs[side];
    const runs = await Promise.all(Array.from({ length: N }, async () => {
      const base = await locate(MODEL, im, POINTS_WHITE);
      const rows = rowsOf(base);
      if (!rows) return { base, rows: null, row: null };
      const row = await step2(await drawLines(im.png, rows), im.W, im.H, rows);
      return { base, rows, row };
    }));
    out[side] = runs;
    console.log(side, runs.map((r) => (r.row ? 'ok' : r.base ? '第二步失败' : '第一步失败')).join(' '));
  }
  // riv 参考答案：用第 1 次 riv 标点定的行，代码在图层上量
  const r0 = out.riv.find((r) => r.rows)?.rows;
  if (r0) out.rivRef = { rows: r0, edges: await lab.call('rowEdges', trace.finalVm, { brow: r0.brow, eye: r0.eye, nose: r0.nose, mouth: r0.mouth }) };
  writeJson(`${OUT}/points.json`, out);

  // 画图：每次标点的所有点合成一组（行上的点 y 取对应行）
  const asPts = (r) => { if (!r?.base) return {}; const p = { ...r.base }; if (r.row && r.rows) { for (const [k, [line]] of Object.entries(ROW_POINTS)) if (Number.isFinite(r.row[k])) p[k] = [r.row[k], r.rows[line]]; for (const k of Object.keys(LIP_POINTS)) if (Array.isArray(r.row[k])) p[k] = r.row[k]; } return p; };
  const refPts = (ref) => { if (!ref) return {}; const p = {}; for (const [line, e] of Object.entries(ref.edges)) { if (!e) continue; if (e.face) { p[`ref:face_${line}_l`] = [e.face[0], ref.rows[line]]; p[`ref:face_${line}_r`] = [e.face[1], ref.rows[line]]; } if (e.hair) { p[`ref:hair_${line}_l`] = [e.hair[0], ref.rows[line]]; p[`ref:hair_${line}_r`] = [e.hair[1], ref.rows[line]]; } } return p; };
  const headBox = (runs, W, H) => { const ps = runs.flatMap((r) => Object.values(asPts(r)).filter(Array.isArray)); const b = runs[0]?.base; if (!b?.chin || !b?.head_top) return null; const xs = ps.map((p) => p[0]), x0 = Math.max(0, Math.min(...xs) - 30), x1 = Math.min(W, Math.max(...xs) + 30), y0 = Math.max(0, b.head_top[1] - 20), y1 = Math.min(H, b.chin[1] + 40); return [Math.round(x0), Math.round(y0), Math.round(x1 - x0), Math.round(y1 - y0)]; };
  for (const side of ['master', 'riv']) {
    const sets = out[side].map(asPts), rowsList = out[side].map((r) => r.rows).filter(Boolean);
    if (side === 'riv') sets.push(refPts(out.rivRef));
    fs.writeFileSync(labPath(`${OUT}/${side}-full.png`), Buffer.from(await drawPoints(imgs[side].png, sets, rowsList, null), 'base64'));
    const box = headBox(out[side], imgs[side].W, imgs[side].H);
    if (box) fs.writeFileSync(labPath(`${OUT}/${side}-head.png`), Buffer.from(await drawPoints(imgs[side].png, sets, rowsList, box), 'base64'));
  }
  console.log('saved', OUT);
} finally { await Promise.race([lab.close(), new Promise((o) => setTimeout(o, 15000))]); }
process.exit(0);
