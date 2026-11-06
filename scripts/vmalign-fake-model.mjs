// L2 用的假模型服务：按固定脚本回复，记下收到的每条请求。lab agent.mjs（/v1/chat/completions）和新 runner（/proxy，NDJSON）都连它。
// agent 回复 = v20 trace 里的原始动作；标点 = 真实标点样本 + 按序号的确定抖动；验收门 = 固定循环。图片不比（渲染有抖动），只记有几张。
// 用法：node scripts/vmalign-fake-model.mjs <端口> <trace 路径> <日志文件>，POST /reset 换日志文件并清零计数
import http from 'node:http';
import fs from 'node:fs';
const [port, tracePath, log0] = process.argv.slice(2);
let log = log0;
const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
const script = trace.steps.map((s) => s.raw);
const raw = JSON.parse(fs.readFileSync(new URL('../results/metric-check/raw.json', import.meta.url), 'utf8'));
const samplePoints = Object.values(raw).flatMap((v) => (Array.isArray(v) ? [v] : Object.values(v))).filter((g) => Array.isArray(g) && g.length && g[0] && typeof g[0] === 'object')[0][0];
const GATE_CYCLE = [2, 1, 2, 2, 1, 1, 0, 0, 2, 1];
let n = { agent: 0, landmark: 0, gate: 0 }, seq = 0;
const jitter = (count, i) => ((count * 7 + i * 3) % 5 - 2) * 0.4;
const answer = {
  agent: () => script[n.agent - 1] ?? '{"action":"finish","why":"脚本结束"}',
  landmark: () => JSON.stringify(Object.fromEntries(Object.entries(samplePoints).map(([k, p], i) => [k, Array.isArray(p) ? [p[0] + jitter(n.landmark, i), p[1] + jitter(n.landmark, i + 1)] : p]))),
  gate: () => JSON.stringify({ better: GATE_CYCLE[(n.gate - 1) % GATE_CYCLE.length], reason: `脚本 ${n.gate}` }),
};
const kindOf = (messages) => { const sys = messages.find((m) => m.role === 'system')?.content ?? ''; return /调参员/.test(sys) ? 'agent' : /还原度评审/.test(sys) ? 'gate' : 'landmark'; };
const normalize = (messages) => messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'image_url' ? '[IMG]' : p.text)) }));
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.url === '/reset') { const b = JSON.parse(Buffer.concat(chunks).toString()); log = b.log; n = { agent: 0, landmark: 0, gate: 0 }; seq = 0; fs.writeFileSync(log, ''); res.writeHead(200, CORS); res.end('ok'); return; }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const kind = kindOf(body.messages); n[kind]++; seq++;
    const content = answer[kind]();
    fs.appendFileSync(log, `${JSON.stringify({ seq, kind, n: n[kind], messages: normalize(body.messages) })}\n`);
    const usage = { prompt_tokens: 100, completion_tokens: 10 };
    if (req.url === '/proxy') {
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ t: 'ping' })}\n`);
      res.end(`${JSON.stringify({ t: 'result', ok: true, content, usage, model: kind })}\n`);
      return;
    }
    if (body.stream) {
      // worker/src/gptGateway.js 走流式：内容分两段发，最后一块带 usage
      res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream' });
      const mid = content.length >> 1;
      for (const part of [content.slice(0, mid), content.slice(mid)]) res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: part } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ model: body.model, choices: [], usage })}\n\ndata: [DONE]\n\n`);
      res.end();
      return;
    }
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }], usage }));
  });
}).listen(Number(port), () => console.log('fake model on', port));
