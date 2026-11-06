// 评审打分的公共部分：scripts/judge.mjs（最终评审）和 agent 的最终兜底共用，保证同一套标准
// 定标见 judge.mjs 开头：gpt-6.1-sol + judge/rubric-v2.md 9 项，每张评 3 次逐项多数票，合成分 ≥ 0.7 达标
import fs from 'node:fs';
import { labPath } from './lab.mjs';
import { logUsage } from './usage.mjs';
import { postJson } from './gateway.mjs';
export const JUDGE_MODEL = process.env.JUDGE_MODEL || 'gpt-6.1-sol';
export const RUBRIC_FILE = process.env.RUBRIC || 'judge/rubric-v2.md';
const RUBRIC = fs.readFileSync(labPath(RUBRIC_FILE), 'utf8');
export const KEY_ITEMS = ['body_ratio', 'face_width', 'brow_eye', 'eye_size', 'iris_size', 'iris_position', 'no_glitch'];
export const PASS_LINE = 0.7;
const KEY = fs.readFileSync(labPath('../.dev.vars'), 'utf8').match(/^IMAGE_API_KEY=(.*)$/m)[1].trim();

export async function ask(images, kind = 'judge') {
  const content = [{ type: 'text', text: '图 1：整图对比。图 2：分区放大图（头和肩、脸部、嘴）。图 3：眼睛放大图（左眼单只、双眼）。' }, ...images.map((b) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b}` } }))];
  for (let attempt = 1; ; attempt++) {
    const t0 = Date.now();
    const res = await postJson('https://tenantapi.anispark.ai/llm/v1/chat/completions', {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: JUDGE_MODEL, messages: [{ role: 'system', content: RUBRIC }, { role: 'user', content }], response_format: { type: 'json_object' }, max_tokens: 4000 }),
      // 网关偶尔不返回，不设超时会一直挂住（2026-10-31 卡过 30 分钟）
      signal: AbortSignal.timeout(180000),
    });
    if (res.ok) {
      const j = res.data; logUsage(kind, JUDGE_MODEL, j.usage, { ms: Date.now() - t0 });
      // 模型偶尔不按 JSON 输出：和网络错误一样重试
      try { return { parsed: JSON.parse(j.choices[0].message.content), usage: j.usage }; } catch (e) { Object.assign(res, { ok: false, status: 0, body: `bad content: ${e.message}` }); }
    }
    if (res.status === 429 && attempt < 15) { await new Promise((ok) => setTimeout(ok, 20000)); continue; }
    if (attempt >= 4) throw new Error(`judge ${res.status} ${res.body.slice(0, 200)}`);
    await new Promise((ok) => setTimeout(ok, 3000 * attempt));
  }
}
// 打分：pass 1、partial 0.5、fail 0，取平均 ×100；关键项有 fail 记为不可用
export function scoreOf(items) {
  const vals = Object.values(items).map((v) => ({ pass: 1, partial: 0.5, fail: 0 })[v.verdict] ?? 0);
  return { score: Math.round((vals.reduce((s, v) => s + v, 0) / Math.max(1, vals.length)) * 100), keyFails: KEY_ITEMS.filter((k) => items[k]?.verdict === 'fail') };
}
// 每项按多数票定（N 次里相同最多的），平局取较差的
export function majorityOf(runs) {
  const order = ['fail', 'partial', 'pass'];
  const itemIds = Object.keys(runs[0]?.items || {});
  const majority = Object.fromEntries(itemIds.map((k) => {
    const vs = runs.map((r) => r.items?.[k]?.verdict).filter(Boolean);
    return [k, order.map((v) => [v, vs.filter((x) => x === v).length]).sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))[0][0]];
  }));
  return { majority, ...scoreOf(Object.fromEntries(Object.entries(majority).map(([k, v]) => [k, { verdict: v }]))) };
}
/** 当前页面状态（项目、贴图、取景已就位）下给一组 VM 打分：N 次评审 → 多数票合成分 */
export async function judgeVm(lab, vm, n = 3, kind = 'judge') {
  const imgs = await lab.call('judgeImages', vm);
  const runs = await Promise.all(Array.from({ length: n }, async () => { const { parsed } = await ask([imgs.full, imgs.grid, imgs.eyes].filter(Boolean), kind); return { ...scoreOf(parsed.items || {}), items: parsed.items, summary: parsed.summary }; }));
  const m = majorityOf(runs);
  return { ...m, pass: m.score / 100 >= PASS_LINE, runs, imgs };
}
