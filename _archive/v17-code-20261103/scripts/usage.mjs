// token 用量台账：每次模型调用记一行到 logs/usage.jsonl（时间、标签、用途、模型、输入/输出 token）。
// 标签由调用方设（如 v11/1cf5ecc9），用途：agent / gate / landmark / judge / bench / regen（生图，只记次数）
import fs from 'node:fs';
import { labPath } from './lab.mjs';

const FILE = labPath('logs/usage.jsonl');
let tag = process.env.USAGE_TAG || 'untagged';
export const setUsageTag = (t) => { tag = t; };
export const getUsageTag = () => tag;

export function logUsage(kind, model, usage = {}, extra = {}) {
  const row = { at: new Date().toISOString(), tag, kind, model, in: usage.prompt_tokens ?? 0, out: usage.completion_tokens ?? 0, ...extra };
  fs.appendFileSync(FILE, `${JSON.stringify(row)}\n`);
}

/** 汇总：按 标签前缀 过滤，按 用途 × 模型 合计 */
export function summarize(prefix = '') {
  if (!fs.existsSync(FILE)) return [];
  const rows = fs.readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.tag.startsWith(prefix));
  const m = new Map();
  for (const r of rows) {
    const k = `${r.kind}|${r.model}`;
    const a = m.get(k) ?? { kind: r.kind, model: r.model, calls: 0, in: 0, out: 0 };
    a.calls += r.calls ?? 1; a.in += r.in; a.out += r.out;
    m.set(k, a);
  }
  return [...m.values()];
}
