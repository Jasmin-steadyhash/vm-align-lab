// 跑评测：每个模型答同一批题（从全部题里按 类型×档位 均匀抽 SAMPLE 题），记正确率、耗时、token
// 用法：node model-bench/run.mjs <模型 ...>    结果 model-bench/results/<模型>[-effort-<推理强度>][.<网关>].json
// 网关按 GATEWAY 环境变量（scripts/gateway.mjs）；EFFORT 设推理强度（reasoning_effort），不设就不传
import fs from 'node:fs';
import { GATEWAY, postChat, postResponses, postClaudeMessages, maxTok } from '../scripts/gateway.mjs';
const EFFORT = process.env.EFFORT || '';
// API=anthropic：走 Claude 网关原生格式（结果文件后缀 .claude-native），不看 GATEWAY；EFFORT 传 output_config.effort
const NATIVE = process.env.API === 'anthropic';
// API=responses：走 /v1/responses（结果文件后缀加 -responses），max 档只有这个接口支持；单次超时放宽到 10 分钟
const RESPONSES = process.env.API === 'responses';
const SUFFIX = NATIVE ? '.claude-native' : GATEWAY === 'tenantapi' ? (RESPONSES ? '.responses' : '') : `.${GATEWAY}${RESPONSES ? '-responses' : ''}`;
const all = JSON.parse(fs.readFileSync('model-bench/questions.json', 'utf8'));
const SAMPLE = Number(process.env.SAMPLE || 48);
// 固定抽样：每个 类型×档位 取 SAMPLE/4 题，按 id 排序后等距取
const groups = {};
for (const q of all) (groups[`${q.type}-${q.level}`] ??= []).push(q);
const qs = Object.values(groups).flatMap((g) => { g.sort((a, b) => a.id.localeCompare(b.id)); const n = SAMPLE / 4; return Array.from({ length: n }, (_, i) => g[Math.floor((i * g.length) / n)]); });
const PROMPT = {
  pick: '图里第一格是主图（目标角色），后面候选 1、候选 2 是同一个 2D 角色模型用两组参数渲染出的同一部位局部。贴图画风不同不用管，只比较这一部位的位置、大小、比例，哪个候选更像主图？只输出 JSON：{"answer":1|2}',
  change: '图里 A、B 是同一个 2D 角色模型用两组参数渲染出的同一部位局部，B 只改了一个参数。哪个部位变了、怎么变的（B 相对 A）？部位从 [头部整体, 身体, 脸, 前发, 后发, 眼睛, 虹膜, 嘴] 里选；变化从 [变大, 变小, 变宽, 变窄, 变高, 变扁, 上移, 下移, 两侧向中间, 两侧向外] 里选。只输出 JSON：{"part":"...","change":"..."}',
};
async function ask(model, q) {
  const b64 = fs.readFileSync(`model-bench/questions/${q.id}.png`).toString('base64');
  const t0 = Date.now();
  for (let attempt = 1; attempt <= 15; attempt++) {
    try {
      if (NATIVE) {
        const r = await postClaudeMessages([{ role: 'user', content: [{ type: 'text', text: PROMPT[q.type] }, { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }] }], { model, maxTokens: EFFORT ? 16000 : 3000, effort: EFFORT || undefined, signal: AbortSignal.timeout(240000) });
        if (r.ok) {
          let a = null; try { a = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1)); } catch {}
          return { a, ms: Date.now() - t0, usage: r.usage, tries: attempt };
        }
        if (r.status === 429) { await new Promise((o) => setTimeout(o, 20000)); continue; }
        if (attempt >= 3) return { err: `${r.status}`, ms: Date.now() - t0, tries: attempt };
        await new Promise((o) => setTimeout(o, 4000 * attempt));
        continue;
      }
      const res = await (RESPONSES ? postResponses : postChat)({ model, messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT[q.type] }, { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }] }], response_format: { type: 'json_object' }, ...maxTok(EFFORT ? 16000 : 3000), ...(EFFORT ? { reasoning_effort: EFFORT } : {}) },
        { signal: AbortSignal.timeout(RESPONSES ? 600000 : 240000) });
      if (res.status === 429) { await new Promise((o) => setTimeout(o, 20000)); continue; }
      if (!res.ok) { if (attempt >= 3) return { err: `${res.status}`, ms: Date.now() - t0, tries: attempt }; await new Promise((o) => setTimeout(o, 4000 * attempt)); continue; }
      const j = await res.json();
      let a = null; try { a = JSON.parse(j.choices[0].message.content.trim().replace(/^```(json)?|```$/g, '')); } catch {}
      return { a, ms: Date.now() - t0, usage: j.usage, tries: attempt };
    } catch (e) { if (attempt >= 3) return { err: e.message, ms: Date.now() - t0, tries: attempt }; }
  }
}
const grade = (q, a) => (!a ? false : q.type === 'pick' ? Number(a.answer) === q.answer : a.part === q.part && a.change === q.dir);
fs.mkdirSync('model-bench/results', { recursive: true });
await Promise.all(process.argv.slice(2).map(async (model) => {
  const rows = [];
  for (let i = 0; i < qs.length; i += 1) {
    const batch = await Promise.all(qs.slice(i, i + 1).map(async (q) => { const r = await ask(model, q); return { id: q.id, type: q.type, level: q.level, ok: grade(q, r.a), ...r }; }));
    rows.push(...batch);
    // 每题一行进度：第几题、题型-档位、对错、耗时、重试次数
    for (const r of batch) console.log(`[${model}${EFFORT ? ` ${EFFORT}` : ''} ${SUFFIX ? SUFFIX.slice(1) : 'tenantapi'}] ${rows.length}/${qs.length} ${r.type === 'pick' ? '选图' : '找变化'}-${r.level} ${r.err ? `失败 ${r.err}` : r.ok ? '✓' : '✗'} ${(r.ms / 1000).toFixed(1)}s${r.tries > 1 ? `（共请求 ${r.tries} 次）` : ''}`);
  }
  const acc = (f) => { const r = rows.filter(f); return `${r.filter((x) => x.ok).length}/${r.length}`; };
  const sum = { model, gateway: NATIVE ? 'claude-native' : GATEWAY, api: RESPONSES ? 'responses' : undefined, effort: EFFORT || null, pick: acc((r) => r.type === 'pick'), pickSubtle: acc((r) => r.type === 'pick' && r.level === '细微'), change: acc((r) => r.type === 'change'), changeSubtle: acc((r) => r.type === 'change' && r.level === '细微'), errors: rows.filter((r) => r.err).length, medianMs: rows.map((r) => r.ms).sort((a, b) => a - b)[rows.length >> 1], inTok: rows.reduce((s, r) => s + (r.usage?.prompt_tokens ?? 0), 0) };
  fs.writeFileSync(`model-bench/results/${model.replace(/\//g, '_')}${EFFORT ? `-effort-${EFFORT}` : ''}${SUFFIX}.json`, JSON.stringify({ sum, rows }, null, 2));
  console.log(JSON.stringify(sum));
}));
