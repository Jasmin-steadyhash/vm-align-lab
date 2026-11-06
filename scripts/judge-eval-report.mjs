// 评审测评汇总：每个（模型，格式）N 次多数票 vs 人工标注；完全一致率、相差≤1档、宽严偏向（评审 - 人工，档）、自身一致性（N 次两两相同的比例），以及逐项完全一致率
// 用法：node scripts/judge-eval-report.mjs [取前几次投票，默认全部]
import fs from 'node:fs';
import { readJson, labPath } from './lab.mjs';
const H = readJson('results/human/labels.json');
const IDS = ['body_ratio', 'face_width', 'brow_eye', 'eye_size', 'iris_size', 'iris_position', 'no_glitch', 'hair_front', 'body_center'];
const V = { pass: 2, partial: 1, fail: 0 };
const take = Number(process.argv[2] || 99);
const root = labPath('results/human/eval/runs');
const rows = [];
for (const model of fs.existsSync(root) ? fs.readdirSync(root) : []) for (const fmt of fs.readdirSync(`${root}/${model}`)) {
  const files = fs.readdirSync(`${root}/${model}/${fmt}`).filter((f) => f.endsWith('.json'));
  let ex = 0, adj = 0, n = 0, bias = 0, pairSame = 0, pairs = 0, errs = 0;
  const per = Object.fromEntries(IDS.map((i) => [i, [0, 0]]));
  for (const f of files) {
    const no = f.replace('.json', ''), runs = JSON.parse(fs.readFileSync(`${root}/${model}/${fmt}/${f}`, 'utf8')).slice(0, take);
    errs += runs.filter((r) => !r || r.error).length;
    for (const id of IDS) {
      const vs = runs.map((r) => r?.[id]?.verdict).filter((v) => v in V);
      if (!vs.length || !(H[no]?.[id] in V)) continue;
      for (let a = 0; a < vs.length; a++) for (let b = a + 1; b < vs.length; b++) { pairs++; if (vs[a] === vs[b]) pairSame++; }
      // 多数票，平局取较差
      const cnt = (v) => vs.filter((x) => x === v).length;
      const maj = ['fail', 'partial', 'pass'].sort((a, b) => cnt(b) - cnt(a))[0];
      const h = V[H[no][id]], j = V[maj];
      n++; if (h === j) { ex++; per[id][0]++; } if (Math.abs(h - j) <= 1) adj++; bias += j - h; per[id][1]++;
    }
  }
  // 整体是否达标（只有第 2 轮有）：多数票 vs 人工；不达标召回 = 人工判不达标的组里评审也判不达标的比例
  let oN = 0, oEx = 0, hFail = 0, caught = 0, jFail = 0;
  for (const f of files) {
    const no = f.replace('.json', ''), runs = JSON.parse(fs.readFileSync(`${root}/${model}/${fmt}/${f}`, 'utf8')).slice(0, take);
    const vs = runs.map((r) => r?.overall?.verdict).filter((v) => v in V);
    if (!vs.length || !(H[no]?.overall in V)) continue;
    const cnt = (v) => vs.filter((x) => x === v).length;
    const maj = ['fail', 'partial', 'pass'].sort((a, b) => cnt(b) - cnt(a))[0];
    oN++; if (maj === H[no].overall) oEx++;
    if (H[no].overall === 'fail') { hFail++; if (maj === 'fail') caught++; }
    if (maj === 'fail') jFail++;
  }
  rows.push({ model, fmt, groups: files.length, errs, overall: oN ? `整体一致 ${oEx}/${oN}，不达标抓到 ${caught}/${hFail}，评审判不达标 ${jFail}` : '', exact: ex / n, adj: adj / n, bias: bias / n, self: pairSame / pairs, per: Object.fromEntries(IDS.map((i) => [i, per[i][1] ? per[i][0] / per[i][1] : null])) });
}
rows.sort((a, b) => b.exact - a.exact);
const pct = (x) => (x == null ? '  - ' : `${Math.round(x * 100)}%`.padStart(4));
console.log('模型'.padEnd(22), '格式 组数 错误 | 完全一致 ≤1档 偏向(档) 自身一致 |', IDS.map((i) => i.slice(0, 6)).join(' '));
for (const r of rows) console.log(r.model.padEnd(22), r.fmt.padEnd(4), String(r.groups).padStart(3), String(r.errs).padStart(4), '|', pct(r.exact).padStart(7), pct(r.adj).padStart(5), (r.bias >= 0 ? '+' : '') + r.bias.toFixed(2).padStart(6), pct(r.self).padStart(8), '|', IDS.map((i) => pct(r.per[i]).padStart(6)).join(' '), r.overall ? `\n${''.padEnd(27)}${r.overall}` : '');
