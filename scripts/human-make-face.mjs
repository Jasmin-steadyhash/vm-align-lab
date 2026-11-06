// 标注图改为按脸对齐：主图、riv 各自 AI 定点 3 次取中位（已有的复用 results/metric-check/raw.json），
// 脸尺度 = √(脸宽 × 脸长)，riv 缩放到和主图同尺度、两眼中心重合。覆盖 results/human/img/NN.png，对齐参数存 results/human/align.json
import fs from 'node:fs';
import { openLab, projectInput, readJson, writeJson, labPath } from './lab.mjs';
import { startVmOf } from './start-vm.mjs';
import { locate, POINTS_WHITE } from './landmarks.mjs';
import { setUsageTag } from './usage.mjs';

const key = readJson('results/human/key.json');
const raw = readJson('results/metric-check/raw.json');
const fullId = Object.fromEntries(Object.keys(raw).map((k) => [k.slice(0, 8), k]));
const ok = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const med = (v) => { v = v.filter(Number.isFinite).sort((a, b) => a - b); return v[v.length >> 1]; };
const pt = (list, k) => { const ps = list.map((l) => l?.[k]).filter(ok); return ps.length ? [med(ps.map((p) => p[0])), med(ps.map((p) => p[1]))] : null; };
const face = (list) => {
  const [cl, cr, bl, br, ch, el, er] = ['cheek_l', 'cheek_r', 'brow_l', 'brow_r', 'chin', 'eye_l', 'eye_r'].map((k) => pt(list, k));
  return { scale: Math.sqrt((cr[0] - cl[0]) * (ch[1] - (bl[1] + br[1]) / 2)), eye: [(el[0] + er[0]) / 2, (el[1] + er[1]) / 2] };
};
const align = {};
const lab = await openLab();
try {
  for (const { no, id: p8, method } of key) {
    const id = fullId[p8];
    setUsageTag(`human-align/${p8}`);
    const info = await lab.call('loadProject', projectInput(id));
    await lab.call('loadMaster');
    const start = { ...startVmOf(info.savedVm, await lab.call('tunableParams')), Head_scale: 100 };
    const dir = labPath(`results/${method}/${p8}`);
    const vm = method === 'start' ? start : JSON.parse(fs.readFileSync(`${dir}/trace.json`, 'utf8')).finalVm;
    if (method !== 'start' && fs.existsSync(`${dir}/textures.json`)) await lab.call('restoreTextures', JSON.parse(fs.readFileSync(`${dir}/textures.json`, 'utf8')));
    const mImg = await lab.call('masterForPoints');
    const mDim = await lab.call('masterSize');
    const k = mDim.w / mImg.W;  // 定点图 → 主图原尺寸
    const mf = face(raw[id].master);
    if (!raw[id][method]) { raw[id][method] = await Promise.all([1, 2, 3].map(async () => locate('gpt-6-astra', await lab.call('rivForPoints', vm), POINTS_WHITE))); writeJson('results/metric-check/raw.json', raw); }
    const rf = face(raw[id][method]);
    const a = { mEye: [mf.eye[0] * k, mf.eye[1] * k], rEye: rf.eye, s: (mf.scale * k) / rf.scale };
    align[no] = a;
    fs.writeFileSync(labPath(`results/human/img/${no}.png`), Buffer.from(await lab.call('obsPairAligned', vm, a, 900), 'base64'));
    console.log(no, p8, method, 's', a.s.toFixed(3));
  }
} finally { await lab.close(); }
writeJson('results/human/align.json', align);
