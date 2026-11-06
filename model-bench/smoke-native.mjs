// 连通性重测：Gemini 走原生 generateContent（和 worker/src/generation.js 的 tenantapi 风格一致：/llm/v1beta/models/<m>:generateContent + Bearer）；
// 其余走 /v1/chat/completions，超时放宽到 6 分钟
import fs from 'node:fs';
const key = fs.readFileSync('../.dev.vars', 'utf8').match(/^IMAGE_API_KEY=(.*)$/m)[1].trim();
const BASE = 'https://tenantapi.anispark.ai/llm';
const png = fs.readFileSync('results/agent/v4/41e01792/final.png').toString('base64');
const Q = '左右两张角色图，哪张眼睛更大？只输出 JSON：{"answer":"左|右"}';
async function gemini(m) {
  const res = await fetch(`${BASE}/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: Q }, { inline_data: { mime_type: 'image/png', data: png } }] }], generationConfig: { responseMimeType: 'application/json' } }),
    signal: AbortSignal.timeout(360000),
  });
  const txt = await res.text();
  let ans = null, usage = null;
  try { const j = JSON.parse(txt); ans = j.candidates[0].content.parts.map((p) => p.text || '').join(''); usage = j.usageMetadata; } catch {}
  return { status: res.status, answer: ans?.slice(0, 60), usage, err: res.ok ? null : txt.slice(0, 160) };
}
async function chat(m) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: m, messages: [{ role: 'user', content: [{ type: 'text', text: Q }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }] }], max_tokens: 1500 }),
    signal: AbortSignal.timeout(360000),
  });
  const txt = await res.text();
  let ans = null;
  try { ans = JSON.parse(txt).choices[0].message.content; } catch {}
  return { status: res.status, answer: ans?.slice(0, 60), err: res.ok ? null : txt.slice(0, 160) };
}
const models = process.argv.slice(2);
await Promise.all(models.map(async (m) => {
  const t0 = Date.now();
  let r;
  try { r = await (m.startsWith('gemini') ? gemini(m) : chat(m)); } catch (e) { r = { status: 'ERR', err: e.message.slice(0, 120) }; }
  console.log(m.padEnd(26), Math.round((Date.now() - t0) / 1000) + 's', JSON.stringify(r));
}));
