// 方案 B：AI agent 调 VM 对齐主图。代码只负责执行（渲染、裁图、参数卡范围、预算、记录），决策全交给模型。
// 用法：node scripts/agent.mjs <版本目录名，如 v1> <项目 id ...>
// 每个项目的过程记在 results/agent/<版本>/<项目前 8 位>/（每步观察图 + trace.json）
import fs from 'node:fs';
import { openLab, projectInput, readJson, writeJson, labPath, isE2E, projKey } from './lab.mjs';
import { startVmOf } from './start-vm.mjs';
import { logUsage, setUsageTag, summarize } from './usage.mjs';
import { pickV17 } from './pick-v17.mjs';
import { locate, aggregate, metricsOf, METRIC_LABEL as LABEL_U, STAGE_METRICS as STAGE_U, METRIC_LABEL_FACE, STAGE_METRICS_FACE, UNRELIABLE, POINTS, POINTS_WHITE, multiTargets, metricsWith, METRICS_MULTI, RULERS } from './landmarks.mjs';
import { judgeVm } from './judge-core.mjs';

const [version, ...ids] = process.argv.slice(2);
const cfg = { model: 'gpt-5.6-sol', maxCalls: 30, maxMs: 10 * 60_000, keepImages: 2, ...(fs.existsSync(labPath(`agent/${version}/config.json`)) ? readJson(`agent/${version}/config.json`) : {}) };
const SYSTEM = fs.readFileSync(labPath(`agent/${version}/system.md`), 'utf8');
// 分阶段（v3 起）：按 stages.json 的顺序逐个部位开放参数，最后整体检查；没配就是原来的一次开放全部参数
// v11 ruler=face：比例改以脸宽/脸长为尺子，虹膜比例 riv 侧由代码量
const FACE = cfg.ruler === 'face';
const METRIC_LABEL = FACE ? METRIC_LABEL_FACE : LABEL_U, STAGE_METRICS = FACE ? STAGE_METRICS_FACE : STAGE_U;
const STAGES = cfg.stages ? readJson(`agent/${version}/${cfg.stages}`) : null;
const devVars = fs.readFileSync(labPath('../.dev.vars'), 'utf8');
const KEY = (devVars.match(/^TEXT_LLM_API_KEY=(.*)$/m) || devVars.match(/^IMAGE_API_KEY=(.*)$/m))[1].trim();

// gpt-6-astra 在网关上会对正常输入偶发判「违反使用政策」（同一输入重试常能过）：重试 2 次，再换线路 / 换模型，记下次数
export const fallbackCount = { n: 0 };
async function callModel(messages, models = [cfg.model, ...(cfg.fallbackModels ?? [])]) {
  for (const model of models) {
    for (let attempt = 1; ; attempt++) {
      const t0 = Date.now();
      const res = await fetch('https://tenantapi.anispark.ai/llm/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model, messages, response_format: { type: 'json_object' }, max_tokens: 4000 }),
        signal: AbortSignal.timeout(180000),  // 网关偶尔不返回，不设超时会一直挂住
      }).catch((e) => ({ ok: false, status: 0, text: async () => `timeout: ${e.message}` }));
      if (res.ok) {
        const j = await res.json();
        if (model !== cfg.model) fallbackCount.n++;
        logUsage('agent', model, j.usage, { ms: Date.now() - t0 });
        return { text: j.choices?.[0]?.message?.content ?? '', usage: j.usage ?? {} };
      }
      const body = await res.text();
      // 429（网关按 key 限每分钟请求数）：等 20 秒再试，最多约 5 分钟
      if (res.status === 429 && attempt < 15) { await new Promise((ok) => setTimeout(ok, 20000)); continue; }
      if (res.status === 400 && /invalid_prompt/.test(body)) { if (attempt < 3) continue; break; }  // 换下一个模型
      // 网络错误 / 超时（status 0）多等几次：2026-11-01 v13 连续 4 次 fetch failed 导致整个项目中断
      if (attempt >= (res.status === 0 ? 8 : 4) || (res.status < 429 && res.status !== 408 && res.status !== 0)) throw new Error(`model ${res.status}: ${body.slice(0, 300)}`);
      await new Promise((ok) => setTimeout(ok, (res.status === 0 ? 10000 : 2000) * attempt));
    }
  }
  throw new Error('all models flagged the prompt');
}

// 小线性方程组（部分主元高斯消元）；奇异返回 null
function solveLin(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
const img = (b64) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } });

// v6 阶段验收门：评审模型按该阶段对应的评审项，比较阶段开始/结束两版，左右对调问两次
const GATE_ITEMS = {
  head: ['body_ratio 头身比例', 'neck 脖子长度'], body: ['body_ratio 头身比例：肩宽相对脸宽', 'neck 脖子长度：下巴到领口、肩线'],
  face: ['face_width 脸宽：相对头发外轮廓、相对肩宽', 'face_length 脸长：下巴相对眉毛、鼻子', 'brow_eye 眉毛到眼睛的距离'],
  hair_front: ['hair_front 刘海下沿相对眉毛和眼睛、刘海宽度', 'no_glitch 不露头皮、刘海不盖住眼睛'],
  hair_back: ['hair_outline 头发外轮廓', 'no_glitch 不露头皮'],
  eye: ['brow_eye 眉毛到眼睛的距离', 'eye_spacing 两眼间距相对脸宽', 'eye_size 单只眼宽高相对脸宽', 'no_glitch 眼睛不被头发盖住'],
  iris: ['iris_size 虹膜直径占眼白开口的比例', 'iris_position 虹膜在眼眶里的位置', 'no_glitch 虹膜不露出眼白开口'],
  mouth: ['nose_mouth 鼻底到嘴的距离', 'mouth_chin 嘴到下巴的距离', 'mouth_width 嘴宽相对脸宽'],
};
const JUDGE_MODEL = process.env.JUDGE_MODEL || 'gpt-6.1-sol';
// v16 验收门「度量覆盖」：每个参数改了以后由哪些度量反映出来（没有列 = 没有度量能说明它变好没有，如嘴厚、头发）
const COVER = {
  Head_Y: ['neck'], Body_scale: ['shoulder_w', 'neck'], Body_Y: ['neck'], Body_X: ['center_off'],
  Face_scale: ['eye_nose', 'brow_eye', 'shoulder_w'], Face_Y: ['eye_nose', 'brow_eye'],
  Eye_R_Y: ['brow_eye', 'eye_nose'], Eye_R_X: ['eye_dx'], Eye_scale_X: ['eye_w'], Eye_scale_Y: ['eye_h'],
  Eye_iris_scale: ['iris_ratio'], Eye_iris_R_X: ['iris_x'], Eye_iris_R_Y: ['iris_y'], Eyemask_Xscale: ['iris_ratio'], Eyemask_Yscale: ['iris_ratio'],
  Mouth_Y: ['nose_mouth', 'mouth_chin'], Mouth_scale_X: ['mouth_w'],
};
async function gateAsk(stageId, images) {
  const sys = `你是 2D 角色还原度评审。图里第一格是主图，后面是候选 1、候选 2（同一角色两组参数的渲染）。只比较下面这几项、只看位置大小比例（贴图画风细节不比），判断哪个候选更像主图：\n${GATE_ITEMS[stageId].map((t) => `- ${t}`).join('\n')}\n差别看不出来就答 0。只输出 JSON：{"better":1|2|0,"reason":"..."}`;
  const content = [{ type: 'text', text: '图 1：整图。图 2：这一部位放大。' }, ...images.map((b) => img(b))];
  for (let attempt = 1; ; attempt++) {
    const t0 = Date.now();
    const res = await fetch('https://tenantapi.anispark.ai/llm/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: JUDGE_MODEL, messages: [{ role: 'system', content: sys }, { role: 'user', content }], response_format: { type: 'json_object' }, max_tokens: 2000 }),
      signal: AbortSignal.timeout(180000),  // 网关偶尔不返回，不设超时会一直挂住
    }).catch((e) => ({ ok: false, status: 0, text: async () => `timeout: ${e.message}` }));
    if (res.ok) { const j = await res.json(); logUsage('gate', JUDGE_MODEL, j.usage, { ms: Date.now() - t0 }); try { return JSON.parse(j.choices[0].message.content); } catch { return { better: 0, reason: 'unparsable' }; } }
    if (res.status === 429 && attempt < 15) { await new Promise((ok) => setTimeout(ok, 20000)); continue; }
    if (attempt >= 4) return { better: 0, reason: `judge ${res.status}` };
    await new Promise((ok) => setTimeout(ok, 3000 * attempt));
  }
}
const clampParams = (params, specs, open = null) => {
  const out = {}, rejected = [];
  for (const [n, v] of Object.entries(params || {})) {
    const s = specs.find((p) => p.name === n);
    if (open && !open.includes(n)) { rejected.push(n); continue; }
    if (!s || typeof v !== 'number' || !Number.isFinite(v)) { rejected.push(n); continue; }
    const [lo, hi] = (cfg.limits && STAGES?.limits?.[n]) || [s.min, s.max];
    out[n] = Math.max(Math.max(s.min, lo), Math.min(Math.min(s.max, hi), Math.round(v / s.step) * s.step));
  }
  return { out, rejected };
};
const validBox = (b) => Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === 'number')
  ? [Math.max(0, b[0]), Math.max(0, b[1]), Math.max(0.02, Math.min(1 - Math.max(0, b[0]), b[2])), Math.max(0.02, Math.min(1 - Math.max(0, b[1]), b[3]))]
  : [0, 0, 1, 1];

async function runOne(lab, id) {
  const dir = `results/agent/${version}/${projKey(id)}`;
  setUsageTag(`${version}/${projKey(id)}`);
  fs.mkdirSync(labPath(dir), { recursive: true });
  const info = await lab.call('loadProject', projectInput(id));
  await lab.call('loadMaster');
  const specs = await lab.call('tunableParams');
  // 完整流程的新项目：起点 = 模板默认 + 生成时带回的参数（Studio 生成完会应用），即「刚生成完」
  let vm = { ...startVmOf(info.savedVm, specs), ...(isE2E(id) ? info.savedVm : {}), ...(STAGES?.fixed ?? {}) };
  if (cfg.freezeFrame) await lab.call('freezeFrame', vm);
  // 阶段：只保留 riv 里有、可调的参数；一个参数都没有的阶段跳过
  const has = new Set(specs.map((p) => p.name));
  const stages = STAGES ? STAGES.stages.map((st) => ({ ...st, params: st.params.filter((n) => has.has(n)) })).filter((st) => st.params.length) : null;
  let si = 0, stageCalls = 0, reviewing = false, reviewCalls = 0, returnToReview = false;
  // v4：locked[阶段 id] = 离开这个阶段时定下的值；reopened[阶段 id] = 回去过几次；reopenCompared：这次回去后 compare 过没有
  const locked = {}, reopened = {};
  let depQueue = [];  // 回去修某阶段后要依次重过的阶段 id
  let entryVm = null, entryGlitch = null, entryMetrics = null;  // v6：本阶段开始时的参数、穿帮读数
  const gateLog = [];
  // v8 重新生成贴图：组件 → 重新调整从哪个阶段开始
  const REGEN_STAGE = { head: 'face', body: 'body', hair: 'hair_front', sclera: 'eye', pupil: 'iris', mouth: 'mouth' };
  const regenLog = [];
  const regenItems = { head: '脸型（face_width、face_length、brow_eye）', body: '头身比例', hair: '前发、头发外轮廓、不露头皮', sclera: '眼睛形状和大小', pupil: '虹膜大小和画法', mouth: '嘴形和大小' };
  const snapEntry = async () => { entryVm = { ...vm }; entryGlitch = cfg.glitchGuard ? await lab.call('glitchMetrics', vm) : null; };
  let reopenCompared = true;
  const fmtEffect = (n, e) => (!e ? `${n}：改了这个部件看不出变化` : `${n}：每 +1 → 质心 dx ${e.dx}、dy ${e.dy} px，宽 ${e.dw >= 0 ? '+' : ''}${e.dw}、高 ${e.dh >= 0 ? '+' : ''}${e.dh} px`);
  const stage = () => (reviewing ? null : stages?.[si]);
  const openParams = () => (!stages ? specs.map((p) => p.name) : reviewing ? [] : stage().params);
  const stageText = () => {
    if (!stages) return '';
    if (reviewing) return `【整体检查阶段】${STAGES.review.look}${target ? stages.map((st) => metricsText(st.id).replace('\n关键点度量', `\n${st.name}·关键点度量`)).join('') : ''}\n本阶段还剩 ${STAGES.review.budget - reviewCalls} 次。可回到的阶段：${stages.map((st) => `${st.id}（${st.name}）`).join('、')}。`;
    const st = stage();
    const lim = (n, p) => (cfg.limits && STAGES.limits?.[n]) || [p.min, p.max];
    const ps = specs.filter((p) => st.params.includes(p.name)).map((p) => `${p.name}（${p.label}）范围 ${lim(p.name, p).join('~')} 步长 ${p.step}，当前 ${vm[p.name]}`).join('\n');
    const eff = st.measured ? `\n参数作用规则（实测，主图坐标 px）：部件现在质心 (${st.measured.part.cx}, ${st.measured.part.cy})、宽 ${st.measured.part.w}、高 ${st.measured.part.h}；部位放大框 ${JSON.stringify(st.measured.box)}\n${st.params.map((n) => fmtEffect(n, st.measured.effects[n])).join('\n')}` : '';
    const re = returnToReview ? `\n这是从整体检查回来修的：原来定下的值 ${JSON.stringify(locked[st.id] ?? {})}，要先 compare（原值会自动作为候选之一）再 set。` : '';
    const sug = st.suggestion ? `\n代码建议（按实测变化率算的）：${JSON.stringify(st.suggestion.values)}，预计度量变为 ${Object.entries(st.suggestion.predicted).map(([k, v]) => `${METRIC_LABEL[k]} ${v.toFixed(3)}（目标 ${target[k].toFixed(3)}）`).join('，')}。先用 compare 比较「当前 / 建议值 / 建议值一半」，确认后 set；不采用要在 why 里说明原因。` : '';
    return `【阶段 ${si + 1}/${stages.length}：${st.name}（${st.id}）】看：${st.look}\n本阶段可调参数：\n${ps}${eff}${metricsText(st.id)}${sug}${re}\n本阶段还剩 ${(st.budgetNow ?? st.budget) - stageCalls} 次。`;
  };
  // 进入下一阶段（后发先跟着前发：按前发相对起点的倍数、位移带过来）
  const measure = async (st) => {
    if (cfg.effects && st.roles) st.measured = await lab.call('stageEffects', vm, st.roles, st.params);
  };
  const enterStage = async (k) => {
    si = k; stageCalls = 0;
    const st = stages[si];
    st.budgetNow = null;
    if (st?.follow) {
      for (const [n, from] of Object.entries(st.follow)) {
        if (!has.has(n) || !has.has(from)) continue;
        const spec = specs.find((p) => p.name === n);
        const v = /scale/.test(n) ? start[n] * (vm[from] / start[from]) : start[n] + (vm[from] - start[from]);
        vm[n] = Math.max(spec.min, Math.min(spec.max, Math.round(v / spec.step) * spec.step));
      }
    }
    await measure(st);
    await snapEntry();
    await measureRiv();
    entryMetrics = { ...current };
    st.suggestion = await suggest(st);
  };
  // 整体检查用的分区放大图：各阶段部位框（进入该阶段时量的）
  const BOX_LABEL = { headShoulder: '头和肩', face: '脸部', eyes: '双眼', leftEye: '左眼（画面左侧）', mouth: '嘴' };
  const gridOf = async (keys) => {
    const boxes = await lab.call('partBoxes', vm);
    const items = keys.filter((k) => boxes[k]).map((k) => ({ label: BOX_LABEL[k], box: boxes[k] }));
    return items.length ? lab.call('obsGrid', vm, items) : lab.call('obsPair', vm, [0, 0, 1, 1]);
  };
  const reviewGrid = async () => (cfg.views ? gridOf(['headShoulder', 'face', 'eyes', 'leftEye', 'mouth'])
    : (async () => {
      const pick = ['hair_front', 'eye', 'mouth', 'body'];
      const items = stages.filter((st) => pick.includes(st.id) && st.measured?.box).map((st) => ({ label: st.name, box: st.measured.box }));
      return items.length ? lab.call('obsGrid', vm, items) : lab.call('obsPair', vm, [0, 0, 1, 1]);
    })());
  // 当前阶段每步给的图：配了 views 给 整图 + 分区放大（两张），否则整图
  const stageImgs = async () => {
    const full = await lab.call('obsPair', vm, [0, 0, 1, 1]);
    const st = stage();
    if (!cfg.views || !st?.views) return [full];
    return [full, await gridOf(st.views)];
  };
  // 验收门：这一阶段改过参数时，两版并排问评审两次（对调左右），两次都认为结束版更好才保留，否则退回阶段开始时的值
  const gate = async (st) => {
    if (!cfg.gate || !entryVm || st.params.every((n) => vm[n] === entryVm[n])) return '';
    const boxes = await lab.call('partBoxes', vm);
    const key = (st.views ?? []).slice(-1)[0] ?? 'face';
    const pair = async (a, b) => [await lab.call('obsCandidates', [a, b], [0, 0, 1, 1], 300), await lab.call('obsCandidates', [a, b], boxes[key] ?? [0, 0, 1, 1], 400)];
    const r1 = await gateAsk(st.id, await pair(entryVm, vm));   // 候选 2 = 结束版
    const r2 = await gateAsk(st.id, await pair(vm, entryVm));   // 候选 1 = 结束版
    let keep = Number(r1.better) === 2 && Number(r2.better) === 1;
    // v9：两次判断落在同一位置（位置偏差）时，用本阶段度量裁决：离目标更近才保留
    const biased = Number(r1.better) === Number(r2.better) && Number(r1.better) !== 0;
    let byMetrics = null;
    if (cfg.gateTieMetrics && biased && stageKeys(st.id).length && entryMetrics) {
      const ks = stageKeys(st.id), d0 = distOf(entryMetrics, ks), d1 = distOf(current, ks);
      byMetrics = { before: +d0.toFixed(3), after: +d1.toFixed(3) };
      keep = d1 < d0 - 0.02;
      // v16：改了的参数里，有没被任何可靠度量覆盖的（例如嘴的厚度、没有目标的嘴宽），度量说明不了它变好没有 → 不裁决，退回
      if (cfg.gateCover) {
        const changed = st.params.filter((n) => vm[n] !== entryVm[n]);
        const uncovered = changed.filter((n) => !(COVER[n] ?? []).some((k) => k in target && !UNRELIABLE.has(k)));
        if (uncovered.length) { keep = false; byMetrics.uncovered = uncovered; }
      }
    }
    gateLog.push({ stage: st.id, keep, r1, r2, biased, byMetrics, entry: Object.fromEntries(st.params.map((n) => [n, entryVm[n]])), end: Object.fromEntries(st.params.map((n) => [n, vm[n]])) });
    if (keep) return `「${st.name}」验收通过（评审两次都认为改后更像主图）。`;
    for (const n of st.params) vm[n] = entryVm[n];
    return `「${st.name}」验收没通过（评审没有两次都认为改后更像主图：${String(r1.reason).slice(0, 60)} / ${String(r2.reason).slice(0, 60)}），这一阶段退回开始时的值。`;
  };
  const advance = async () => {
    const cur = stages[si];
    const gateMsg = await gate(cur);
    locked[cur.id] = Object.fromEntries(cur.params.map((n) => [n, vm[n]]));
    const inner = await advanceInner();
    return `${gateMsg}${inner}`;
  };
  const advanceInner = async () => {
    if (returnToReview && cfg.deps && depQueue.length) {
      const nextId = depQueue.shift();
      const k = stages.findIndex((st) => st.id === nextId);
      await enterStage(k);
      reopenCompared = true;
      stages[k].budgetNow = STAGES.depBudget ?? 3;
      return `前面的阶段改过，受它影响的「${stages[k].name}」要重新对一遍（本轮最多 ${stages[k].budgetNow} 次）。`;
    }
    if (returnToReview || si + 1 >= stages.length) { reviewing = true; returnToReview = false; return '进入整体检查阶段。'; }
    await enterStage(si + 1);
    return `进入阶段 ${si + 1}：${stages[si].name}。${stages[si].follow ? '后发已按前发的缩放和位移跟过来。' : ''}`;
  };
  const probe = cfg.probe ? await lab.call('probeParams', vm, specs) : {};
  // v7 关键点度量：主图标 3 次取中位数作目标，离散大的指标不作目标；riv 每次改参数后标一次
  let target = null, current = {}, rulerOf = {}, unavailable = {};
  let masterPts = null, masterDim = null;  // v17 挑选要用主图标点
  const trace0 = {};  // 开始前算的东西（主图眼睛测量等），最后并入 trace
  const LM_MODEL = cfg.landmarkModel || cfg.model;
  const LM_DEFS = cfg.eyeWhite ? POINTS_WHITE : POINTS;
  // 量一组参数：渲染 + 代码量（页面里依次做，很快）→ AI 定点（网关调用，可并发）
  const prepVm = async (v) => {
    const img = await lab.call('rivForPoints', v);
    let iris;
    if (FACE && cfg.irisV13) {
      // v13：主图、riv 同一套「眼白找边」代码；虹膜几乎盖满眼白（找不到两侧眼白）时记 1 = 虹膜占满开口
      const e = await lab.call('eyeRiv', v, 2);
      iris = e && e.irisW > 0 && e.eyeW >= 30 ? e.irisW / e.eyeW : 1;
    } else if (FACE) { const ic = await lab.call('irisCode', v); iris = ic ? ic.iris_ratio : undefined; }
    return { img, iris };
  };
  const finishVm = async ({ img, iris }) => {
    const pts = await locate(LM_MODEL, img, LM_DEFS) || {};
    const m = cfg.multiRuler ? metricsWith(pts, rulerOf) : metricsOf(pts, cfg.ruler);
    if (FACE) { if (iris === undefined) delete m.iris_ratio; else m.iris_ratio = iris; }
    return m;
  };
  const measureVm = async (v) => finishVm(await prepVm(v));
  // 多组参数一起量：渲染依次做，AI 定点同时发（单次定点约 20 秒，串行是主要耗时；cfg.parallelMeasure 开启）
  const measureMany = async (vs) => {
    if (!cfg.parallelMeasure) { const out = []; for (const v of vs) out.push(await measureVm(v)); return out; }
    const preps = []; for (const v of vs) preps.push(await prepVm(v));
    return Promise.all(preps.map(finishVm));
  };
  const measureRiv = async () => { if (target) current = await measureVm(vm); };
  if (cfg.landmarks) {
    const m = await lab.call('masterForPoints');
    // v16：主图定点次数 masterRuns（默认 3）；多尺子（multiRuler）时每项度量按优先级挑主图上稳的尺子，riv 用同一把
    const pts = await Promise.all(Array.from({ length: cfg.masterRuns ?? 3 }, () => locate(LM_MODEL, m, LM_DEFS)));
    masterPts = pts; masterDim = { W: m.W, H: m.H };
    const agg = aggregate(pts, cfg.ruler);
    // 离散上限：U 尺子下沿用绝对 0.06；脸宽/脸长尺子下数值量级不同，按相对 8%（下限 0.02，给接近 0 的虹膜偏移用）
    target = Object.fromEntries(Object.entries(agg).filter(([, a]) => a.n >= 2 && a.spread <= Math.max(FACE ? 0.02 : 0.06, Math.abs(a.value) * 0.08)).map(([k, a]) => [k, a.value]));
    if (cfg.multiRuler) {
      const mt = multiTargets(pts);
      // 脸部尺子一把能用的都没有 → 直接报错停止，不在没有依据的情况下调（不进入调整，不再花后面的钱）
      const faceRulers = Object.entries(mt.rulerStat).filter(([k]) => !RULERS[k].eye);
      if (!faceRulers.some(([, x]) => x.ok)) {
        const detail = faceRulers.map(([k, x]) => `${RULERS[k].label} ${x.med ? `误差 ${(x.se / Math.abs(x.med) * 100).toFixed(1)}%` : '标不出'}`).join('；');
        throw new Error(`主图上没有能量准的尺子（${detail}），停止对齐`);
      }
      target = mt.target; rulerOf = mt.rulerOf; unavailable = mt.unavailable;
      trace0.rulers = { rulerOf, unavailable, rulerStat: mt.rulerStat };
      // 度量说明里写明用的哪把尺子
      for (const [k, rk] of Object.entries(rulerOf)) METRIC_LABEL[k] = `${METRICS_MULTI[k].label} ÷ ${RULERS[rk].label}`;
      console.log(projKey(id), '尺子', Object.entries(mt.rulerStat).map(([k, x]) => `${k}${x.ok ? '✓' : '✗'}`).join(' '), '| 无可靠目标', Object.keys(unavailable).join(',') || '无');
    }
    if (!cfg.bodyCenter) delete target.center_off;
    if (cfg.irisV13) {
      // 主图眼白框 = AI 三次定点的中位数（定点图坐标 → 主图原尺寸），代码在框附近找边
      const med = (v) => { v = v.filter(Number.isFinite).sort((a, b) => a - b); return v[v.length >> 1]; };
      const P = (n, i) => med(pts.map((p) => p?.[n]?.[i]));
      const k = (await lab.call('masterSize')).w / m.W, xs = [P('eye_l_outer', 0) * k, P('eye_l_inner', 0) * k];
      const e = await lab.call('eyeMaster', [Math.min(...xs), P('eye_l_top', 1) * k, Math.max(...xs), P('eye_l_bottom', 1) * k]);
      if (e && e.irisW > 0 && e.eyeW >= 30) target.iris_ratio = e.irisW / e.eyeW; else { delete target.iris_ratio; if (cfg.multiRuler) unavailable.iris_ratio = '主图上找不到两侧眼白，量不出虹膜宽'; }
      trace0.masterEye = e;
    }
  }
  const stageKeys = (stageId) => (target ? (STAGE_METRICS[stageId] ?? []).filter((k) => k in target) : []);
  const distOf = (m, ks) => ks.reduce((sum, k) => sum + (Number.isFinite(m?.[k]) ? Math.abs(m[k] - target[k]) / Math.max(0.1, Math.abs(target[k])) : 0.5), 0);
  // v9 代码求步长：本阶段每个参数改 15% 量程、AI 定点测一次，得到实测变化率，阻尼最小二乘算建议值
  // v13 守护项：这一阶段之前各阶段的可靠度量；算建议值 / 挑贴图时一起算，不允许为本阶段牺牲它们
  const guardKeys = (stageId) => {
    if (!cfg.guard || !target) return [];
    const idx = stages.findIndex((x) => x.id === stageId);
    const own = new Set(stageKeys(stageId));
    return [...new Set(stages.slice(0, Math.max(0, idx)).flatMap((x) => stageKeys(x.id)))].filter((k) => !own.has(k) && !UNRELIABLE.has(k));
  };
  const suggest = async (st) => {
    const ks = [...stageKeys(st.id), ...guardKeys(st.id).filter((k) => Number.isFinite(current[k]))];
    if (!cfg.solver || !ks.length) return null;
    const base = { ...current };
    if (ks.some((k) => !Number.isFinite(base[k]))) return null;
    const cols = [], deltas = [];
    const probes = st.params.map((n) => {
      const sp = specs.find((p) => p.name === n);
      const [lo, hi] = (cfg.limits && STAGES.limits?.[n]) || [sp.min, sp.max];
      let d = 0.15 * (hi - lo);
      if (vm[n] + d > hi) d = -d;
      return { n, d };
    });
    const pm = await measureMany(probes.map(({ n, d }) => ({ ...vm, [n]: vm[n] + d })));
    probes.forEach(({ d }, j) => {
      const m = pm[j];
      cols.push(ks.map((k) => (Number.isFinite(m[k]) ? (m[k] - base[k]) : 0)));  // 改 d 带来的变化
      deltas.push(d);
    });
    // 归一化变量 x = Δ / d；残差按目标大小归一
    const w = ks.map((k) => 1 / Math.max(0.1, Math.abs(target[k])));
    const r = ks.map((k, i) => (base[k] - target[k]) * w[i]);
    const J = ks.map((_, i) => cols.map((c) => c[i] * w[i]));
    const n = cols.length, JtJ = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => J.reduce((sum, row) => sum + row[a] * row[b], 0)));
    const lam = 0.1 * (JtJ.reduce((sum, row, i) => sum + row[i], 0) / n || 1);
    const x = solveLin(JtJ.map((row, i) => row.map((v, j) => v + (i === j ? lam : 0))), cols.map((_, a) => -J.reduce((sum, row, i) => sum + row[a] * r[i], 0)));
    if (!x) return null;
    const values = {}, predicted = {};
    st.params.forEach((nm, j) => {
      const sp = specs.find((p) => p.name === nm);
      const [lo, hi] = (cfg.limits && STAGES.limits?.[nm]) || [sp.min, sp.max];
      values[nm] = Math.max(lo, Math.min(hi, Math.round((vm[nm] + x[j] * deltas[j]) / sp.step) * sp.step));
    });
    ks.forEach((k, i) => { predicted[k] = base[k] + st.params.reduce((sum, nm, j) => sum + cols[j][i] * ((values[nm] - vm[nm]) / deltas[j]), 0); });
    return { values, predicted };
  };
  const metricsText = (stageId) => {
    if (!target) return '';
    const ks = (STAGE_METRICS[stageId] ?? []).filter((k) => k in target);
    const miss = (STAGE_METRICS[stageId] ?? []).filter((k) => !(k in target) && unavailable[k]);
    const missText = miss.length ? `\n以下项在主图上量不稳，没有可靠目标，要靠看图判断：${miss.map((k) => `${METRICS_MULTI[k]?.label ?? METRIC_LABEL[k] ?? k}（${unavailable[k]}）`).join('；')}` : '';
    if (!ks.length) return `\n关键点度量：这一阶段没有可靠的目标数字，靠看图。${missText}`;
    const rows = ks.map((k) => {
      const t = target[k], c = current[k];
      if (!Number.isFinite(c)) return `- ${METRIC_LABEL[k]}：目标 ${t.toFixed(3)}，当前量不出`;
      const d = c - t, rel = Math.abs(t) > 0.05 ? ` (${d > 0 ? '+' : ''}${Math.round((d / t) * 100)}%)` : '';
      return `- ${METRIC_LABEL[k]}：目标 ${t.toFixed(3)}，当前 ${c.toFixed(3)}，差 ${d > 0 ? '+' : ''}${d.toFixed(3)}${rel}`;
    });
    return `\n关键点度量（AI 在主图、riv 上分别标点，代码按同一把尺子算；${FACE ? '各项写明了以什么为尺子；差在 ±5% 以内算已经对上' : '单位 U = 鼻底到下巴的竖直距离；单次测量误差约 ±0.03'}）：\n${rows.join('\n')}${missText}`;
  };
  // v12 候选池：按依赖顺序（头 → 眼眶 → 瞳孔 → 嘴），每个组件的原贴图和池里的候选各自先用代码求步长把本阶段参数解到位，
  // 再量两次取平均算离主图目标的差距，选差距最小的；穿帮（比原贴图多 3 个百分点以上）淘汰；不比原贴图明显好（差距小 0.05 以上）就留原贴图。
  // 选完参数回到起点值，正常阶段流程再调（这里解出的值只用于比较）
  const poolLog = [];
  // v17：按组件挑（完整性检查 → 测量淘汰 → AI 逐方面打分），不试调参数；见 scripts/pick-v17.mjs
  if (cfg.pick === 'v17' && masterPts) {
    const poolDir = isE2E(id) ? labPath(`data/e2e/${id.slice(4)}/pool`) : labPath(`results/pool/${projKey(id)}`);
    const r = await pickV17({ lab, poolDir, pts: masterPts, W: masterDim.W, H: masterDim.H, cfg, tag: projKey(id) });
    vm = { ...vm, ...r.vmPatch };
    poolLog.push(...r.poolLog);
    trace0.pickNotes = r.notes;
    if (target) current = await measureVm(vm);
  }
  if (cfg.pool && cfg.pick !== 'v17' && target && stages) {
    // 组件 → 用哪个阶段的度量挑；v15 多了 body、hair（没有可靠度量的组件自动跳过，保留候选 1）
    const POOL_STAGE = cfg.poolRule === 'equal' ? { head: 'face', body: 'body', sclera: 'eye', pupil: 'iris', mouth: 'mouth', hair: 'hair_front' } : { head: 'face', sclera: 'eye', pupil: 'iris', mouth: 'mouth' };
    const poolDir = isE2E(id) ? labPath(`data/e2e/${id.slice(4)}/pool`) : labPath(`results/pool/${projKey(id)}`);
    for (const [comp, sid] of Object.entries(POOL_STAGE)) {
      const st = stages.find((x) => x.id === sid);
      // v13：择优只用可靠度量 + 守护项（前面阶段的可靠度量）；量不准的度量只用来淘汰离谱的候选
      // v15（poolRule=equal）：打分只用本组件阶段的可靠度量，守护项只约束求步长
      const ks = cfg.poolRule === 'equal' ? stageKeys(sid).filter((k) => !UNRELIABLE.has(k))
        : cfg.poolV13 ? [...stageKeys(sid).filter((k) => !UNRELIABLE.has(k)), ...guardKeys(sid)] : stageKeys(sid);
      const roughKs = cfg.poolV13 ? stageKeys(sid).filter((k) => UNRELIABLE.has(k)) : [];
      if (!st || !ks.length) continue;
      const files = fs.existsSync(poolDir) ? fs.readdirSync(poolDir).filter((f) => f.startsWith(`${comp}-`)).sort() : [];
      if (!files.length) continue;
      const cands = [{ name: 'original', textures: {}, viewModelPatch: null }, ...files.map((f) => ({ name: f.replace('.json', ''), ...JSON.parse(fs.readFileSync(`${poolDir}/${f}`, 'utf8')) }))];
      const vm0 = { ...vm }, keepTex = await lab.call('textureSnapshot');
      const rows = [];
      for (const c of cands) {
        await lab.call('restoreTextures', { ...keepTex, ...c.textures });
        vm = { ...vm0, ...(c.viewModelPatch ?? {}) };
        current = await measureVm(vm);
        const sug = await suggest(st);
        const solved = { ...vm, ...(sug?.values ?? {}) };
        const ms = [];
        ms.push(...await measureMany(Array.from({ length: cfg.poolMeasures ?? 2 }, () => solved)));
        const avg = Object.fromEntries([...ks, ...roughKs].map((k) => { const v = ms.map((m) => m[k]).filter(Number.isFinite); return [k, v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN]; }));
        const rough = Math.max(0, ...roughKs.filter((k) => Number.isFinite(avg[k]) && k in target).map((k) => Math.abs(avg[k] - target[k]) / Math.max(0.1, Math.abs(target[k]))));
        rows.push({ name: c.name, c, dist: +distOf(avg, ks).toFixed(3), mean: +(distOf(avg, ks) / ks.length).toFixed(3), rough: +rough.toFixed(3), keys: ks, metrics: avg, solved: sug?.values ?? null, glitch: await lab.call('glitchMetrics', solved) });
      }
      const orig = rows[0];
      // 淘汰：穿帮明显变多；（v13）量不准的度量偏离 40% 以上（离谱）
      const okRows = rows.filter((r) => r === orig || (r.glitch.hairOverEye - orig.glitch.hairOverEye <= 0.03 && r.glitch.irisOut - orig.glitch.irisOut <= 0.03 && !(cfg.poolV13 && r.rough > 0.4)));
      let best;
      if (cfg.poolRule === 'equal') {
        // 规则 4：起始贴图和候选地位相同（N 选 1）。① 每张取误差最大的一项（最差项），比所有可选里最好的最差项
        // 高出 poolGap（默认 10 个百分点）以上的淘汰（缺陷常表现为某一项特别离谱）；② 剩下选平均误差最小的
        const worst = (r) => Math.max(...ks.map((k) => (Number.isFinite(r.metrics[k]) ? Math.abs(r.metrics[k] - target[k]) / Math.max(0.1, Math.abs(target[k])) : 1)));
        rows.forEach((r) => { r.worst = +worst(r).toFixed(3); });
        const pool0 = rows.filter((r) => !(r.rough > 0.4) && r.glitch.hairOverEye - orig.glitch.hairOverEye <= 0.03 && r.glitch.irisOut - orig.glitch.irisOut <= 0.03);
        const base = pool0.length ? pool0 : rows;
        const bw = Math.min(...base.map((r) => r.worst));
        const keep = base.filter((r) => r.worst <= bw + (cfg.poolGap ?? 0.10));
        okRows.splice(0, okRows.length, ...keep);
        best = keep.reduce((a, b) => (b.mean < a.mean ? b : a));
      } else if (cfg.poolV13) {
        // 平均每项误差比原贴图小 poolMargin（默认 5%，约为两次测量差的 2 倍标准差）才换
        best = okRows.reduce((a, b) => (b.mean < a.mean ? b : a));
        if (best !== orig && best.mean > orig.mean - (cfg.poolMargin ?? 0.05)) best = orig;
      } else {
        best = okRows.reduce((a, b) => (b.dist < a.dist ? b : a));
        if (best !== orig && best.dist > orig.dist - 0.05) best = orig;
      }
      await lab.call('restoreTextures', { ...keepTex, ...best.c.textures });
      vm = { ...vm0, ...(best.c.viewModelPatch ?? {}) };
      poolLog.push({ component: comp, picked: best.name, rows: rows.map(({ c, ...r }) => r) });
      console.log(projKey(id), 'pool', comp, rows.map((r) => `${r.name}:${cfg.poolV13 ? r.mean : r.dist}${okRows.includes(r) ? '' : '(淘汰)'}`).join(' '), '→', best.name);
    }
    current = await measureVm(vm);
  }
  const t0 = Date.now();
  const trace = { id, version, cfg, startVm: vm, steps: [], ...trace0 };
  const effect = (n) => (!cfg.probe ? '' : probe[n] ? `，改到 ${probe[n].tried} 时变化区域约 ${JSON.stringify(probe[n].box)}` : '，改了画面上看不出变化');
  const paramsText = () => specs.map((p) => `${p.name}（${p.label}，${p.panel}）范围 ${p.min}~${p.max} 步长 ${p.step}，当前 ${vm[p.name] ?? p.default}${effect(p.name)}`).join('\n');
  const start = { ...vm };
  const changedText = () => {
    const ch = specs.filter((p) => vm[p.name] !== start[p.name]).map((p) => `${p.name}=${vm[p.name]}（起点 ${start[p.name]}）`);
    return ch.length ? `当前改过的参数：${ch.join('，')}` : '当前还没改过参数';
  };
  const states = [{ ...vm }];  // states[步号] = 那一步之后的参数；revert 用
  // 对话：系统提示 + 最近几张图（早的图换成文字说明，cfg.keepImages）
  const history = [];
  const push = (role, content) => history.push({ role, content });
  const obs0 = await lab.call('obsPair', vm, [0, 0, 1, 1]);
  fs.writeFileSync(labPath(`${dir}/00-start.png`), Buffer.from(obs0, 'base64'));
  if (stages) await enterStage(0);
  push('user', [{ type: 'text', text: stages
    ? `这是起始状态的整图对比（主图 | 当前 riv）。共 ${stages.length} 个阶段：${stages.map((st) => st.name).join(' → ')} → 整体检查。\n${stageText()}\n请给出第一个动作。`
    : `可调参数：\n${paramsText()}\n\n这是起始状态的整图对比（主图 | 当前 riv）。请给出第一个动作。` }, img(obs0)]);
  let calls = 0, finished = false, tokens = { in: 0, out: 0 };
  while (!finished && calls < cfg.maxCalls && Date.now() - t0 < cfg.maxMs) {
    // 只留最近 keepImages 张图
    let seen = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (!Array.isArray(history[i].content)) continue;
      history[i].content = history[i].content.map((part) => {
        if (part.type !== 'image_url') return part;
        seen++;
        return seen <= cfg.keepImages ? part : { type: 'text', text: '（较早的观察图已省略）' };
      });
    }
    const { text, usage } = await callModel([{ role: 'system', content: SYSTEM }, ...history]);
    calls++;
    tokens.in += usage.prompt_tokens ?? 0; tokens.out += usage.completion_tokens ?? 0;
    push('assistant', text);
    let act;
    try { act = JSON.parse(text); } catch { act = null; }
    const step = { n: calls, ms: Date.now() - t0, raw: text.slice(0, 2000) };
    let reply;
    if (!act?.action) {
      reply = [{ type: 'text', text: '没能解析出 JSON 动作，请只输出约定格式的 JSON。' }];
    } else if (act.action === 'finish' && (!stages || reviewing)) {
      finished = true;
      step.action = 'finish';
    } else if (stages && (act.action === 'next' || act.action === 'finish') && !reviewing) {
      const msg = await advance();
      const os = reviewing && cfg.reviewGrid ? [await reviewGrid()] : cfg.views ? await stageImgs() : [await lab.call('obsPair', vm, [0, 0, 1, 1])];
      const o = os[os.length - 1];
      os.forEach((b, i) => fs.writeFileSync(labPath(`${dir}/${String(calls).padStart(2, '0')}-next${i ? `-${i}` : ''}.png`), Buffer.from(b, 'base64')));
      Object.assign(step, { action: 'next', to: reviewing ? 'review' : stages[si].id });
      reply = [{ type: 'text', text: `${msg}${reviewing && cfg.reviewGrid ? '分区放大检查图（每行：主图 | 当前 riv）。' : os.length > 1 ? '整图对比和分区放大图（主图 | 当前 riv）。' : '整图对比：主图 | 当前 riv。'}` }, ...os.map(img)];
    } else if (stages && act.action === 'reopen' && reviewing) {
      const k = stages.findIndex((st) => st.id === act.stage);
      if (k < 0) reply = [{ type: 'text', text: `没有阶段 ${act.stage}。` }];
      else if (cfg.guardReopen && (reopened[act.stage] ?? 0) >= (STAGES.maxReopenPerStage ?? 1)) {
        Object.assign(step, { action: 'reopen-denied', to: act.stage });
        reply = [{ type: 'text', text: `阶段 ${stages[k].name} 已经回去修过一次，不能再回去。请检查别的问题，或 finish。` }];
      } else {
        reopened[act.stage] = (reopened[act.stage] ?? 0) + 1;
        reviewing = false; returnToReview = true; si = k; stageCalls = 0; reopenCompared = !cfg.guardReopen;
        stages[k].budgetNow = null;
        await snapEntry();
        await measureRiv();
        depQueue = cfg.deps ? [...(STAGES.deps?.[act.stage] ?? [])].filter((id) => stages.some((st) => st.id === id)) : [];
        await measure(stages[k]);
        Object.assign(step, { action: 'reopen', to: act.stage });
        reply = [{ type: 'text', text: `回到阶段 ${stages[k].name}。${depQueue.length ? `修完 next 后会依次重过：${depQueue.map((id) => stages.find((st) => st.id === id).name).join('、')}，再回到整体检查。` : '修完 next 会直接回到整体检查。'}` }, ...(cfg.views ? (await stageImgs()).map(img) : [])];
      }
    } else if (act.action === 'view') {
      const box = validBox(act.box);
      const o = await lab.call('obsPair', vm, box);
      fs.writeFileSync(labPath(`${dir}/${String(calls).padStart(2, '0')}-view.png`), Buffer.from(o, 'base64'));
      Object.assign(step, { action: 'view', box });
      reply = [{ type: 'text', text: `放大框 ${JSON.stringify(box)}：主图 | 当前 riv。` }, img(o)];
    } else if (act.action === 'compare') {
      const box = validBox(act.box);
      const cands = (Array.isArray(act.candidates) ? act.candidates : []).slice(0, 4).map((c) => clampParams(c, specs, openParams()).out).filter((c) => Object.keys(c).length);
      if (stages && returnToReview && cfg.guardReopen && locked[stage()?.id]) {
        const lk = locked[stage().id];
        if (!cands.some((c) => Object.keys(lk).every((n) => (c[n] ?? vm[n]) === lk[n]))) cands.push({ ...lk });
        reopenCompared = true;
      }
      if (!cands.length) reply = [{ type: 'text', text: 'compare 需要 candidates。' }];
      else {
        const o = await lab.call('obsCandidates', cands.map((c) => ({ ...vm, ...c })), box);
        fs.writeFileSync(labPath(`${dir}/${String(calls).padStart(2, '0')}-compare.png`), Buffer.from(o, 'base64'));
        Object.assign(step, { action: 'compare', box, candidates: cands });
        const lk = stages && returnToReview ? locked[stage()?.id] : null;
        reply = [{ type: 'text', text: `框 ${JSON.stringify(box)}：主图 | ${cands.map((c, i) => `候选 ${i + 1} ${JSON.stringify(c)}${lk && Object.keys(lk).every((n) => (c[n] ?? vm[n]) === lk[n]) ? '（原定值）' : ''}`).join(' | ')}。` }, img(o)];
      }
    } else if (act.action === 'revert' && cfg.revert) {
      const k = Number(act.step);
      if (!Number.isInteger(k) || !states[k]) reply = [{ type: 'text', text: `没有第 ${act.step} 步的状态。` }];
      else {
        vm = { ...states[k] };
        await measureRiv();
        const o = await lab.call('obsPair', vm, [0, 0, 1, 1]);
        fs.writeFileSync(labPath(`${dir}/${String(calls).padStart(2, '0')}-revert.png`), Buffer.from(o, 'base64'));
        Object.assign(step, { action: 'revert', to: k });
        reply = [{ type: 'text', text: `已退回到第 ${k} 步之后的状态。整图对比：主图 | 当前 riv。` }, img(o)];
      }
    } else if (act.action === 'regenerate' && cfg.regenerate) {
      const comp = String(act.component || '');
      const stageId = REGEN_STAGE[comp];
      if (!stageId) reply = [{ type: 'text', text: `component 只能是 ${Object.keys(REGEN_STAGE).join(' / ')}。` }];
      else if (regenLog.filter((r) => r.ok).length >= (cfg.maxRegenerate ?? 2)) reply = [{ type: 'text', text: `这个项目重新生成贴图的次数已用完（最多 ${cfg.maxRegenerate ?? 2} 次）。` }];
      else {
        const before = await lab.call('textureSnapshot');
        const r = await lab.call('regenerate', comp);
        // 生图走 forge（gptimage），token 在这边看不到，只记次数：头部、头发两阶段 2 次，嘴巴 3 次，其余 1 次
        if (r.ok) logUsage('regen', 'gptimage', {}, { calls: { head: 2, hair: 2, mouth: 3 }[comp] ?? 1, component: comp });
        const rec = { component: comp, why: act.why, ok: r.ok, ms: r.ms, error: r.error ?? null, kept: false };
        if (r.ok) {
          const after = await lab.call('textureSnapshot');
          if (r.viewModelPatch) vm = { ...vm, ...r.viewModelPatch };
          // 验收：同一组参数，旧贴图 vs 新贴图，评审两次（对调）都认为新贴图更像才保留
          const boxes = await lab.call('partBoxes', vm);
          const key = { head: 'face', body: 'headShoulder', hair: 'headShoulder', sclera: 'eyes', pupil: 'leftEye', mouth: 'mouth' }[comp];
          const imgs = async (a, b) => [await lab.call('obsTextures', vm, a, b, [0, 0, 1, 1], 300), await lab.call('obsTextures', vm, a, b, boxes[key] ?? [0, 0, 1, 1], 400)];
          const gi = { ...GATE_ITEMS, regen: [regenItems[comp], 'no_glitch 没有穿帮'] };
          GATE_ITEMS.regen = gi.regen;
          const r1 = await gateAsk('regen', await imgs(before, after));
          const r2 = await gateAsk('regen', await imgs(after, before));
          rec.kept = Number(r1.better) === 2 && Number(r2.better) === 1;
          rec.gate = [r1, r2];
          if (cfg.gateTieMetrics && Number(r1.better) === Number(r2.better) && Number(r1.better) !== 0 && target) {
            const ks = Object.keys(target), before = { ...current };
            await measureRiv();
            rec.byMetrics = { before: +distOf(before, ks).toFixed(3), after: +distOf(current, ks).toFixed(3) };
            rec.kept = rec.byMetrics.after < rec.byMetrics.before - 0.05;
            if (!rec.kept) current = before;
          }
          if (!rec.kept) await lab.call('restoreTextures', before);
        }
        regenLog.push(rec);
        if (rec.kept) {
          const k = stages.findIndex((st) => st.id === stageId);
          if (k >= 0) { reviewing = false; returnToReview = false; depQueue = []; await enterStage(k); }
        }
        const o = await lab.call('obsPair', vm, [0, 0, 1, 1]);
        fs.writeFileSync(labPath(`${dir}/${String(calls).padStart(2, '0')}-regen.png`), Buffer.from(o, 'base64'));
        Object.assign(step, { action: 'regenerate', component: comp, result: rec });
        reply = [{ type: 'text', text: !r.ok ? `重新生成失败：${r.error}` : rec.kept ? `新贴图验收通过，已换上；从「${stages.find((st) => st.id === stageId)?.name}」阶段重新往后调。` : '新贴图没被评审认为更像主图，已换回旧贴图。' }, img(o)];
      }
    } else if (act.action === 'set' && stages && returnToReview && !reopenCompared) {
      Object.assign(step, { action: 'set-denied' });
      reply = [{ type: 'text', text: '从整体检查回来修的阶段，要先 compare（原定值会作为候选）确认新值更好，才能 set。' }];
    } else if (act.action === 'set') {
      const { out, rejected } = clampParams(act.params, specs, openParams());
      const prevVm = vm;
      vm = { ...vm, ...out };
      if (cfg.glitchGuard && entryGlitch && !reviewing) {
        const g = await lab.call('glitchMetrics', vm);
        const bad = [g.hairOverEye - entryGlitch.hairOverEye > 0.03 && `刘海盖住眼眶的比例从 ${entryGlitch.hairOverEye} 增加到 ${g.hairOverEye}`,
          g.irisOut - entryGlitch.irisOut > 0.03 && `虹膜露在眼白开口外的比例从 ${entryGlitch.irisOut} 增加到 ${g.irisOut}`].filter(Boolean);
        if (bad.length) {
          vm = prevVm;
          Object.assign(step, { action: 'set-guarded', params: out, glitch: g });
          reply = [{ type: 'text', text: `这次修改被拒绝：代码检查到新的穿帮——${bad.join('；')}。参数保持修改前。换别的值或别的参数。` }];
        }
      }
      if (!reply) {
        await measureRiv();
        const os = cfg.views && !reviewing ? await stageImgs() : [await lab.call('obsPair', vm, [0, 0, 1, 1])];
        os.forEach((b, i) => fs.writeFileSync(labPath(`${dir}/${String(calls).padStart(2, '0')}-set${i ? `-${i}` : ''}.png`), Buffer.from(b, 'base64')));
        Object.assign(step, { action: 'set', params: out, rejected });
        reply = [{ type: 'text', text: `已设置 ${JSON.stringify(out)}${rejected.length ? `；无效或本阶段不开放的参数 ${rejected.join(',')}` : ''}。改后：主图 | 当前 riv。` }, ...os.map(img)];
      }
    } else {
      reply = [{ type: 'text', text: `未知动作 ${act.action}。` }];
    }
    step.why = act?.why;
    if (stages) {
      step.stage = reviewing ? 'review' : stage()?.id;
      if (step.action === 'reopen' || step.action === 'reopen-denied') reviewCalls++;
      else if (step.action !== 'next') {
        if (reviewing) reviewCalls++; else stageCalls++;
      }
      // 本阶段次数用完：代码推进到下一阶段（检查阶段用完就结束）
      if (!finished && !reviewing && stageCalls >= (stage().budgetNow ?? stage().budget)) {
        const msg = await advance();
        (reply ??= []).push({ type: 'text', text: `本阶段次数用完，${msg}` });
        if (reviewing && cfg.reviewGrid) reply.push({ type: 'text', text: '分区放大检查图（每行：主图 | 当前 riv）：' }, img(await reviewGrid()));
      } else if (!finished && reviewing && reviewCalls >= STAGES.review.budget) {
        finished = true;
      }
    }
    trace.steps.push(step);
    states[calls] = { ...vm };
    console.log(projKey(id), `#${calls}`, step.action ?? '?', JSON.stringify(step.params ?? step.candidates ?? step.box ?? '').slice(0, 160), '|', String(act?.why ?? '').slice(0, 80));
    if (reply) {
      const left = cfg.maxCalls - calls;
      if (cfg.stateSummary) reply.push({ type: 'text', text: `${changedText()}。这是第 ${calls} 步。` });
      if (stages && !finished) reply.push({ type: 'text', text: stageText() });
      reply.push({ type: 'text', text: `（还能调用 ${left} 次，已用 ${Math.round((Date.now() - t0) / 1000)} 秒）${left <= 3 ? '次数快用完了，请做最后检查并收尾。' : ''}` });
      push('user', reply);
    }
  }
  // v16 最终兜底：用定标评审（同 judge.mjs）给「调整前（选完贴图后的起点）」和「最终」各打分（3 次多数票），最终不比起点好就退回起点
  if (cfg.finalGuard) {
    const a = await judgeVm(lab, start, 3, 'guard'), b = await judgeVm(lab, vm, 3, 'guard');
    const reverted = b.score < a.score;
    trace.finalGuard = { start: a.score, final: b.score, reverted };
    console.log(projKey(id), '最终兜底', `起点 ${a.score} / 最终 ${b.score}`, reverted ? '→ 退回起点' : '→ 保留最终');
    if (reverted) vm = { ...start };
  }
  Object.assign(trace, { poolLog, gateLog, regenLog, target, finalMetrics: current, fallbacks: fallbackCount.n, usage: summarize(`${version}/${projKey(id)}`) });
  fallbackCount.n = 0;
  Object.assign(trace, { finalVm: vm, calls, ms: Date.now() - t0, finished, tokens, stages: stages?.map((st) => ({ id: st.id, measured: st.measured ?? null })), locked, reopened });
  // 换过贴图的，存最终贴图，评审 / 出图时按它复现
  if (regenLog.some((r) => r.kept) || poolLog.some((r) => r.picked !== 'original')) writeJson(`${dir}/textures.json`, await lab.call('textureSnapshot'));
  writeJson(`${dir}/trace.json`, trace);
  return trace;
}

const lab = await openLab();
try {
  for (const id of ids) {
    let t;
    try { t = await runOne(lab, id); } catch (e) {
      console.log(projKey(id), '报错停止：', e.message);
      writeJson(`results/agent/${version}/${projKey(id)}/error.json`, { id, version, error: e.message, at: new Date().toISOString() });
      continue;
    }
    console.log(projKey(id), 'done', t.calls, 'calls', Math.round(t.ms / 1000), 's', 'tokens', JSON.stringify(t.tokens), 'finished', t.finished);
  }
} finally { await Promise.race([lab.close(), new Promise((o) => setTimeout(o, 15000))]); }  // 关浏览器偶尔卡住，最多等 15 秒
process.exit(0);
