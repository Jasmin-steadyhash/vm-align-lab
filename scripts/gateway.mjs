// 模型网关：默认旧网关（tenantapi /llm + IMAGE_API_KEY）；
//   GATEWAY=agent 时用 .dev.vars 的 GPT_URL + GPT_API_KEY（GPT 新网关，不带 /llm）；
//   GATEWAY=claude 时用 CLAUDE_URL + CLAUDE_API_KEY（Claude 网关，只有 Claude 模型）
// 新网关上 sol 不认 max_tokens，要用 max_completion_tokens
// 两个新网关都会在约 30 秒断开没返回完的请求（2026-11-03 实测），postChat 对新网关走流式接收、拼成普通响应
import fs from 'node:fs';
import { labPath } from './lab.mjs';
// worktree 里的 .dev.vars 是旧副本；新网关的变量只在主仓库的 .dev.vars 里，两份都读，本地的优先
const MAIN_VARS = '/Users/zhangjiawei/repos/ava-studio/.dev.vars';
const vars = fs.readFileSync(labPath('../.dev.vars'), 'utf8') + '\n' + (fs.existsSync(MAIN_VARS) ? fs.readFileSync(MAIN_VARS, 'utf8') : '');
const get = (k) => (vars.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
const GATEWAYS = {
  tenantapi: { url: 'https://tenantapi.anispark.ai/llm/v1/chat/completions', key: get('IMAGE_API_KEY'), maxKey: 'max_tokens', stream: false },
  agent: { url: `${get('GPT_URL').replace(/\/$/, '')}/v1/chat/completions`, key: get('GPT_API_KEY'), maxKey: 'max_completion_tokens', stream: true },
  claude: { url: `${get('CLAUDE_URL').replace(/\/$/, '')}/v1/chat/completions`, key: get('CLAUDE_API_KEY'), maxKey: 'max_tokens', stream: true },
};
export const GATEWAY = GATEWAYS[process.env.GATEWAY] ? process.env.GATEWAY : 'tenantapi';
const G = GATEWAYS[GATEWAY];
// L2 对照测试：连本地假模型服务（scripts/vmalign-fake-model.mjs）
export const LLM_URL = process.env.LLM_URL_OVERRIDE || G.url;
export const LLM_KEY = G.key;
export const maxTok = (n) => ({ [G.maxKey]: n });

/**
 * POST 一次 JSON 请求并读完响应：发请求、读响应内容、解析 JSON 任何一步出错（含读内容途中超时、内容不是 JSON）都返回 status 0，
 * 由调用方按网络错误重试——只包住 fetch 时，响应头到了、内容读到一半超时会变成未捕获的异常，整个进程退出（2026-11-05 2e70e494）。
 * 成功 { ok: true, status, data }；失败 { ok: false, status, body }
 */
export async function postJson(url, init) {
  let res;
  try { res = await fetch(url, { method: 'POST', ...init }); } catch (e) { return { ok: false, status: 0, body: `network: ${e.cause?.code ?? e.message}` }; }
  if (!res.ok) return { ok: false, status: res.status, body: await res.text().catch((e) => `read body failed: ${e.message}`) };
  try { return { ok: true, status: res.status, data: await res.json() }; } catch (e) { return { ok: false, status: 0, body: `read json failed: ${e.message}` }; }
}

/** POST 一次 chat/completions，返回和 fetch 一样的 Response；新网关内部走流式，拼回 { choices: [{ message: { content } }], usage } */
export async function postChat(body, { signal } = {}) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${G.key}` };
  if (!G.stream) return fetch(G.url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  const res = await fetch(G.url, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }), signal });
  if (!res.ok) return res;
  const dec = new TextDecoder();
  let buf = '', content = '', usage = null, model = null;
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const m = line.match(/^data: (.*)$/);
      if (!m || m[1] === '[DONE]') continue;
      let d;
      try { d = JSON.parse(m[1]); } catch { continue; }
      content += d.choices?.[0]?.delta?.content ?? '';
      if (d.usage) usage = d.usage;
      model ??= d.model ?? null;
    }
  }
  return new Response(JSON.stringify({ model, choices: [{ message: { role: 'assistant', content } }], usage }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/**
 * POST 一次 /v1/responses（流式接收），入参和返回都是 chat/completions 的形式，调用方不用改。
 * Chat Completions 的 reasoning_effort 最高 xhigh，只有 Responses API 接受 max（2026-11-06 实测）。
 */
export async function postResponses({ model, messages, response_format, reasoning_effort, ...rest }, { signal } = {}) {
  const part = (p) => (p.type === 'image_url' ? { type: 'input_image', image_url: p.image_url.url } : { type: 'input_text', text: p.text });
  const body = {
    model, stream: true, max_output_tokens: rest[G.maxKey],
    input: messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map(part) })),
    ...(reasoning_effort ? { reasoning: { effort: reasoning_effort } } : {}),
    ...(response_format ? { text: { format: response_format } } : {}),
  };
  const res = await fetch(G.url.replace(/chat\/completions$/, 'responses'), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${G.key}` }, body: JSON.stringify(body), signal });
  if (!res.ok) return res;
  // 收到完整答案后最多再等 10 秒结束信号（usage 在里面，没等到就记 null）；答案出来前 120 秒没有新数据算卡住，断开由调用方重发
  // 2026-11-06 实测：答案已全部收到，结束信号却一直不来，白等到超时后整题重发。思考阶段流里没有事件，所以这里不能太短
  const dec = new TextDecoder(), rd = res.body.getReader();
  let buf = '', content = '', usage = null, failed = null, textDone = false, stalled = false;
  while (true) {
    let timer;
    const r = await Promise.race([rd.read(), new Promise((o) => { timer = setTimeout(() => o('idle'), textDone ? 10000 : 120000); })]);
    clearTimeout(timer);
    if (r === 'idle') { stalled = !textDone; rd.cancel().catch(() => {}); break; }
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const m = line.match(/^data: (.*)$/);
      if (!m) continue;
      let d;
      try { d = JSON.parse(m[1]); } catch { continue; }
      if (d.type === 'response.output_text.delta') content += d.delta;
      if (d.type === 'response.output_text.done') textDone = true;
      if (d.type === 'response.completed' || d.type === 'response.incomplete') usage = d.response?.usage;
      if (d.type === 'response.failed' || d.type === 'error') failed = JSON.stringify(d).slice(0, 300);
    }
    if (usage || failed) { rd.cancel().catch(() => {}); break; }
  }
  if (failed || stalled || !(usage || textDone)) return new Response(JSON.stringify({ error: failed ?? (stalled ? 'stream stalled' : 'stream ended early') }), { status: 529 });
  return new Response(JSON.stringify({ model, choices: [{ message: { role: 'assistant', content } }], usage: usage && { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, completion_tokens_details: { reasoning_tokens: usage.output_tokens_details?.reasoning_tokens } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// ════════ Claude 原生格式（Anthropic /v1/messages），固定走 Claude 网关，和 GATEWAY 无关 ════════
// 调用方仍用 OpenAI 形式的 messages（system 消息 + 文字 / image_url 数据 URL），这里转成 Anthropic 形式
const CLAUDE_MESSAGES_URL = `${get('CLAUDE_URL').replace(/\/$/, '')}/v1/messages`;
const CLAUDE_KEY = get('CLAUDE_API_KEY');
const toClaudePart = (p) => {
  if (typeof p === 'string') return { type: 'text', text: p };
  if (p.type === 'image_url') {
    const m = String(p.image_url?.url ?? '').match(/^data:([^;]+);base64,(.*)$/);
    return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  }
  return { type: 'text', text: p.text ?? '' };
};
/**
 * 一次 Claude 调用（流式接收，避开网关约 30 秒断开）。messages 为 OpenAI 形式。
 * 成功返回 { ok: true, text, usage: { prompt_tokens, completion_tokens } }（prompt_tokens 含缓存读写）；HTTP 失败返回原 Response
 */
export async function postClaudeMessages(messages, { model, maxTokens = 4000, effort, signal } = {}) {
  const system = messages.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => p.text ?? '').join('\n'))).join('\n\n');
  const body = {
    model, max_tokens: maxTokens, stream: true,
    ...(effort ? { output_config: { effort } } : {}),
    ...(system ? { system } : {}),
    messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map(toClaudePart) })),
  };
  const res = await fetch(CLAUDE_MESSAGES_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body), signal });
  if (!res.ok) return res;
  const dec = new TextDecoder();
  let buf = '', text = '', inTok = 0, outTok = 0, streamErr = null;
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const m = line.match(/^data: (.*)$/);
      if (!m) continue;
      let d;
      try { d = JSON.parse(m[1]); } catch { continue; }
      if (d.type === 'message_start') { const u = d.message?.usage ?? {}; inTok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0); outTok = u.output_tokens ?? 0; }
      if (d.type === 'content_block_delta' && d.delta?.type === 'text_delta') text += d.delta.text;
      if (d.type === 'message_delta' && d.usage?.output_tokens != null) outTok = d.usage.output_tokens;
      if (d.type === 'error') streamErr = d.error?.message ?? 'stream error';
    }
  }
  if (streamErr) return new Response(JSON.stringify({ error: streamErr }), { status: 529 });
  return { ok: true, text, usage: { prompt_tokens: inTok, completion_tokens: outTok } };
}
