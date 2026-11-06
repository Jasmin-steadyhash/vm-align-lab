// 把 agent 的过程生成可浏览的网页：results/agent/<版本>/index.html，每个项目一节，每步：动作、参数、理由、观察图
import fs from 'node:fs';
import { labPath } from './lab.mjs';
const version = process.argv[2];
const root = labPath(`results/agent/${version}`);
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
let html = `<!doctype html><meta charset="utf-8"><title>agent ${version}</title><style>
body{font:14px/1.5 -apple-system,sans-serif;margin:24px;max-width:1400px}h2{margin-top:40px;border-top:2px solid #333;padding-top:16px}
.s{display:grid;grid-template-columns:360px 1fr;gap:16px;border-bottom:1px solid #ddd;padding:12px 0}.s img{max-width:100%;border:1px solid #ccc}
code{background:#f3f3f3;padding:1px 4px;word-break:break-all}.a{font-weight:bold}.set{color:#b40}.next{color:#c60}.reopen{color:#a00}.compare{color:#06c}.view{color:#080}.revert{color:#a0a}.finish{color:#000}</style>
<h1>agent ${version} 调整过程</h1>`;
for (const p of fs.readdirSync(root).filter((d) => fs.existsSync(`${root}/${d}/00-start.png`)).sort()) {
  const files = fs.readdirSync(`${root}/${p}`);
  const tr = fs.existsSync(`${root}/${p}/trace.json`) ? JSON.parse(fs.readFileSync(`${root}/${p}/trace.json`, 'utf8')) : null;
  html += `<h2>${p} ${tr ? `— ${tr.calls} 次调用，${Math.round(tr.ms / 1000)} 秒，${tr.finished ? '自己结束' : '用完预算'}` : '（还在跑）'}</h2>`;
  html += `<div class="s"><div><span class="a">起点</span></div><img src="${p}/00-start.png"></div>`;
  // v12 候选池：每个组件各候选按度量算出的差距（越小越接近主图）和选中的那张
  if (tr?.poolLog?.length) html += `<div class="s"><div><span class="a">选贴图（候选池）</span></div><div>${tr.poolLog.map((l) => `<div><b>${l.component}</b>：${l.rows.map((r) => { const t = `${r.name} ${r.dist}${r.out?.length ? `（${esc(r.out.join('；'))}）` : ''}`; return r.name === l.picked ? `<b>${t}</b>` : t; }).join('，')} → 选 <b>${l.picked}</b>${l.lowConf ? '（低置信）' : ''}</div>`).join('')}</div></div>`;
  const steps = tr?.steps ?? [];
  const byN = Object.fromEntries(files.filter((f) => /^\d\d-/.test(f) && f !== '00-start.png').map((f) => [Number(f.slice(0, 2)), f]));
  const ns = [...new Set([...Object.keys(byN).map(Number), ...steps.map((s) => s.n)])].sort((a, b) => a - b);
  for (const n of ns) {
    const st = steps.find((s) => s.n === n) ?? {};
    const act = st.action ?? (byN[n]?.split('-')[1]?.replace('.png', '') || '?');
    const detail = st.params ?? st.candidates ?? (st.to != null ? { 退回到: st.to } : st.box);
    html += `<div class="s"><div><span class="a ${act}">#${n} ${act}</span><br><code>${esc(JSON.stringify(detail ?? ''))}</code><p>${esc(st.why ?? '')}</p></div>${byN[n] ? `<img src="${p}/${byN[n]}">` : '<div></div>'}</div>`;
  }
}
fs.writeFileSync(`${root}/index.html`, html);
console.log(`${root}/index.html`);
