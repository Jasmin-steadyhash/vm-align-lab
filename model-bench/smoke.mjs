// 网关上能看图的对话模型：每个发一张图 + 要求 JSON，看能不能跑通、多久
import fs from 'node:fs';
const key = fs.readFileSync('../.dev.vars', 'utf8').match(/^IMAGE_API_KEY=(.*)$/m)[1].trim();
const models = process.argv.slice(2);
const png = fs.readFileSync('results/agent/v4/41e01792/final.png').toString('base64');
const out = {};
await Promise.all(models.map(async (m) => {
  const t0 = Date.now();
  try {
    const res = await fetch('https://tenantapi.anispark.ai/llm/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: m, messages: [{ role: 'user', content: [{ type: 'text', text: '左右两张角色图，哪张眼睛更大？只输出 JSON：{"answer":"左|右"}' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }] }], response_format: { type: 'json_object' }, max_tokens: 1500 }),
      signal: AbortSignal.timeout(180000),
    });
    const txt = await res.text();
    let ans = null;
    try { ans = JSON.parse(JSON.parse(txt).choices[0].message.content).answer; } catch {}
    out[m] = { status: res.status, ms: Date.now() - t0, answer: ans, err: res.ok ? null : txt.slice(0, 120) };
  } catch (e) { out[m] = { status: 'ERR', ms: Date.now() - t0, err: e.message.slice(0, 120) }; }
}));
for (const m of models) console.log(m.padEnd(36), JSON.stringify(out[m]));
fs.writeFileSync('model-bench/smoke.json', JSON.stringify(out, null, 2));
