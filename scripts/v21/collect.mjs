// v21 阶段 1 验证：一个项目的主图（N_MASTER 次）和某个结果的 riv（N_RIV 次）按 v21 标点协议标点，并采 riv 侧代码参考。只采数据，不算度量（度量在 metrics.mjs，可离线重算）。
// 用法：GATEWAY=agent node scripts/v21/collect.mjs <项目完整 id> <结果目录，如 results/agent/v20/2e70e494> [主图次数 5] [riv 次数 3]
// 产出 results/v21-validate/<项目前 8 位>/raw.json 和放大图
import fs from 'node:fs';
import { openLab, projectInput, writeJson, labPath } from '../lab.mjs';
import { setUsageTag } from '../usage.mjs';
import * as PT from './points.mjs';

const [ID, RUN_DIR, NM = '5', NR = '3'] = process.argv.slice(2);
const P8 = ID.slice(0, 8), OUT = `results/v21-validate/${P8}`, Q = 3;
setUsageTag(`v21-validate/${P8}`);
fs.mkdirSync(labPath(OUT), { recursive: true });
const med = (a) => { a = a.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : NaN; };
const medPts = (runs) => { const keys = new Set(runs.flatMap((r) => Object.keys(r || {}))); return Object.fromEntries([...keys].map((k) => { const v = runs.map((r) => r?.[k]).filter((p) => Array.isArray(p) && p.every(Number.isFinite)); return [k, v.length ? [med(v.map((p) => p[0])), med(v.map((p) => p[1]))] : null]; })); };
const times = (n, f) => Promise.all(Array.from({ length: n }, (_, i) => f(i)));

const lab = await openLab();
const drawLines = (png, rows) => lab.page.evaluate(async ([png, rows]) => {
  const bm = await createImageBitmap(new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], { type: 'image/png' }));
  const c = new OffscreenCanvas(bm.width, bm.height), g = c.getContext('2d'); g.drawImage(bm, 0, 0);
  const cols = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4'];
  Object.entries(rows).forEach(([k, y], i) => { g.strokeStyle = cols[i % 5]; g.lineWidth = 1; g.beginPath(); g.moveTo(0, y); g.lineTo(bm.width, y); g.stroke(); g.fillStyle = cols[i % 5]; g.font = 'bold 13px sans-serif'; g.fillText(k, 3, y - 3); });
  const b = await c.convertToBlob({ type: 'image/png' }); const u = new Uint8Array(await b.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode(...u.subarray(i, i + 32768)); return btoa(s);
}, [png, rows]);

async function side(name, img, n, zoomer, rowsOf) {
  const base = await times(n, () => PT.step1(img, name));
  const mb = medPts(base);
  const rows = rowsOf(mb);
  const rowRuns = await times(n, () => PT.step2(img, rows, drawLines, name));
  const eb = PT.eyesBox(mb), mbx = PT.mouthBox(mb);
  const ez = await zoomer(eb), mz = await zoomer(mbx);
  fs.writeFileSync(labPath(`${OUT}/${name}-eyes.png`), Buffer.from(ez.png, 'base64'));
  fs.writeFileSync(labPath(`${OUT}/${name}-mouth.png`), Buffer.from(mz.png, 'base64'));
  const eyeRuns = await times(n, () => PT.step3eyes(ez, name));
  const mouthRuns = await times(n, () => PT.step3mouth(mz, name));
  // 代码：眼睛放大图上按亮度二分量虹膜（每次用这一次 AI 标的开口和虹膜中心）
  const otsu = [];
  for (const er of eyeRuns) {
    const o = {};
    for (const s of ['l', 'r']) {
      const p = (k) => er?.[`${s}_${k}`];
      if (![p('outer'), p('inner'), p('top'), p('bottom'), p('iris_center')].every((q) => Array.isArray(q))) { o[s] = null; continue; }
      const box = [Math.min(p('outer')[0], p('inner')[0]), p('top')[1], Math.max(p('outer')[0], p('inner')[0]), p('bottom')[1]];
      o[s] = await lab.call('irisOtsu2', ez.png, box, p('iris_center'));
    }
    otsu.push(o);
  }
  return { base, rows, rowRuns, eyes: { box: eb, k: ez.k, runs: eyeRuns, otsu }, mouth: { box: mbx, k: mz.k, runs: mouthRuns } };
}

try {
  const trace = JSON.parse(fs.readFileSync(labPath(`${RUN_DIR}/trace.json`), 'utf8'));
  await lab.call('loadProject', projectInput(ID));
  await lab.call('loadMaster');
  if (fs.existsSync(labPath(`${RUN_DIR}/textures.json`))) await lab.call('restoreTextures', JSON.parse(fs.readFileSync(labPath(`${RUN_DIR}/textures.json`), 'utf8')));
  const vm = trace.finalVm;
  const mImg = await lab.call('masterForPoints'), rImg = await lab.call('rivForPoints', vm);
  const master = await side('master', mImg, Number(NM), (box) => lab.call('zoomMaster', box, 1200), (b) => PT.masterRows(b).rows);
  const mBase = medPts(master.base);
  const riv = await side('riv', rImg, Number(NR), (box) => lab.call('zoomRiv', vm, box, Q, 1200), (b) => PT.anchoredRows(master.rows, mBase, b));
  // riv 代码参考：行上脸 / 头发外沿、头最宽、身体（肩宽、肩线、中线）、头部图层（下巴）、每只眼的可见瞳孔宽、AI 行上点的图层归属
  const ref = { rowEdges: await lab.call('rowEdges', vm, riv.rows), headWidest: await lab.call('headWidest', vm), body: await lab.call('soloGeom', vm, 'body'), head: await lab.call('soloGeom', vm, 'head'), pupil: {}, owners: [] };
  const rEyes = medPts(riv.eyes.runs.map((r) => PT.unzoom(r, riv.eyes.box, riv.eyes.k)));
  for (const s of ['l', 'r']) { const o = rEyes[`${s}_outer`], i = rEyes[`${s}_inner`], t = rEyes[`${s}_top`], b = rEyes[`${s}_bottom`]; if (o && i && t && b) ref.pupil[s] = (await lab.call('rivIris', vm, [Math.min(o[0], i[0]), t[1], Math.max(o[0], i[0]), b[1]], Q)).pupilW; }
  for (const rr of riv.rowRuns) {
    const pts = {};
    for (const [row, e] of Object.entries(rr?.rows || {})) for (const [k, v] of Object.entries(e || {})) {
      if (!Array.isArray(v) || !Number.isFinite(v[0]) || !(row in riv.rows)) continue;
      const inward = k.endsWith('_l') ? 2 : -2;  // 外沿点往里取 2 像素，避免正好落在边界外
      pts[`${row}.${k}`] = [v[0] + inward, riv.rows[row]];
    }
    ref.owners.push(await lab.call('ownerAt', vm, pts));
  }
  writeJson(`${OUT}/raw.json`, { protocol: PT.PROTOCOL_VERSION, model: PT.MODEL, id: ID, runDir: RUN_DIR, vm, at: new Date().toISOString(), masterSize: [mImg.W, mImg.H], rivSize: [rImg.W, rImg.H], master, riv, ref });
  console.log(P8, 'saved', OUT, '| master base ok', master.base.filter(Boolean).length, 'rows ok', master.rowRuns.filter(Boolean).length, 'eyes ok', master.eyes.runs.filter(Boolean).length, '| riv base ok', riv.base.filter(Boolean).length, 'rows ok', riv.rowRuns.filter(Boolean).length, 'eyes ok', riv.eyes.runs.filter(Boolean).length);
} finally { await Promise.race([lab.close(), new Promise((o) => setTimeout(o, 15000))]); }
process.exit(0);
