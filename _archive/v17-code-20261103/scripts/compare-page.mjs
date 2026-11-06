// 对比网页：每个项目一行，主图 + 起点 + 各版本最终 riv（同一取景，评审用的整图），下面标评审分和关键项
import fs from 'node:fs';
import { readJson, labPath } from './lab.mjs';
// 分数优先用新评审（results/judge/std2，合成分 ≥ 0.7 达标），图也用新评审那次的；没评过的退回旧评审 devcmp
const old = readJson('results/judge/devcmp/summary.json'), std = readJson('results/judge/std2/summary.json');
const s = {};
for (const id of Object.keys(old)) { s[id] = {}; for (const [m, r] of Object.entries(old[id])) s[id][m] = { ...r, dir: 'devcmp' }; for (const [m, r] of Object.entries(std[id] ?? {})) s[id][m] = { ...r, dir: 'std2' }; }
const METHODS = [['start', '起点'], ['agent/v4', 'v4'], ['agent/v5', 'v5'], ['agent/v6', 'v6'], ['agent/v6-61', 'v6-61'], ['agent/v7', 'v7'], ['agent/v7b', 'v7 重跑'],
  ['agent/v8', 'v8'], ['agent/v9', 'v9'], ['agent/v9b', 'v9 重跑'], ['agent/v10', 'v10'], ['agent/v10b', 'v10 重跑'],
  ['agent/v11', 'v11'], ['agent/v11b', 'v11 重跑'], ['agent/v12', 'v12'], ['agent/v12b', 'v12 重跑'],
  ['agent/v13', 'v13'], ['agent/v13b', 'v13 重跑'], ['agent/v14', 'v14'], ['agent/v14b', 'v14 重跑'], ['agent/v17', 'v17']];
const KEY_NAME = { body_ratio: '头身比例', face_width: '脸宽', brow_eye: '眉眼距离', eye_size: '眼睛大小', iris_size: '虹膜大小', iris_position: '虹膜位置', no_glitch: '穿帮' };
let html = `<!doctype html><meta charset="utf-8"><title>主图与各版本对比</title><style>
body{font:13px/1.4 -apple-system,sans-serif;margin:20px}h2{margin:28px 0 8px}
.row{display:flex;gap:8px;overflow-x:auto;padding-bottom:8px}
.cell{flex:0 0 auto;width:220px;text-align:center}
.crop{width:220px;height:385px;overflow:hidden;position:relative;border:1px solid #ccc;background:#fff}
.crop img{position:absolute;top:-14px;height:440px}
.crop.master img{left:0}.crop.riv img{right:0}
.name{font-weight:bold;margin-top:4px}.score{font-size:18px;font-weight:bold}.good{color:#080}.bad{color:#b00}.fails{color:#b00;font-size:12px;min-height:16px}
</style><h1>主图与各版本最终效果</h1><p>同一取景（按起点冻结）；分数：新评审（gpt-6.1-sol、9 项、3 次多数票）的合成分，≥ 0.70 为达标（绿）；标「旧评审」的是 v4–v8 等只用旧标准评过的（满分 100）。红字为不过的关键项。点图看大图。</p>`;
for (const id of Object.keys(s)) {
  const p = id.slice(0, 8);
  html += `<h2>${p}</h2><div class="row">`;
  const first = METHODS.find(([m]) => s[id][m]);
  html += `<div class="cell"><a href="judge/${s[id][first[0]].dir}/${p}-${first[0].replace(/\//g, '_')}-full.png" target="_blank"><div class="crop master"><img src="judge/${s[id][first[0]].dir}/${p}-${first[0].replace(/\//g, '_')}-full.png"></div></a><div class="name">主图</div></div>`;
  const startScore = s[id].start?.majorityScore;
  for (const [m, label] of METHODS) {
    const r = s[id][m];
    if (!r) continue;
    const f = `judge/${r.dir}/${p}-${m.replace(/\//g, '_')}-full.png`;
    if (!fs.existsSync(labPath(`results/${f}`))) continue;
    const cls = startScore == null || m === 'start' ? '' : r.majorityScore > startScore ? 'good' : 'bad';
    const sc = r.dir === 'std2' ? `${(r.majorityScore / 100).toFixed(2)} ${r.pass ? '达标' : '不达标'}` : `${r.majorityScore}（旧评审）`;
    const cls2 = r.dir === 'std2' ? (r.pass ? 'good' : 'bad') : cls;
    html += `<div class="cell"><a href="${f}" target="_blank"><div class="crop riv"><img src="${f}"></div></a><div class="name">${label}</div><div class="score ${cls2}">${sc}</div><div class="fails">${(r.majorityKeyFails || []).map((k) => KEY_NAME[k] || k).join('、')}</div></div>`;
  }
  html += '</div>';
}
fs.writeFileSync(labPath('results/compare.html'), html);
console.log(labPath('results/compare.html'));
