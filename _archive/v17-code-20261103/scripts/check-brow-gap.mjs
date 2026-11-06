// 核对眉眼距离：主图和各版本 riv 上 AI 定点 3 次取中位，按评审口径（眉毛下沿 → 上眼睑）和过程度量口径（眉中点 → 眼中心）各算一次，÷ 脸宽
import fs from 'node:fs';
import { openLab, projectInput, labPath } from './lab.mjs';
import { locate } from './landmarks.mjs';
import { setUsageTag } from './usage.mjs';
const DEFS = {
  brow_l_bottom: '画面左侧眉毛在眉毛正中处的下沿', eyelid_l_top: '画面左侧眼睛上眼睑（眼线上沿）在眼睛正中处',
  brow_r_bottom: '画面右侧眉毛在眉毛正中处的下沿', eyelid_r_top: '画面右侧眼睛上眼睑（眼线上沿）在眼睛正中处',
  brow_l: '画面左侧眉毛的中点', brow_r: '画面右侧眉毛的中点', eye_l: '画面左侧眼睛（眼白开口）的中心', eye_r: '画面右侧眼睛（眼白开口）的中心',
  cheek_l: '鼻底高度处脸的左边缘', cheek_r: '鼻底高度处脸的右边缘',
};
const med = (v) => { v = v.filter(Number.isFinite).sort((a, b) => a - b); return v[v.length >> 1]; };
const calc = (ps) => {
  const g = (k, i) => med(ps.map((p) => p?.[k]?.[i]));
  const FW = g('cheek_r', 0) - g('cheek_l', 0);
  const gap = ((g('eyelid_l_top', 1) - g('brow_l_bottom', 1)) + (g('eyelid_r_top', 1) - g('brow_r_bottom', 1))) / 2;
  const cc = ((g('eye_l', 1) + g('eye_r', 1)) - (g('brow_l', 1) + g('brow_r', 1))) / 2;
  return { gapFW: gap / FW, centerFW: cc / FW };
};
const [id, ...methods] = process.argv.slice(2);
setUsageTag(`brow-check/${id.slice(0, 8)}`);
const lab = await openLab();
try {
  await lab.call('loadProject', projectInput(id));
  const m = await lab.call('masterForPoints');
  const master = calc(await Promise.all([1, 2, 3].map(() => locate('gpt-6-astra', m, DEFS))));
  console.log('master', master.gapFW.toFixed(3), master.centerFW.toFixed(3));
  for (const method of methods) {
    const dir = labPath(`results/${method}/${id.slice(0, 8)}`);
    const vm = JSON.parse(fs.readFileSync(`${dir}/trace.json`, 'utf8')).finalVm;
    await lab.call('loadProject', projectInput(id));
    if (fs.existsSync(`${dir}/textures.json`)) await lab.call('restoreTextures', JSON.parse(fs.readFileSync(`${dir}/textures.json`, 'utf8')));
    const r = await lab.call('rivForPoints', vm);
    const v = calc(await Promise.all([1, 2, 3].map(() => locate('gpt-6-astra', r, DEFS))));
    const pct = (a, b) => `${a.toFixed(3)}（${a > b ? '+' : ''}${Math.round((a / b - 1) * 100)}%）`;
    console.log(method, '眉下沿→上眼睑', pct(v.gapFW, master.gapFW), '| 眉中点→眼中心', pct(v.centerFW, master.centerFW));
  }
} finally { await lab.close(); }
