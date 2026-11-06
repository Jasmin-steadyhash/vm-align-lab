// 统计标点请求被内容审核拦截（400 invalid_prompt）的比例：每张图直接调 N 次，不重试
import fs from 'node:fs';
import { openLab, projectInput, labPath } from '../scripts/lab.mjs';
import { startVmOf } from '../scripts/start-vm.mjs';
import { POINTS_WHITE } from '../scripts/landmarks.mjs';
const key = fs.readFileSync(labPath('../.dev.vars'), 'utf8').match(/^IMAGE_API_KEY=(.*)$/m)[1].trim();
const N = 10, model = process.argv[2] || 'gpt-6-astra';
const ids = fs.readFileSync(labPath('data/dev-ids.txt'), 'utf8').trim().split('\n');
const imgs = [];
const lab = await openLab();
try {
  for (const id of ids) {
    const info = await lab.call('loadProject', projectInput(id));
    imgs.push([`${id.slice(0, 8)} 主图`, await lab.call('masterForPoints')]);
    imgs.push([`${id.slice(0, 8)} riv`, await lab.call('rivForPoints', { ...startVmOf(info.savedVm, await lab.call('tunableParams')), Head_scale: 100 })]);
  }
} finally { await lab.close(); }
const text = (W, H) => `这是一张 ${W}×${H} 像素的 2D 角色图。给出下列点的像素坐标（x 向右、y 向下，原点左上角）。"左/右"指画面左右。看不到的点给 null。\n${Object.entries(POINTS_WHITE).map(([k, v]) => `- ${k}：${v}`).join('\n')}\n只输出 JSON：{"head_top":[x,y],...}`;
for (const [name, im] of imgs) {
  const res = await Promise.all(Array.from({ length: N }, async () => {
    const r = await fetch('https://tenantapi.anispark.ai/llm/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: [{ type: 'text', text: text(im.W, im.H) }, { type: 'image_url', image_url: { url: `data:image/png;base64,${im.png}` } }] }], response_format: { type: 'json_object' }, max_tokens: 3000 }) });
    const b = await r.text();
    return r.ok ? 'ok' : /invalid_prompt/.test(b) ? 'flagged' : `http${r.status}`;
  }));
  const c = res.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {});
  console.log(model, name.padEnd(14), JSON.stringify(c));
}
