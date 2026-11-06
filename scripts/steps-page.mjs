// 临时看图页：讲解 v21 每一步时，把这一步用到的点画在图上（只画基于点的步骤）。不调模型：AI 点取已有的 results/points-v21/2e70e494/points.json（3 次中位数），代码点现场按图层量。
// 用法：node scripts/steps-page.mjs <步骤：body | head>  → results/human/steps/index.html（每次覆盖，只显示当前这一步），http://localhost:5260/steps/index.html
import fs from 'node:fs';
import { openLab, projectInput, labPath } from './lab.mjs';
import { startVmOf } from './start-vm.mjs';

const STEP = process.argv[2];
const ID = '2e70e494-da6d-40bf-ab72-5bc89cdd8e55', OUT = 'results/human/steps';
const P = JSON.parse(fs.readFileSync(labPath('results/points-v21/2e70e494/points.json'), 'utf8'));
const trace = JSON.parse(fs.readFileSync(labPath('results/agent/v20/2e70e494/trace.json'), 'utf8'));
fs.mkdirSync(labPath(OUT), { recursive: true });
const med = (a) => { a = a.filter(Number.isFinite).sort((x, y) => x - y); return a[a.length >> 1]; };
const pt = (side, k) => [med(P[side].map((r) => r.base?.[k]?.[0])), med(P[side].map((r) => r.base?.[k]?.[1]))];

const lab = await openLab();
// 在图上画点和线段，裁到 crop（图坐标 [x0, y0, x1, y1]），放大到宽 outW
const draw = (png, items, crop, outW = 560) => lab.page.evaluate(async ([png, items, crop, outW]) => {
  const bm = await createImageBitmap(new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], { type: 'image/png' }));
  const [x0, y0, x1, y1] = crop, k = outW / (x1 - x0);
  const c = new OffscreenCanvas(outW, Math.round((y1 - y0) * k)), g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bm, x0, y0, x1 - x0, y1 - y0, 0, 0, c.width, c.height);
  const X = (x) => (x - x0) * k, Y = (y) => (y - y0) * k;
  g.font = 'bold 15px sans-serif'; g.lineWidth = 2.5;
  for (const it of items) {
    g.strokeStyle = g.fillStyle = it.color;
    if (it.a) { g.beginPath(); g.moveTo(X(it.a[0]), Y(it.a[1])); g.lineTo(X(it.b[0]), Y(it.b[1])); g.stroke(); for (const p of [it.a, it.b]) { g.beginPath(); g.arc(X(p[0]), Y(p[1]), 4, 0, 7); g.fill(); } }
    else { g.beginPath(); g.arc(X(it.p[0]), Y(it.p[1]), 5, 0, 7); g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke(); g.lineWidth = 2.5; }
    // 标签：点标在点右上；横线标在左端上方；竖线标在中点右侧
    const at = it.p ?? (Math.abs(it.a[1] - it.b[1]) < Math.abs(it.a[0] - it.b[0]) ? [Math.min(it.a[0], it.b[0]), it.a[1] - 4 / k] : [it.a[0], (it.a[1] + it.b[1]) / 2]);
    g.lineWidth = 3; g.strokeStyle = '#fff'; g.strokeText(it.label, X(at[0]) + 6, Y(at[1]) - 6); g.fillStyle = it.color; g.fillText(it.label, X(at[0]) + 6, Y(at[1]) - 6); g.lineWidth = 2.5;
  }
  const b = await c.convertToBlob({ type: 'image/png' }); const u = new Uint8Array(await b.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode(...u.subarray(i, i + 32768)); return btoa(s);
}, [png, items, crop, outW]);
const save = (name, b64) => { fs.writeFileSync(labPath(`${OUT}/${name}.png`), Buffer.from(b64, 'base64')); return `${name}.png?t=${Date.now()}`; };

try {
  await lab.call('loadProject', projectInput(ID));
  await lab.call('loadMaster');
  const specs = await lab.call('tunableParams');
  let title, note, panels;
  if (STEP === 'body') {
    // ① 身体：代码按图层量，riv 对 riv（模板原始身体 vs 当前身体），Body_X 对准 riv 自己脸部图层的下巴
    const start = startVmOf(trace.startVm, specs);
    const projTex = await lab.call('textureSnapshot'), tpl = await lab.call('templateTextures'), bodyId = (await lab.call('roleTextures')).body.assetId;
    const geom = async (vm) => {
      const b = await lab.call('soloGeom', vm, 'body'), h = await lab.call('soloGeom', vm, 'head');
      const sy = b.shoulderY + Math.round(b.h * 0.03), row = (await lab.call('rowEdgesSolo', vm, 'body', { s: sy })).s, chin = (await lab.call('rowEdgesSolo', vm, 'head', { c: h.y1 })).c;
      return { b, h, sy, row, chinX: (chin[0] + chin[1]) / 2, png: (await lab.call('rivForPoints', vm)).png };
    };
    await lab.call('restoreTextures', { ...projTex, [bodyId]: tpl[bodyId] });
    const T = await geom(start);
    await lab.call('restoreTextures', projTex);
    const C = await geom(start);
    const items = (g, withChin) => [
      { a: [g.row[0], g.sy], b: [g.row[1], g.sy], label: `肩宽 ${g.row[1] - g.row[0] + 1}px（Body_scale）`, color: '#e6194b' },
      { a: [g.b.x0 - 20, g.b.shoulderY], b: [g.b.x1 + 20, g.b.shoulderY], label: `肩线 y=${g.b.shoulderY}（Body_Y）`, color: '#3cb44b' },
      { p: [(g.row[0] + g.row[1]) / 2, g.sy], label: '肩线中点（Body_X）', color: '#4363d8' },
      ...(withChin ? [{ p: [g.chinX, g.h.y1], label: '下巴（脸部图层，Body_X 对准它）', color: '#f58231' }] : []),
    ];
    const crop = [140, 380, 580, 800];
    title = '① 身体：Body_scale、Body_Y、Body_X（代码按图层量，不用 AI 点）';
    note = '左：模板原始身体贴图、默认参数（目标）。右：项目生成的身体贴图、起点参数（当前）。肩宽、肩线高度对齐左图；肩线中点对准右图自己的下巴。';
    panels = [['模板原始（目标）', save('tpl', await draw(T.png, items(T, false), crop))], ['当前 riv（起点）', save('cur', await draw(C.png, items(C, true), crop))]];
  } else if (STEP === 'head') {
    // ② 头：AI 点（3 次中位数）。主图 = 目标；riv 借用 v20 最终状态的标点（v21 还没跑）
    const items = (s) => {
      const sl = pt(s, 'shoulder_l'), sr = pt(s, 'shoulder_r'), cl = pt(s, 'cheek_l'), cr = pt(s, 'cheek_r'), ch = pt(s, 'chin'), el = pt(s, 'eye_l'), er = pt(s, 'eye_r');
      const eyeY = (el[1] + er[1]) / 2, shY = (sl[1] + sr[1]) / 2, mx = ch[0];
      return [
        { a: sl, b: sr, label: '肩宽', color: '#e6194b' },
        { a: cl, b: cr, label: '鼻底行脸宽', color: '#4363d8' },
        { a: [cr[0] + 30, eyeY], b: [cr[0] + 30, ch[1]], label: 'L', color: '#911eb4' },
        { a: [mx, ch[1]], b: [mx, shY], label: '脖子', color: '#3cb44b' },
        { a: [cr[0] + 15, eyeY], b: [cr[0] + 45, eyeY], label: '', color: '#911eb4' }, { a: [cr[0] + 15, ch[1]], b: [mx, ch[1]], label: '', color: '#911eb4' },
        { p: el, label: '眼', color: '#f58231' }, { p: er, label: '眼', color: '#f58231' }, { p: ch, label: '下巴', color: '#f58231' },
      ];
    };
    const box = (s) => { const sl = pt(s, 'shoulder_l'), sr = pt(s, 'shoulder_r'), ht = pt(s, 'head_top'); const pad = (sr[0] - sl[0]) * 0.08; return [sl[0] - pad, ht[1] - pad, sr[0] + pad, sl[1] + pad * 2]; };
    const m = await lab.call('masterForPoints'), r = await lab.call('rivForPoints', trace.finalVm);
    title = '② 头：Head_scale、Head_Y（AI 点，主图和 riv 同一套）';
    note = '<b style="color:#e6194b">肩宽</b> ÷ <b style="color:#4363d8">鼻底行脸宽</b> → Head_scale（首选）；<b style="color:#e6194b">肩宽</b> ÷ <b style="color:#911eb4">L</b>（眼睛行到下巴）只作检查。<b style="color:#3cb44b">脖子</b>（肩线到下巴）÷ <b style="color:#911eb4">L</b> → Head_Y。橙点：两眼（定眼睛行）、下巴。<br>riv 图借用 v20 最终状态已有的标点（v21 还没跑），只用来看点在哪；点是 3 次标点的中位数。';
    panels = [['主图（目标）', save('master', await draw(m.png, items('master'), box('master')))], ['riv（v20 最终，借用已有标点）', save('riv', await draw(r.png, items('riv'), box('riv')))]];
  } else throw new Error(`未知步骤 ${STEP}`);
  const html = `<!doctype html><meta charset="utf-8"><title>v21 当前步骤</title><style>body{font:15px sans-serif;margin:20px}figure{display:inline-block;margin:0 16px 0 0;vertical-align:top}figcaption{font-weight:bold;margin-bottom:6px}</style>
<h2>${title}</h2><p>${note}</p>${panels.map(([cap, src]) => `<figure><figcaption>${cap}</figcaption><img src="${src}"></figure>`).join('')}`;
  fs.writeFileSync(labPath(`${OUT}/index.html`), html);
  console.log('ok', STEP);
} finally { await Promise.race([lab.close(), new Promise((o) => setTimeout(o, 15000))]); }
process.exit(0);
