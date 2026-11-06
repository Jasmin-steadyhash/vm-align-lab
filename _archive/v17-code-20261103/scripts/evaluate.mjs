// 评估：对每个项目的几份 VM（起点 / 方案 A / 方案 B），各渲染一张打分截图，调本地 worker 的还原度打分（/api/ai/riv-score，
// 线上同一份提示词）打 n 次取平均；并为人工盲评拼 主图 | X | Y（X、Y 随机对应 A、B，答案另存）。
// 用法：node scripts/evaluate.mjs <结果名> <B 版本> <项目 id ...>   结果在 results/eval/<结果名>/
import fs from 'node:fs';
import crypto from 'node:crypto';
import { openLab, projectInput, readJson, writeJson, labPath } from './lab.mjs';
import { startVmOf } from './start-vm.mjs';

const [name, bVersion, ...ids] = process.argv.slice(2);
const N_SCORES = Number(process.env.N_SCORES || 3);
const TOKEN = fs.readFileSync(labPath('data/token.txt'), 'utf8').trim();
const outDir = `results/eval/${name}`;
fs.mkdirSync(labPath(`${outDir}/blind`), { recursive: true });

async function score(projectId, b64) {
  const res = await fetch('http://localhost:8790/api/ai/riv-score', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ projectId, rivPreviewB64: b64 }),
  });
  const j = await res.json();
  if (!res.ok || !j.result) throw new Error(`score ${res.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j.result;
}

const lab = await openLab();
const summary = fs.existsSync(labPath(`${outDir}/summary.json`)) ? readJson(`${outDir}/summary.json`) : {};
try {
  for (const id of ids) {
    const info = await lab.call('loadProject', projectInput(id));
    const specs = await lab.call('tunableParams');
    const start = startVmOf(info.savedVm, specs);
    const aFile = labPath(`results/a/${id.slice(0, 8)}.json`);
    const bFile = labPath(`results/agent/${bVersion}/${id.slice(0, 8)}/trace.json`);
    const a = fs.existsSync(aFile) ? JSON.parse(fs.readFileSync(aFile, 'utf8')) : null;
    const b = fs.existsSync(bFile) ? JSON.parse(fs.readFileSync(bFile, 'utf8')) : null;
    const variants = { start, A: a?.ok ? a.vm : start, B: b?.finalVm ?? null };
    const row = { id, aOk: !!a?.ok, aError: a?.error ?? null, scores: {} };
    const caps = {};
    for (const [k, vm] of Object.entries(variants)) {
      if (!vm) continue;
      caps[k] = await lab.call('scoreCapture', vm);
      fs.writeFileSync(labPath(`${outDir}/${id.slice(0, 8)}-${k}.png`), Buffer.from(caps[k], 'base64'));
      const runs = [];
      for (let i = 0; i < N_SCORES; i++) runs.push(await score(id, caps[k]).catch((e) => ({ error: e.message })));
      const ok = runs.filter((r) => typeof r.score === 'number');
      row.scores[k] = { mean: ok.length ? ok.reduce((s, r) => s + r.score, 0) / ok.length : null, runs: runs.map((r) => r.score ?? r.error), areas: ok.map((r) => Object.fromEntries((r.areas || []).map((a) => [a.id, a.score]))), vetoes: ok.map((r) => (r.vetoes || []).map((v) => v.id)) };
      console.log(id.slice(0, 8), k, JSON.stringify(row.scores[k].runs));
    }
    // 盲评：主图 | X | Y
    if (caps.A && caps.B) {
      const flip = crypto.randomInt(2) === 1;
      const [x, y] = flip ? ['B', 'A'] : ['A', 'B'];
      const png = await lab.page.evaluate(async ([mUrl, xb, yb]) => {
        const load = async (src) => createImageBitmap(await (await fetch(src)).blob());
        const ims = [await load(mUrl), await load(`data:image/png;base64,${xb}`), await load(`data:image/png;base64,${yb}`)];
        const W = 512, H = Math.round(512 * 16 / 9) + 36;
        const c = new OffscreenCanvas(W * 3, H), g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, W * 3, H);
        ['主图', 'X', 'Y'].forEach((t, i) => {
          const im = ims[i], k = Math.min(W / im.width, (H - 36) / im.height);
          g.drawImage(im, i * W + (W - im.width * k) / 2, 36, im.width * k, im.height * k);
          g.fillStyle = '#000'; g.font = 'bold 28px sans-serif'; g.fillText(t, i * W + 12, 28);
        });
        const blob = await c.convertToBlob({ type: 'image/png' });
        const u8 = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (const v of u8) s += String.fromCharCode(v); return btoa(s);
      }, [info && projectInput(id).project.main_image, caps[x], caps[y]]);
      fs.writeFileSync(labPath(`${outDir}/blind/${id.slice(0, 8)}.png`), Buffer.from(png, 'base64'));
      row.blind = { X: x, Y: y };
    }
    summary[id] = row;
    writeJson(`${outDir}/summary.json`, summary);
  }
} finally { await lab.close(); }
