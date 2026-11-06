// 评审：独立模型按评审标准逐项判断一组 VM 的还原度。
// 定标（2026-10-31，results/iterations.md「评估修正 · 第 1、2 轮」，对照 23 组人工标注）：
//   gpt-6.1-sol + A 格式（本脚本的整图 / 分区 / 眼睛图）+ judge/rubric-v2.md 9 项，每张评 3 次逐项多数票，
//   合成分 = 9 项（pass 1 / partial 0.5 / fail 0）平均，≥ 0.7 算达标。合成分 0.65–0.72 之间建议人工复核。
//   备选 gpt-6-astra（JUDGE_MODEL=gpt-6-astra），仅在 sol 不可用时用；换模型后要对比的版本必须用同一模型重评，分数不能混比。
//   RUBRIC=judge/rubric.md 可复现 v4–v12 时期的旧 15 项评分。
// 用法：node scripts/judge.mjs <结果名> <方法:来源> ... -- <项目 id ...>
//   方法来源：start（起点）、a（results/a/<项目>.json 的 vm）、agent/<版本>（results/agent/<版本>/<项目>/trace.json 的 finalVm）
// 每个（项目，方法）判 N 次（默认 2），结果存 results/judge/<结果名>/summary.json，观察图存同目录
import fs from 'node:fs';
import { openLab, projectInput, readJson, writeJson, labPath, avaPath, isE2E, projKey } from './lab.mjs';
import { LLM_URL, LLM_KEY, maxTok, postJson } from './gateway.mjs';
import { startVmOf } from './start-vm.mjs';
import { logUsage, setUsageTag } from './usage.mjs';

const args = process.argv.slice(2);
const sep = args.indexOf('--');
const [name, ...methods] = args.slice(0, sep);
const ids = args.slice(sep + 1);
const N = Number(process.env.N_JUDGE || 3);
const MODEL = process.env.JUDGE_MODEL || 'gpt-6.1-sol';
const RUBRIC_FILE = process.env.RUBRIC || 'judge/rubric-v2.md';
const RUBRIC = fs.readFileSync(labPath(RUBRIC_FILE), 'utf8');
const KEY_ITEMS = ['body_ratio', 'face_width', 'brow_eye', 'eye_size', 'iris_size', 'iris_position', 'no_glitch'];
const PASS_LINE = 0.7;
const devVars = fs.readFileSync(avaPath('.dev.vars'), 'utf8');
const KEY = devVars.match(/^IMAGE_API_KEY=(.*)$/m)[1].trim();
const outDir = `results/judge/${name}`;
fs.mkdirSync(labPath(outDir), { recursive: true });

async function ask(images) {
  const content = [{ type: 'text', text: '图 1：整图对比。图 2：分区放大图（头和肩、脸部、嘴）。图 3：眼睛放大图（左眼单只、双眼）。' }, ...images.map((b) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b}` } }))];
  for (let attempt = 1; ; attempt++) {
    const res = await postJson(LLM_URL, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: RUBRIC }, { role: 'user', content }], response_format: { type: 'json_object' }, ...maxTok(4000) }),
      // 网关偶尔不返回，不设超时会一直挂住（2026-10-31 卡过 30 分钟）
      signal: AbortSignal.timeout(180000),
    });
    if (res.ok) {
      const j = res.data; logUsage('judge', MODEL, j.usage);
      // 模型偶尔不按 JSON 输出：和网络错误一样重试
      try { return { parsed: JSON.parse(j.choices[0].message.content), usage: j.usage }; } catch (e) { Object.assign(res, { ok: false, status: 0, body: `bad content: ${e.message}` }); }
    }
    if (res.status === 429 && attempt < 15) { await new Promise((ok) => setTimeout(ok, 20000)); continue; }
    if (attempt >= 4) throw new Error(`judge ${res.status} ${res.body.slice(0, 200)}`);
    await new Promise((ok) => setTimeout(ok, 3000 * attempt));
  }
}

// 打分：pass 1、partial 0.5、fail 0，取平均 ×100；关键项有 fail 记为不可用
function scoreOf(items) {
  const vals = Object.values(items).map((v) => ({ pass: 1, partial: 0.5, fail: 0 })[v.verdict] ?? 0);
  return { score: Math.round((vals.reduce((s, v) => s + v, 0) / Math.max(1, vals.length)) * 100), keyFails: KEY_ITEMS.filter((k) => items[k]?.verdict === 'fail') };
}

function vmFor(method, id, start) {
  if (method === 'start') return start;
  if (method === 'a') { const f = labPath(`results/a/${projKey(id)}.json`); const a = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; return a?.ok ? a.vm : start; }
  const f = labPath(`results/${method}/${projKey(id)}/trace.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).finalVm : null;
}

const summaryFile = `${outDir}/summary.json`;
const summary = fs.existsSync(labPath(summaryFile)) ? readJson(summaryFile) : {};
const lab = await openLab();
try {
  for (const id of ids) {
    const info = await lab.call('loadProject', projectInput(id));
    await lab.call('loadMaster');
    const start = { ...startVmOf(info.savedVm, await lab.call('tunableParams')), ...(isE2E(id) ? info.savedVm : {}), Head_scale: 100 };
    // 所有方法同一取景（按起点冻结），观察图可比
    await lab.call('freezeFrame', start);
    for (const method of methods) {
      const vm = vmFor(method, id, start);
      if (!vm) continue;
      // 续跑：同一结果名下已用同一套标准评过的跳过
      if (summary[id]?.[method]?.rubric === RUBRIC_FILE && summary[id][method].model === MODEL) continue;
      // agent 换过贴图的按它最终的贴图渲染，否则恢复项目原贴图
      const texF = labPath(`results/${method}/${projKey(id)}/textures.json`);
      await lab.call('loadProject', projectInput(id));
      if (method.startsWith('agent/') && fs.existsSync(texF)) await lab.call('restoreTextures', JSON.parse(fs.readFileSync(texF, 'utf8')));
      await lab.call('freezeFrame', start);
      const tag = `${projKey(id)}-${method.replace(/\//g, '_')}`;
      setUsageTag(`judge/${method.replace(/^agent\//, '')}/${projKey(id)}`);
      const imgs = await lab.call('judgeImages', vm);
      fs.writeFileSync(labPath(`${outDir}/${tag}-full.png`), Buffer.from(imgs.full, 'base64'));
      fs.writeFileSync(labPath(`${outDir}/${tag}-grid.png`), Buffer.from(imgs.grid, 'base64'));
      if (imgs.eyes) fs.writeFileSync(labPath(`${outDir}/${tag}-eyes.png`), Buffer.from(imgs.eyes, 'base64'));
      const runs = [];
      for (let i = 0; i < N; i++) {
        const { parsed } = await ask([imgs.full, imgs.grid, imgs.eyes].filter(Boolean));
        runs.push({ ...scoreOf(parsed.items || {}), items: parsed.items, summary: parsed.summary });
      }
      // 每项按多数票定（3 次里 2 次以上相同），平局取较差的
      const order = ['fail', 'partial', 'pass'];
      const itemIds = Object.keys(runs[0].items || {});
      const majority = Object.fromEntries(itemIds.map((k) => {
        const vs = runs.map((r) => r.items?.[k]?.verdict).filter(Boolean);
        const best = order.map((v) => [v, vs.filter((x) => x === v).length]).sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))[0][0];
        return [k, best];
      }));
      const maj = scoreOf(Object.fromEntries(Object.entries(majority).map(([k, v]) => [k, { verdict: v }])));
      // 达标：合成分（= 多数票分 / 100）≥ 0.7
      const pass = maj.score / 100 >= PASS_LINE;
      (summary[id] ??= {})[method] = { rubric: RUBRIC_FILE, model: MODEL, majority, majorityScore: maj.score, pass, majorityKeyFails: maj.keyFails, runs, mean: Math.round(runs.reduce((s, r) => s + r.score, 0) / runs.length), unusable: runs.some((r) => r.keyFails.length) };
      writeJson(summaryFile, summary);
      console.log(tag, 'majority', maj.score, pass ? '达标' : '不达标', 'keyFails', maj.keyFails.join('+') || '-', '| runs', runs.map((r) => r.score).join(','));
    }
  }
} finally { await Promise.race([lab.close(), new Promise((o) => setTimeout(o, 15000))]); }  // 关浏览器偶尔卡住，最多等 15 秒
process.exit(0);
