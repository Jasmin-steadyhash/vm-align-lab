// 给 Claude 独立判定用的图：每组一张全身叠加（50%）+ 一张眼眉三联（主图 / riv / 叠加），存 results/human/claude/NN-*.png
import fs from 'node:fs';
import { openLab, projectInput, readJson, labPath } from './lab.mjs';
import { startVmOf } from './start-vm.mjs';
const key = readJson('results/human/key.json');
const align = readJson('results/human/align.json');
const raw = readJson('results/metric-check/raw.json');
const fullId = Object.fromEntries(Object.keys(raw).map((k) => [k.slice(0, 8), k]));
const ok = (p) => Array.isArray(p) && p.every(Number.isFinite);
const med = (v) => { v = v.filter(Number.isFinite).sort((a, b) => a - b); return v[v.length >> 1]; };
const pt = (l, k) => { const ps = l.map((x) => x?.[k]).filter(ok); return [med(ps.map((p) => p[0])), med(ps.map((p) => p[1]))]; };
fs.mkdirSync(labPath('results/human/claude'), { recursive: true });
const lab = await openLab();
try {
  for (const { no, id: p8, method } of key) {
    const id = fullId[p8];
    const info = await lab.call('loadProject', projectInput(id)); await lab.call('loadMaster');
    const start = { ...startVmOf(info.savedVm, await lab.call('tunableParams')), Head_scale: 100 };
    const dir = labPath(`results/${method}/${p8}`);
    const vm = method === 'start' ? start : JSON.parse(fs.readFileSync(`${dir}/trace.json`, 'utf8')).finalVm;
    if (method !== 'start' && fs.existsSync(`${dir}/textures.json`)) await lab.call('restoreTextures', JSON.parse(fs.readFileSync(`${dir}/textures.json`, 'utf8')));
    const pair = await lab.call('obsPairAligned', vm, align[no], 900);
    const m = await lab.call('masterForPoints'), dim = await lab.call('masterSize'), k = dim.w / m.W, t = 900 / dim.w;
    const L = raw[id].master, [cl, cr] = [pt(L, 'cheek_l'), pt(L, 'cheek_r')];
    const ex = align[no].mEye[0] * t, ey = 28 + align[no].mEye[1] * t, FW = (cr[0] - cl[0]) * k * t;
    fs.writeFileSync(labPath(`results/human/claude/${no}-full.png`), Buffer.from(await lab.call('blendHalves', pair, 0.5, null, 700), 'base64'));
    fs.writeFileSync(labPath(`results/human/claude/${no}-eyes.png`), Buffer.from(await lab.call('eyeTriptych', pair, [ex - FW * 0.75, ey - FW * 0.4, FW * 1.5, FW * 0.62], 800), 'base64'));
    console.log(no);
  }
} finally { await lab.close(); }
