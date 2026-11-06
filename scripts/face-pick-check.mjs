// v17 面部挑选验证（只测 AI 这一层）：主图脸部裁剪 + 4 张面部贴图，问 AI 除大小位置外哪张最还原；换顺序问两次，不一致再问一次取多数
import fs from 'node:fs';
import { openLab, projectInput, readJson, writeJson, labPath } from './lab.mjs';
import { logUsage, setUsageTag } from './usage.mjs';
const MODEL = 'gpt-6.1-sol', KEY = fs.readFileSync(labPath('../.dev.vars'), 'utf8').match(/^IMAGE_API_KEY=(.*)$/m)[1].trim();
const OUT = labPath('results/face-pick'); fs.mkdirSync(OUT, { recursive: true });
const PROJECTS = process.argv.slice(2).length ? process.argv.slice(2) : ['1cf5ecc9-873b-4a81-9595-2e2672a9b3c7'];
const med = (v) => { v = v.filter(Number.isFinite).sort((a, b) => a - b); return v[v.length >> 1]; };
const P = (pts, n, i) => med(pts.map((p) => p?.[n]?.[i]));
const SYS = `你在挑 2D 角色的脸部贴图。第一格是主图上的脸部裁剪，后面是同一组件的几张候选脸部贴图（单独显示；眼睛、嘴、头发是别的图层，脸部贴图上本来就没有）。
大小和位置之后还能调，不要比较。除此之外，对照主图，选出最还原的一张。
只输出 JSON：{"best":候选编号,"reason":"..."}`;
async function ask(img) {
  for (let attempt = 1; attempt <= 15; attempt++) {
    const t0 = Date.now();
    const res = await fetch('https://tenantapi.anispark.ai/llm/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(180000),
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: SYS }, { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${img}` } }] }], response_format: { type: 'json_object' }, max_tokens: 2000 }) }).catch(() => null);
    if (res?.ok) { const j = await res.json(); logUsage('face-pick', MODEL, j.usage, { ms: Date.now() - t0 }); return JSON.parse(j.choices[0].message.content); }
    await new Promise((o) => setTimeout(o, res?.status === 429 ? 20000 : 5000));
  }
  throw new Error('调用失败');
}
const raw = readJson('results/metric-check/raw.json'), lab = await openLab(), report = {};
const names = ['原贴图', '候选1', '候选2', '候选3'];
try {
  for (const id of PROJECTS) {
    const key = id.slice(0, 8); setUsageTag(`face-pick/${key}`);
    await lab.call('loadProject', projectInput(id)); await lab.call('loadMaster');
    const { W, H } = await lab.call('masterForPoints'), pts = raw[id].master;
    const browY = (P(pts, 'brow_l', 1) + P(pts, 'brow_r', 1)) / 2, chin = P(pts, 'chin', 1), FL = chin - browY;
    const cx = (P(pts, 'cheek_l', 0) + P(pts, 'cheek_r', 0)) / 2, half = Math.max(P(pts, 'cheek_r', 0) - P(pts, 'cheek_l', 0), FL) * 0.75;
    const box = [(cx - half) / W, (browY - FL * 0.45) / H, (half * 2) / W, (FL * 1.6) / H];
    const base = await lab.call('textureSnapshot');
    const tex = [1, 2, 3].map((i) => readJson(`results/pool/${key}/head-${i}.json`).textures), aid = Object.keys(tex[0])[0];
    const t = [base[aid], ...tex.map((x) => x[aid])];
    const orders = [[0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2]], votes = [];
    for (let q = 0; q < 3; q++) {
      const o = orders[q], img = await lab.call('choiceImage', box, o.map((i) => t[i]));
      fs.writeFileSync(`${OUT}/${key}-q${q + 1}.png`, Buffer.from(img, 'base64'));
      const a = await ask(img), v = o[Number(a.best) - 1];
      votes.push({ pick: names[v], reason: a.reason });
      console.log(`${key} 第${q + 1}问（顺序 ${o.map((i) => names[i]).join(',')}）选 ${names[v]}：${a.reason}`);
      if (q === 1 && votes[0].pick === votes[1].pick) break;
    }
    const cnt = {}; votes.forEach((x) => { cnt[x.pick] = (cnt[x.pick] || 0) + 1; });
    const win = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
    report[key] = { votes, picked: win[1] > 1 ? win[0] : null };
    console.log(`== ${key} → ${report[key].picked ?? '三次都不同'}`);
  }
  writeJson('results/face-pick/report.json', report);
} finally { await Promise.race([lab.close(), new Promise((o) => setTimeout(o, 10000))]); }
process.exit(0);
