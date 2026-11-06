// 第 1 轮评审图：20 组（去掉重复）× 3 种格式，存 results/human/eval/<格式>/NN-*.png
//   A 旧格式：评审原来用的（按角色外框取景）整图 + 分区图 + 眼睛图，直接复制 results/judge/devcmp
//   B 按脸对齐并排：整图并排 + 脸部并排 + 眼眉并排
//   C 按脸对齐叠加：全身叠加 + 眼眉三联（主图 / riv / 叠加），复用 results/human/claude
import fs from 'node:fs';
import { openLab, projectInput, readJson, labPath } from './lab.mjs';
import { startVmOf } from './start-vm.mjs';
const key = readJson('results/human/key.json').filter((k) => !k.dup);
const align = readJson('results/human/align.json');
const raw = readJson('results/metric-check/raw.json');
const fullId = Object.fromEntries(Object.keys(raw).map((k) => [k.slice(0, 8), k]));
const ok = (p) => Array.isArray(p) && p.every(Number.isFinite);
const med = (v) => { v = v.filter(Number.isFinite).sort((a, b) => a - b); return v[v.length >> 1]; };
const pt = (l, k) => { const ps = l.map((x) => x?.[k]).filter(ok); return [med(ps.map((p) => p[0])), med(ps.map((p) => p[1]))]; };
const out = (f) => labPath(`results/human/eval/${f}`);
for (const d of ['A', 'B', 'C']) fs.mkdirSync(out(d), { recursive: true });
const lab = await openLab();
try {
  for (const { no, id: p8, method } of key) {
    const tag = `${p8}-${method.replace(/\//g, '_')}`;
    for (const s of ['full', 'grid', 'eyes']) fs.copyFileSync(labPath(`results/judge/devcmp/${tag}-${s}.png`), out(`A/${no}-${s}.png`));
    fs.copyFileSync(labPath(`results/human/claude/${no}-full.png`), out(`C/${no}-full.png`));
    fs.copyFileSync(labPath(`results/human/claude/${no}-eyes.png`), out(`C/${no}-eyes.png`));
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
    // 整图并排：缩成每格 512 宽
    fs.writeFileSync(out(`B/${no}-full.png`), Buffer.from(await lab.call('cropPair', pair, [0, 0, 900, Math.round(dim.h * t) + 28], 1024), 'base64'));
    fs.writeFileSync(out(`B/${no}-face.png`), Buffer.from(await lab.call('cropPair', pair, [ex - FW * 1.1, ey - FW * 1.1, FW * 2.2, FW * 2.3], 1000), 'base64'));
    fs.writeFileSync(out(`B/${no}-eyes.png`), Buffer.from(await lab.call('cropPair', pair, [ex - FW * 0.75, ey - FW * 0.4, FW * 1.5, FW * 0.62], 1200), 'base64'));
    console.log(no);
  }
} finally { await lab.close(); }
