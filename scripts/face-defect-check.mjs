// v17 面部挑选验证：AI 对照主图查候选面部贴图有没有缺部件 / 画坏（换顺序问两次，不一致再问一次；同一问题出现两次才算缺陷）
import fs from 'node:fs';
import { openLab, projectInput, readJson, writeJson, labPath } from './lab.mjs';
import { logUsage, setUsageTag } from './usage.mjs';
const MODEL = 'gpt-6.1-sol', KEY = fs.readFileSync(labPath('../.dev.vars'), 'utf8').match(/^IMAGE_API_KEY=(.*)$/m)[1].trim();
const OUT = labPath('results/face-defect'), ONLY_IMG = process.argv.includes('--img');
const PROJECTS = ['1cf5ecc9-873b-4a81-9595-2e2672a9b3c7', '9ee088da-1409-477e-9cf4-1959c79293db'];
const med = (v) => { v = v.filter(Number.isFinite).sort((a, b) => a - b); return v[v.length >> 1]; };
const P = (pts, n, i) => med(pts.map((p) => p?.[n]?.[i]));
const SYS = `你在检查 2D 角色的脸部贴图有没有缺陷。第一格是主图上的脸部裁剪，后面是几张候选脸部贴图（单独显示）。
脸部贴图应该包含：眉毛、鼻子，以及主图里能看见的耳朵。眼睛、嘴、头发是别的图层，脸部贴图上本来就没有，不算缺。主图里被头发等挡住、看不见的部件，候选上没有也不算缺。
逐张检查，只从下面几类里选：
- "缺鼻子"、"缺眉毛"：主图有、候选上没有；
- "缺耳朵"：只有主图里能看见耳朵时才算；
- "画坏"：明显残缺、断开、多余的污痕。
不要比较大小、位置、脸型、画风、颜色，这些不算缺陷。
只输出 JSON：{"candidates":[{"id":候选编号,"problems":["缺鼻子" 等，没有就是空数组],"note":"画坏时写在哪里，其他情况留空"}]}`;
async function ask(img) {
  for (let attempt = 1; attempt <= 15; attempt++) {
    const t0 = Date.now();
    const res = await fetch('https://tenantapi.anispark.ai/llm/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(180000),
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: SYS }, { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${img}` } }] }], response_format: { type: 'json_object' }, max_tokens: 2000 }) }).catch(() => null);
    if (res?.ok) { const j = await res.json(); logUsage('face-defect', MODEL, j.usage, { ms: Date.now() - t0 }); return JSON.parse(j.choices[0].message.content); }
    await new Promise((o) => setTimeout(o, res?.status === 429 ? 20000 : 5000));
  }
  throw new Error('调用失败');
}
const raw = readJson('results/metric-check/raw.json'), lab = await openLab(), report = {};
try {
  for (const id of PROJECTS) {
    const key = id.slice(0, 8); setUsageTag(`face-defect/${key}`);
    await lab.call('loadProject', projectInput(id)); await lab.call('loadMaster');
    const { W, H } = await lab.call('masterForPoints'), pts = raw[id].master;
    const browY = (P(pts, 'brow_l', 1) + P(pts, 'brow_r', 1)) / 2, chin = P(pts, 'chin', 1), FL = chin - browY;
    const cx = (P(pts, 'cheek_l', 0) + P(pts, 'cheek_r', 0)) / 2, half = Math.max(P(pts, 'cheek_r', 0) - P(pts, 'cheek_l', 0), FL) * 0.75;
    const box = [(cx - half) / W, (browY - FL * 0.45) / H, (half * 2) / W, (FL * 1.6) / H];
    const base = await lab.call('textureSnapshot');
    const names = ['原贴图', '候选1', '候选2', '候选3'];
    const tex = [null, 1, 2, 3].map((i) => { if (!i) return null; return readJson(`results/pool/${key}/head-${i}.json`).textures; });
    const aid = Object.keys(tex[1])[0]; tex[0] = { [aid]: base[aid] };
    const t = tex.map((x) => x[aid]);
    const orders = [[0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2]], asks = [];
    for (let q = 0; q < 3; q++) {
      const o = orders[q], img = await lab.call('choiceImage', box, o.map((i) => t[i]));
      fs.writeFileSync(`${OUT}/${key}-q${q + 1}.png`, Buffer.from(img, 'base64'));
      if (ONLY_IMG) break;
      const a = await ask(img);
      const flags = Object.fromEntries((a.candidates || []).map((c) => [o[Number(c.id) - 1], { problems: [...new Set(c.problems || [])], note: c.note || '' }]));
      asks.push(flags);
      console.log(`${key} 第${q + 1}问（顺序 ${o.map((i) => names[i]).join(',')}）`);
      for (let i = 0; i < 4; i++) console.log('   ', names[i], flags[i]?.problems.length ? flags[i].problems.join('、') + (flags[i].note ? `（${flags[i].note}）` : '') : '无');
      const same = (i) => (asks[0][i]?.problems || []).slice().sort().join() === (asks[1][i]?.problems || []).slice().sort().join();
      if (q === 1 && [0, 1, 2, 3].every(same)) break;
    }
    // 同一个问题至少在两次里都被提到才算缺陷
    if (!ONLY_IMG) report[key] = names.map((n, i) => {
      const cnt = {}; asks.forEach((f) => (f[i]?.problems || []).forEach((p) => { cnt[p] = (cnt[p] || 0) + 1; }));
      const confirmed = Object.keys(cnt).filter((p) => cnt[p] >= 2);
      return { name: n, defective: confirmed.length > 0, confirmed, asks: asks.map((f) => f[i]) };
    });
  }
} finally { await lab.close(); }
if (!ONLY_IMG) { writeJson('results/face-defect/report.json', report); for (const [k, rows] of Object.entries(report)) { console.log(`== ${k}`); rows.forEach((r) => console.log('  ', r.name, r.defective ? `淘汰：${r.confirmed.join('、')}` : '通过')); } }
