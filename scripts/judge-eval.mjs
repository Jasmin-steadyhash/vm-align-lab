// 评审准确度测评：<模型> <格式 A|B|C> 每组评 N 次，结果存 results/human/eval/runs/<模型>/<格式>/NN.json（已有的跳过，可续跑）
// 用法：node scripts/judge-eval.mjs <模型> <格式> [N=5]；网关按 GATEWAY 环境变量，非默认网关的结果存 runs/<模型>@<网关>/
import fs from 'node:fs';
import { readJson, writeJson, labPath } from './lab.mjs';
import { logUsage, setUsageTag } from './usage.mjs';
import { GATEWAY, postChat, maxTok } from './gateway.mjs';
const [model, fmt, n0] = process.argv.slice(2);
const N = Number(n0 || 5);
// 第 2 轮格式名 A2 = A 的图 + rubric-v3（多一项整体是否达标），结果单独存，和第 1 轮分开
const IMG_FMT = fmt.replace(/2$/, '');
const RUBRIC = fs.readFileSync(labPath(fmt.endsWith('2') ? 'judge/rubric-v3.md' : 'judge/rubric-v2.md'), 'utf8');
const FILES = { A: ['full', 'grid', 'eyes'], B: ['full', 'face', 'eyes'], C: ['full', 'eyes'] };
const INTRO = {
  A: '图 1：整图对比（左主图，右 riv，按角色外框对齐取景）。图 2：分区放大（头和肩、脸部、嘴；每行左主图右 riv）。图 3：眼睛放大（左眼单只、双眼；每行左主图右 riv）。',
  B: '图 1：整图对比（左主图，右 riv；riv 已缩放到和主图脸一样大、两眼中心重合）。图 2：脸部放大对比（同一位置，左主图右 riv）。图 3：眼眉放大对比（同一位置，左主图右 riv）。',
  C: '图 1：叠加图——主图在下，riv 以 50% 透明度盖在上面（已按脸对齐：脸一样大、两眼中心重合）；位置一致的地方重合，不一致的地方出现重影。riv 身体下半截被裁，裁切线以下只有主图。图 2：眼眉区域三行：主图 / riv / 两者叠加。',
};
const keys = readJson('results/human/key.json').filter((k) => !k.dup).map((k) => k.no);
const dir = `results/human/eval/runs/${model.replace(/\//g, '_')}${GATEWAY === 'tenantapi' ? '' : `@${GATEWAY}`}/${fmt}`;
setUsageTag(`judge-eval/${model}/${fmt}`);
async function ask(images) {
  const content = [{ type: 'text', text: INTRO[IMG_FMT] }, ...images.map((b) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b}` } }))];
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await postChat({ model, messages: [{ role: 'system', content: RUBRIC }, { role: 'user', content }], ...maxTok(4000) },
        { signal: AbortSignal.timeout(300000) });
      if (res.ok) {
        const j = await res.json();
        logUsage('judge-eval', model, j.usage);
        const txt = j.choices[0].message.content;
        return JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
      }
      if (res.status === 429 && attempt < 15) { await new Promise((o) => setTimeout(o, 20000)); continue; }
      if (attempt >= 4) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (e) { if (attempt >= 4) throw e; }
    await new Promise((o) => setTimeout(o, 3000 * attempt));
  }
}
const todo = keys.filter((no) => !fs.existsSync(labPath(`${dir}/${no}.json`)));
let next = 0;
await Promise.all([1, 2, 3].map(async () => {
  while (next < todo.length) {
    const no = todo[next++];
    const imgs = FILES[IMG_FMT].map((s) => fs.readFileSync(labPath(`results/human/eval/${IMG_FMT}/${no}-${s}.png`)).toString('base64'));
    const runs = [];
    for (let i = 0; i < N; i++) {
      try { const r = await ask(imgs); runs.push(r.items ? { ...r.items, ...(r.overall ? { overall: r.overall } : {}) } : null); } catch (e) { runs.push({ error: e.message }); }
    }
    writeJson(`${dir}/${no}.json`, runs);
    console.log(model, fmt, no, runs.filter((r) => r && !r.error).length, '/', N);
  }
}));
