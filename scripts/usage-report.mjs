// 用法：node scripts/usage-report.mjs [标签前缀，如 v11 或 v11/1cf5ecc9]
import { summarize } from './usage.mjs';
const rows = summarize(process.argv[2] || '');
const fmt = (n) => (n >= 1e4 ? `${(n / 1e4).toFixed(1)} 万` : String(n));
let ti = 0, to = 0, tc = 0;
for (const r of rows.sort((a, b) => a.kind.localeCompare(b.kind))) {
  console.log(`${r.kind.padEnd(9)} ${r.model.padEnd(20)} 调用 ${String(r.calls).padStart(5)}  输入 ${fmt(r.in).padStart(9)}  输出 ${fmt(r.out).padStart(8)}`);
  if (r.kind !== 'regen') { ti += r.in; to += r.out; } tc += r.calls;
}
console.log(`合计（不含生图）输入 ${fmt(ti)}  输出 ${fmt(to)}；调用 ${tc} 次`);
