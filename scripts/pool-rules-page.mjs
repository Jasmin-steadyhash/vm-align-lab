// 三种挑选规则各自选中的贴图（v12–v14 各两次运行，用当时记录的候选度量离线重算），出网页 results/human/pool-rules.html
//   规则 1：实际运行用的（v12 平均误差好 0.05；v13/v14 可靠度量 + 守护项平均好 5%）
//   规则 2：先淘汰明显缺陷（最差项比最好的候选高 10 个百分点以上）→ 剩下按平均误差，好 2% 才换
//   规则 3：同规则 2，换的门槛按组件实测两次运行波动（脸 6%、眼眶 9.4%、瞳孔 19.4%、嘴 12.9%）
//   规则 4：原贴图和候选地位相同（4 选 1）：先淘汰明显缺陷，剩下直接选平均误差最小的，不偏向原贴图
import fs from 'node:fs';
import { openLab, projectInput, labPath } from './lab.mjs';
import { STAGE_METRICS_FACE, UNRELIABLE } from './landmarks.mjs';
const STAGE = { head: 'face', sclera: 'eye', pupil: 'iris', mouth: 'mouth' };
const ROLE_OF = { head: ['head'], sclera: ['sclera'], pupil: ['pupil'], mouth: ['mouth_up', 'mouth_down'] };
const VAR = { head: 0.06, sclera: 0.094, pupil: 0.194, mouth: 0.129 };
const NAME = { head: '脸部', sclera: '眼眶', pupil: '瞳孔', mouth: '嘴' };
const ids = fs.readFileSync(labPath('data/dev-ids.txt'), 'utf8').trim().split(/\s+/);
const rule = (t, l, margin) => {
  const ks = STAGE_METRICS_FACE[STAGE[l.component]].filter((k) => !UNRELIABLE.has(k) && k in t.target);
  const rows = l.rows.map((r) => { const e = ks.map((k) => (Number.isFinite(r.metrics[k]) ? Math.abs(r.metrics[k] - t.target[k]) / Math.max(0.1, Math.abs(t.target[k])) : 1)); return { name: r.name, worst: Math.max(...e), mean: e.reduce((a, b) => a + b, 0) / e.length, out: r.rough > 0.4 }; });
  const orig = rows[0], bw = Math.min(...rows.filter((r) => !r.out).map((r) => r.worst));
  const ok = rows.filter((r) => !r.out && r.worst <= bw + 0.10);
  let best = ok.reduce((a, b) => (b.mean < a.mean ? b : a));
  if (margin != null && ok.includes(orig) && best !== orig && best.mean > orig.mean - margin) best = orig;
  return best.name;
};
const dir = labPath('results/human/pooltex'); fs.mkdirSync(dir, { recursive: true });
let html = `<!doctype html><meta charset="utf-8"><title>挑选规则选中的贴图</title><style>body{font:13px/1.4 -apple-system,sans-serif;margin:20px}h2{margin-top:30px}
table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px;text-align:center;vertical-align:top}img{max-width:120px;max-height:120px;display:block;margin:auto}.diff{background:#fff3cd}.lib img{max-width:140px}</style>
<h1>挑选规则选中的贴图</h1><p>规则 1：v12–v14 实际用的。规则 2：先淘汰最差项明显偏高的（比最好的候选高 10 个百分点以上），剩下按平均误差、好 2% 才换。规则 3：同规则 2，但换的门槛按每个组件实测的两次运行波动（脸 6%、眼眶 9.4%、瞳孔 19.4%、嘴 12.9%）。规则 4：原贴图和候选地位相同，4 选 1——先淘汰明显缺陷，剩下直接选平均误差最小的。黄底 = 各规则选得不一样。都是用当时记录的打分离线重算，未重新运行。</p>`;
const lab = await openLab();
try {
  for (const id of ids) {
    const p8 = id.slice(0, 8);
    await lab.call('loadProject', projectInput(id));
    const orig = await lab.call('roleTextures'), roleOfAsset = Object.fromEntries(Object.entries(orig).map(([r, v]) => [v.assetId, r]));
    // 缩略图：原贴图 + 候选池
    const src = { original: {} };
    for (const comp of Object.keys(STAGE)) for (const r of ROLE_OF[comp]) src.original[r] = orig[r].png;
    for (const f of fs.readdirSync(labPath(`results/pool/${p8}`))) { const c = JSON.parse(fs.readFileSync(labPath(`results/pool/${p8}/${f}`), 'utf8')); src[f.replace('.json', '')] = Object.fromEntries(Object.entries(c.textures).map(([a, b]) => [roleOfAsset[a], b])); }
    const img = async (comp, name) => {
      const role = ROLE_OF[comp][0], key = `${p8}-${comp}-${name}.png`, b = (src[name] ?? src.original)[role] ?? src.original[role];
      if (!fs.existsSync(`${dir}/${key}`)) fs.writeFileSync(`${dir}/${key}`, Buffer.from(await lab.call('thumb', b, 160), 'base64'));
      return `<img src="pooltex/${key}"><div>${name === 'original' ? '原贴图' : name.replace(/^\w+-/, '候选 ')}</div>`;
    };
    html += `<h2>${p8}</h2><h3>候选贴图</h3><table class="lib"><tr><th></th><th>原贴图</th><th>候选 1</th><th>候选 2</th><th>候选 3</th></tr>`;
    for (const comp of Object.keys(STAGE)) { html += `<tr><th>${NAME[comp]}</th>`; for (const n of ['original', `${comp}-1`, `${comp}-2`, `${comp}-3`]) html += `<td>${await img(comp, n)}</td>`; html += '</tr>'; }
    html += `</table><h3>每次运行各规则选中的</h3><table><tr><th>运行</th><th>组件</th><th>规则 1（实际）</th><th>规则 2</th><th>规则 3</th><th>规则 4（4 选 1）</th></tr>`;
    for (const v of ['v12', 'v12b', 'v13', 'v13b', 'v14', 'v14b']) {
      const t = JSON.parse(fs.readFileSync(labPath(`results/agent/${v}/${p8}/trace.json`), 'utf8'));
      for (const l of t.poolLog) {
        const picks = [l.picked, rule(t, l, 0.02), rule(t, l, VAR[l.component]), rule(t, l, null)];
        const cls = new Set(picks).size > 1 ? ' class="diff"' : '';
        html += `<tr${cls}><td>${v.replace('b', ' 重跑')}</td><td>${NAME[l.component]}</td>${(await Promise.all(picks.map((n) => img(l.component, n)))).map((x) => `<td>${x}</td>`).join('')}</tr>`;
      }
    }
    html += '</table>';
  }
} finally { await lab.close(); }
fs.writeFileSync(labPath('results/human/pool-rules.html'), html);
console.log('ok');
