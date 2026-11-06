// v17 挑选验证：① 1cf5ecc9 脸部按贴图内部指标挑（不试调，每张标 3 次）② 耳麦女孩身体、瞳孔由 AI 依据主图挑（换顺序问，不一致再问一次）
import fs from 'node:fs';
import { openLab, projectInput, readJson, writeJson, labPath } from './lab.mjs';
import { startVmOf } from './start-vm.mjs';
import { locate, POINTS_WHITE } from './landmarks.mjs';
import { logUsage, setUsageTag } from './usage.mjs';
const MODEL = 'gpt-6.1-sol', KEY = fs.readFileSync(labPath('../.dev.vars'), 'utf8').match(/^IMAGE_API_KEY=(.*)$/m)[1].trim();
const OUT = labPath('results/pick-check'); fs.mkdirSync(OUT, { recursive: true });
const med = (v) => { v = v.filter(Number.isFinite).sort((a, b) => a - b); return v[v.length >> 1]; };
const P = (pts, n, i) => med(pts.map((p) => p?.[n]?.[i]));
const inner = (pts) => { const browY = (P(pts, 'brow_l', 1) + P(pts, 'brow_r', 1)) / 2, chin = P(pts, 'chin', 1), nose = P(pts, 'nose', 1), FL = chin - browY; return { 脸宽除脸长: (P(pts, 'cheek_r', 0) - P(pts, 'cheek_l', 0)) / FL, 眉到鼻底除脸长: (nose - browY) / FL, 鼻底到下巴除脸长: (chin - nose) / FL }; };
const WHAT = {
  body: '身体：领口、肩形是否和主图一致；主图露出脖子时，还要看脖子的长短、粗细；有没有残缺或画坏。',
  pupil: '瞳孔（虹膜）：颜色、花纹、高光是否和主图一致；有没有残缺或画坏。',
};
async function askPick(comp, img) {
  const sys = `你在挑 2D 角色的组件贴图。第一格是主图上这个部位的裁剪，后面是同一组件的几张候选贴图（单独显示，大小和位置之后还能调，所以不要比较大小和位置）。选出最还原主图的一张。\n看：${WHAT[comp]}\n只输出 JSON：{"best":候选编号,"reason":"..."}`;
  for (let attempt = 1; attempt <= 15; attempt++) {
    const t0 = Date.now();
    const res = await fetch('https://tenantapi.anispark.ai/llm/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(180000),
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: sys }, { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${img}` } }] }], response_format: { type: 'json_object' }, max_tokens: 2000 }) }).catch(() => null);
    if (res?.ok) { const j = await res.json(); logUsage('pick', MODEL, j.usage, { ms: Date.now() - t0 }); return JSON.parse(j.choices[0].message.content); }
    await new Promise((o) => setTimeout(o, res?.status === 429 ? 20000 : 5000));
  }
  throw new Error('pick 调用失败');
}
const lab = await openLab();
const report = {};
try {
  // ① 1cf5ecc9 脸部：指标
  const A = '1cf5ecc9-873b-4a81-9595-2e2672a9b3c7';
  setUsageTag('pick-check/1cf5ecc9');
  const info = await lab.call('loadProject', projectInput(A)); await lab.call('loadMaster');
  const vm = { ...startVmOf(info.savedVm, await lab.call('tunableParams')), Head_scale: 100 };
  const ma = [...readJson('results/metric-check/raw.json')[A].master, ...readJson('results/metric-check/raw-gpt_6.1_sol.json')[A].master];
  const target = inner(ma), base = await lab.call('textureSnapshot'), rows = [];
  const cands = [{ name: '原贴图（没鼻子）', textures: {} }, ...[1, 2, 3].map((i) => ({ name: `候选${i}`, ...readJson(`results/pool/1cf5ecc9/head-${i}.json`) }))];
  for (const c of cands) {
    await lab.call('restoreTextures', { ...base, ...c.textures });
    const img = await lab.call('rivForPoints', vm);
    const m = inner(await Promise.all([1, 2, 3].map(() => locate(MODEL, img, POINTS_WHITE))));
    const e = Object.fromEntries(Object.keys(target).map((k) => [k, Math.abs(m[k] - target[k]) / Math.abs(target[k])]));
    rows.push({ name: c.name, worst: Math.max(...Object.values(e)), mean: Object.values(e).reduce((a, b) => a + b, 0) / 3, e });
  }
  const bw = Math.min(...rows.map((r) => r.worst)), keep = rows.filter((r) => r.worst <= bw + 0.10), best = keep.reduce((a, b) => (b.mean < a.mean ? b : a));
  report.face = { rows, picked: best.name };
  console.log('== 1cf5ecc9 脸部（指标）');
  for (const r of rows) console.log(' ', r.name.padEnd(10), '最差', (r.worst * 100).toFixed(0) + '%', '平均', (r.mean * 100).toFixed(0) + '%', keep.includes(r) ? '' : '← 淘汰', Object.entries(r.e).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(' '));
  console.log('  → 选', best.name);
  // ② 耳麦女孩：AI
  const N = 'dfb3bc24-86fd-4619-b6e3-f85e1fcc4e29', B = `e2e-${N}`;
  setUsageTag('pick-check/耳麦女孩');
  await lab.call('loadProject', projectInput(B)); await lab.call('loadMaster');
  const dim = await lab.call('masterSize'), mfp = await lab.call('masterForPoints'), pts = JSON.parse(fs.readFileSync('/tmp/master-pts.json', 'utf8'));
  const rel = (x0, y0, x1, y1) => [x0 / mfp.W, y0 / mfp.H, (x1 - x0) / mfp.W, (y1 - y0) / mfp.H];
  const eyeX = P(pts, 'iris_l_center', 0), eyeY = P(pts, 'iris_l_center', 1), r = (P(pts, 'eye_l_inner', 0) - P(pts, 'eye_l_outer', 0)) * 0.75;
  const BOX = { body: rel(0, P(pts, 'chin', 1) - 20, mfp.W, Math.min(mfp.H, P(pts, 'chin', 1) + 420)), pupil: rel(eyeX - r, eyeY - r, eyeX + r, eyeY + r) };
  for (const comp of ['body', 'pupil']) {
    const c2 = readJson(`data/e2e/${N}/pool/${comp}-2.json`), c3 = readJson(`data/e2e/${N}/pool/${comp}-3.json`), aid = Object.keys(c2.textures)[0];
    const c1 = fs.readFileSync(labPath(`data/e2e/${N}/tex/${aid}.png`)).toString('base64');
    const tex = [c1, c2.textures[aid], c3.textures[aid]];
    const orders = [[0, 1, 2], [2, 0, 1], [1, 2, 0]], votes = [];
    for (let q = 0; q < 3; q++) {
      const o = orders[q], img = await lab.call('choiceImage', BOX[comp], o.map((i) => tex[i]));
      fs.writeFileSync(`${OUT}/${comp}-q${q + 1}.png`, Buffer.from(img, 'base64'));
      const a = await askPick(comp, img), v = o[Number(a.best) - 1] + 1;
      votes.push({ 选: v, 理由: a.reason }); console.log(comp, `第${q + 1}问（顺序 ${o.map((i) => i + 1).join(',')}）选候选${v}：`, String(a.reason).slice(0, 110));
      if (q === 1 && votes[0].选 === votes[1].选) break;
    }
    const cnt = {}; votes.forEach((x) => { cnt[x.选] = (cnt[x.选] || 0) + 1; });
    const win = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
    report[comp] = { votes, picked: win[1] > 1 ? Number(win[0]) : 1 };
    console.log(`== 耳麦女孩 ${comp} → 选候选${report[comp].picked}`);
  }
} finally { await lab.close(); }
writeJson('results/pick-check/report.json', report);
