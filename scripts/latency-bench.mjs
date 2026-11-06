// 调用耗时实测：同一张图、同一个标点请求，sol / astra 交替各调 N 次（顺序调用，不并发）
// 用法：node scripts/latency-bench.mjs <项目 id> [N=8]
import { openLab, projectInput } from './lab.mjs';
import { locate, POINTS_WHITE } from './landmarks.mjs';
import { setUsageTag } from './usage.mjs';
const [id, n0] = process.argv.slice(2), N = Number(n0 || 8);
setUsageTag('latency-bench');
const lab = await openLab();
const img = await (async () => { await lab.call('loadProject', projectInput(id)); await lab.call('loadMaster'); return lab.call('masterForPoints'); })();
await lab.close();
const T = { 'gpt-6.1-sol': [], 'gpt-6-astra': [] };
for (let i = 0; i < N; i++) for (const m of Object.keys(T)) { const t0 = Date.now(); const r = await locate(m, img, POINTS_WHITE); T[m].push({ s: (Date.now() - t0) / 1000, ok: !!r }); console.log(m.padEnd(12), `#${i + 1}`, ((Date.now() - t0) / 1000).toFixed(1) + 's', r ? '' : '失败'); }
const q = (v, p) => { v = [...v].sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.floor(p * v.length))]; };
for (const [m, v] of Object.entries(T)) { const s = v.map((x) => x.s); console.log(m.padEnd(12), '中位', q(s, 0.5).toFixed(1) + 's', ' 最快', Math.min(...s).toFixed(1) + 's', ' 最慢', Math.max(...s).toFixed(1) + 's', ' 失败', v.filter((x) => !x.ok).length); }
