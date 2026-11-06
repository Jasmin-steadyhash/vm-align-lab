// 按项目统计每次运行的全部 token 和费用：agent 运行（tag = <版本>/<项目>）+ 最终评审（tag = judge/<版本>/<项目>）
// 单价（每百万 token，2026-11-01 网关后台）：gpt-6.1-sol 入 $2 / 出 $10；gpt-6-astra 入 $10 / 出 $50
// 用法：node scripts/cost-report.mjs <版本 ...>
import fs from 'node:fs';
import { labPath } from './lab.mjs';
const PRICE = { 'gpt-6.1-sol': [2, 10], 'gpt-6-astra': [10, 50], 'pe-g/gpt-6-astra': [10, 50] };
const ROLE = { agent: 'agent 决策', landmark: 'AI 标点', gate: '阶段验收', guard: '最终兜底', judge: '最终评审', regen: '生图（次数，未计价）' };
const rows = fs.readFileSync(labPath('logs/usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const money = (r) => { const p = PRICE[r.model]; return p ? (r.in * p[0] + r.out * p[1]) / 1e6 : 0; };
const fmt = (n) => (n >= 1e4 ? `${(n / 1e4).toFixed(1)} 万` : String(n));
const all = {};
// 项目：从用量记录里找这个版本跑过的（线上项目简称 / 完整流程 e2e-<名字>）；完整流程的生图记在 e2e-gen/<项目>
const projectsOf = (ver) => [...new Set(rows.map((r) => r.tag?.match(new RegExp(`^(?:judge/)?${ver}/(.+)$`))?.[1]).filter(Boolean))];
for (const ver of process.argv.slice(2)) for (const p8 of projectsOf(ver)) {
  const mine = rows.filter((r) => r.tag === `${ver}/${p8}` || r.tag === `judge/${ver}/${p8}` || (p8.startsWith('e2e-') && r.tag === `e2e-gen/${p8}`));
  if (!mine.length) continue;
  const tf = labPath(`results/agent/${ver}/${p8}/trace.json`);
  const ms = fs.existsSync(tf) ? JSON.parse(fs.readFileSync(tf, 'utf8')).ms : null;
  const g = {};
  for (const r of mine) { const k = `${ROLE[r.kind] ?? r.kind}|${r.model}`; (g[k] ??= { calls: 0, in: 0, out: 0, usd: 0, ms: [] }); g[k].calls += r.calls ?? 1; g[k].in += r.in || 0; g[k].out += r.out || 0; g[k].usd += money(r); if (r.ms) g[k].ms.push(r.ms); }
  const lat = (v) => { if (!v.length) return ''; v = [...v].sort((a, b) => a - b); return `  耗时 中位 ${(v[v.length >> 1] / 1000).toFixed(1)}s / P90 ${(v[Math.floor(v.length * 0.9)] / 1000).toFixed(1)}s`; };
  const usd = Object.values(g).reduce((a, b) => a + b.usd, 0);
  console.log(`\n${p8}  ${ver}  agent 运行 ${ms ? Math.round(ms / 60000) + ' 分钟' : '-'}  合计 $${usd.toFixed(2)}`);
  for (const [k, v] of Object.entries(g)) { const [role, model] = k.split('|'); console.log(`   ${role.padEnd(8)} ${model.padEnd(18)} ${String(v.calls).padStart(4)} 次  入 ${fmt(v.in).padStart(8)}  出 ${fmt(v.out).padStart(7)}  $${v.usd.toFixed(2)}${lat(v.ms)}`); }
  (all[ver] ??= []).push({ usd, ms });
}
console.log('\n每个项目跑一次的平均：');
for (const [ver, v] of Object.entries(all)) console.log(`   ${ver.padEnd(6)} $${(v.reduce((a, b) => a + b.usd, 0) / v.length).toFixed(2)}  ${Math.round(v.reduce((a, b) => a + (b.ms || 0), 0) / v.length / 60000)} 分钟（${v.length} 个）`);
