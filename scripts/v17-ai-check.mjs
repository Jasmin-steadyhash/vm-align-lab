// v17 第 2 步验证：新 AI 层（逐方面对比 + "缺失或画坏"否决 + 循环换位）只跑挑选这一步；面部顺带测 F2 鼻底相对高度（AI 在单张贴图上标鼻底）
// 结果只用来决定启用还是放弃，不按结果改提示词
import fs from 'node:fs';
import { openLab, projectInput, readJson, writeJson, labPath, avaPath } from './lab.mjs';
import { decode } from './png-decode.mjs';
import { locate } from './landmarks.mjs';
import { logUsage, setUsageTag } from './usage.mjs';
const MODEL = 'gpt-6.1-sol', KEY = fs.readFileSync(avaPath('.dev.vars'), 'utf8').match(/^IMAGE_API_KEY=(.*)$/m)[1].trim();
const OUT = labPath('results/v17-ai-check'); fs.mkdirSync(OUT, { recursive: true });
const AID = { head: '6845562', body: '6845564', sclera: '6845565', pupil: '6845574', mouth_down: '6845581', mouth_up: '6845582' };
const med = (v) => { v = v.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : NaN; };
const P = (pts, n, i) => med(pts.map((p) => p?.[n]?.[i]));
const raw = readJson('results/metric-check/raw.json');
const PTS = { ...Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.slice(0, 8), v.master])), dfb3bc24: JSON.parse(fs.readFileSync('/tmp/master-pts.json', 'utf8')) };
const FULL = { '1cf5ecc9': '1cf5ecc9-873b-4a81-9595-2e2672a9b3c7', '41e01792': '41e01792-7a2c-4ce2-801d-704c1e08f4e7', '9ee088da': '9ee088da-1409-477e-9cf4-1959c79293db', dfb3bc24: 'e2e-dfb3bc24-86fd-4619-b6e3-f85e1fcc4e29' };

// ─── 各组件的填空（照 results/v17-pick-spec.md）───
const SPEC = {
  head: { comp: '脸部', part: '脸部', has: '脸部轮廓、眉毛、鼻子、耳朵、肤色和脸上的阴影红晕', other: '眼睛、嘴、头发', extra: '候选上之后会被前发盖住的额头和两鬓不比。', adj: '整体大小和位置',
    aspects: ['脸部轮廓：下颌线走向，下巴尖、圆或方，两颊饱满程度', '脸的宽窄：贴图自身的脸宽与脸长之比', '眉毛：形状、粗细、走向，在脸上的高低', '鼻子：形状和画法，在眉和下巴之间的高低', '耳朵：形状、露出多少', '肤色与红晕：深浅冷暖，红晕的有无和位置'] },
  body: { comp: '身体', part: '脖子到身体', has: '脖子、肩、上身服装', other: '头、脸、头发', extra: '贴图顶部之后会被头盖住的部分、候选比主图多出来的下半身、脖子露出多长（由位置决定）都不比；候选上画着的头发只看是否和主图对应。', adj: '大小、上下左右位置',
    aspects: ['领口：领子类型、开口形状和深浅、左右是否对称', '肩形：平肩还是溜肩、肩线弧度', '脖子：粗细相对肩宽', '服装结构：门襟、领带或领结、扣子、口袋、外套层次', '颜色：服装各部分的颜色'] },
  sclera: { comp: '眼眶', part: '双眼', has: '眼线、睫毛、眼白', other: '虹膜、瞳孔、眉、脸', extra: '候选画的是画面左侧那只眼（外眼角在左），画面右侧那只由它镜像得到；以主图里看得更清楚的那只眼为准，看右眼时按镜像后比较。', adj: '宽、高、位置（候选已拉成统一宽高）',
    aspects: ['上眼线：粗细、走势、末端是否延长或上挑', '睫毛：有无、数量、长短、长在哪一段', '下眼线：有无、覆盖范围', '眼形：上眼睑最高点偏内还是偏外，内外眼角的高低', '眼尾朝向：外眼角是否在左', '双眼皮线：有无、位置', '颜色：眼线颜色、眼白颜色'] },
  pupil: { comp: '瞳孔（虹膜）', part: '眼睛', has: '虹膜和瞳孔（候选是完整圆形，贴上后会被眼眶遮住一部分）', other: '眼眶、眼白、眼睑', extra: '主图被眼睑、睫毛、头发挡住的部分不比，候选画完整不算错。', adj: '大小、位置',
    aspects: ['主色与渐变：主色，上下、内外的明暗方向', '纹理：放射纹、环纹、纯色', '瞳孔：中心深色区的形状、相对虹膜的大小', '外圈描边：有无、粗细', '高光：数量、位置、形状'] },
  mouth: { comp: '嘴', part: '嘴', has: '上唇和下唇', other: '脸、鼻、下巴', extra: '', adj: '宽窄、整体厚薄、位置（候选已拉成统一宽高比）',
    aspects: ['开合：闭、微张、张开，露不露牙或舌', '嘴角：上扬、平、下垂', '唇形：唇峰的 M 形、下唇弧度', '上下唇比例：谁厚、差多少（只比两者之比）', '唇线与颜色：描边、唇色、高光'] },
};
const promptOf = (s) => `你在为 2D 角色挑选「${s.comp}」图层贴图。第一格是主图的${s.part}，后面 A、B、C… 是候选贴图，单独显示。
这个图层只含：${s.has}。${s.other}属于别的图层，候选上本来就没有，不比。${s.extra}
${s.adj}之后都能用参数调，不比。主图是插画、候选是模板贴图，画风、线条粗细、光影质感的差异不比。
主图里被头发、手、帽子、耳机、道具等挡住或在画面外的部分，判「看不见」，不比，也不要猜。
先写出主图在每个方面的特征（看不见写 null），再把每张候选按下面的方面逐一和主图对比，不要凭整体印象。每项判：一致 / 接近 / 不同 / 缺失或画坏 / 看不见。
「缺失或画坏」只用于：主图上看得见、候选上没有；或候选这一部分残缺、变形、画坏。
方面：
${s.aspects.map((a, i) => `${i + 1}. ${a}`).join('\n')}
${s.aspects.length + 1}. 其他：上面没覆盖到的、候选和主图明显不一致，或候选多出主图没有的东西（没有就判一致）。
方面名用冒号前的词（最后一项叫"其他"）。只输出 JSON：{"master":{"方面":"特征或null"},"scores":{"A":{"方面":"一致|接近|不同|缺失或画坏|看不见"}},"best":"字母","reason":"一句话"}`;

async function ask(sys, img) {
  for (let attempt = 1; attempt <= 15; attempt++) {
    const t0 = Date.now();
    const res = await fetch('https://tenantapi.anispark.ai/llm/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(240000),
      body: JSON.stringify({ model: MODEL, temperature: 0.2, messages: [{ role: 'system', content: sys }, { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${img}` } }] }], response_format: { type: 'json_object' }, max_tokens: 4000 }) }).catch(() => null);
    if (res?.ok) { const j = await res.json(); logUsage('v17-ai', MODEL, j.usage, { ms: Date.now() - t0 }); try { return JSON.parse(j.choices[0].message.content); } catch { continue; } }
    await new Promise((o) => setTimeout(o, res?.status === 429 ? 20000 : 5000));
  }
  throw new Error('调用失败');
}

// ─── 计分 / 投票 / 否决 ───
const SC = { 一致: 2, 接近: 1, 不同: 0, 缺失或画坏: 0 };
const aspectNames = (s) => [...s.aspects.map((a) => a.split('：')[0]), '其他'];
function scoreAsk(a, names, n, order) {
  // order[画面位置] = 原候选下标；返回按原候选下标的分数、缺失标记
  const out = Array.from({ length: n }, () => ({ score: NaN, bad: [] }));
  order.forEach((ci, pos) => {
    const s = a.scores?.[String.fromCharCode(65 + pos)] || {}; let sum = 0, cnt = 0;
    for (const nm of names) { const v = s[nm]; if (a.master?.[nm] == null && nm !== '其他') continue; if (v in SC) { sum += SC[v]; cnt++; } if (v === '缺失或画坏') out[ci].bad.push(nm); }
    out[ci].score = cnt ? sum / (2 * cnt) : NaN;
  });
  return out;
}
async function pickGroup(g) {
  const s = SPEC[g.comp], sys = promptOf(s), names = aspectNames(s), n = g.cands.length;
  const rot = Array.from({ length: n }, (_, k) => Array.from({ length: n }, (_, i) => (i - k + n) % n)); // 循环移位：ABC → CAB → BCA
  const asks = [];
  const run = async (q) => {
    const order = rot[q], img = g.imgs[q];
    const a = await ask(sys, img); return { q, order, a, s: scoreAsk(a, names, n, order) };
  };
  // 前 2 问并发
  asks.push(...(await Promise.all([0, 1].map(run))));
  const avg = () => g.cands.map((_, i) => asks.reduce((t, x) => t + (Number.isFinite(x.s[i].score) ? x.s[i].score : 0), 0) / asks.length);
  const top2 = () => { const v = avg().map((x, i) => [x, i]).sort((a, b) => b[0] - a[0]); return v; };
  const first = (x) => x.s.map((y, i) => [y.score, i]).sort((a, b) => b[0] - a[0])[0][1];
  let t = top2();
  if (!(first(asks[0]) === first(asks[1]) && t[0][0] - t[1][0] >= 0.1)) for (let q = 2; q < n; q++) asks.push(await run(q));
  // 否决：同一候选同一方面 ≥2 问判"缺失或画坏"（且主图该方面非 null）；同批该方面全被判掉则只作废该方面；全部出局则否决作废
  const badCnt = g.cands.map((_, i) => { const c = {}; asks.forEach((x) => x.s[i].bad.forEach((nm) => { if (x.a.master?.[nm] != null || nm === '其他') c[nm] = (c[nm] || 0) + 1; })); return c; });
  const vetoAspects = g.cands.map((_, i) => Object.keys(badCnt[i]).filter((nm) => badCnt[i][nm] >= 2));
  const voidAspects = new Set(names.filter((nm) => g.cands.every((_, i) => vetoAspects[i].includes(nm))));
  let out = g.cands.map((_, i) => vetoAspects[i].filter((nm) => !voidAspects.has(nm)).length > 0);
  if (out.every(Boolean)) out = out.map(() => false);
  const sc = avg(), alive = sc.map((x, i) => [x, i]).filter(([, i]) => !out[i]).sort((a, b) => b[0] - a[0]);
  return {
    key: g.key, comp: g.comp, asks: asks.length, names: g.cands.map((c) => c.name),
    perAsk: asks.map((x) => ({ order: x.order.map((i) => g.cands[i].name), best: x.a.best, reason: x.a.reason, scores: x.s.map((y) => +y.score.toFixed(2)), bad: x.s.map((y) => y.bad), master: x.a.master })),
    avg: sc.map((x) => +x.toFixed(2)), veto: g.cands.map((c, i) => (out[i] ? vetoAspects[i].filter((nm) => !voidAspects.has(nm)) : [])), voidAspects: [...voidAspects],
    picked: g.cands[alive[0][1]].name, lowConf: alive.length > 1 && alive[0][0] - alive[1][0] < 0.05,
  };
}

// ─── F2：面部候选上 AI 标鼻底，代码找眉线 / 下巴 ───
function browChin(t) {
  let x0 = t.w, y0 = t.h, x1 = -1, y1 = -1; const A = (x, y) => t.d[(y * t.w + x) * 4 + 3];
  for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) if (A(x, y) >= 128) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, cx = (x0 + x1) / 2;
  const lum = (x, y) => { const k = (y * t.w + x) * 4; return t.d[k + 3] < 128 ? 255 : 0.3 * t.d[k] + 0.59 * t.d[k + 1] + 0.11 * t.d[k + 2]; };
  const browOf = (xa, xb) => { let best = 1e9, by = -1; for (let y = Math.round(y0 + 0.25 * bh); y < y0 + 0.55 * bh; y++) { const v = []; for (let x = xa; x < xb; x++) v.push(lum(x, y)); v.sort((a, b) => a - b); const k = Math.max(4, v.length >> 3), m = v.slice(0, k).reduce((a, c) => a + c, 0) / k; if (m < best) { best = m; by = y; } } return by; };
  return { brow: (browOf(Math.round(x0 + 0.08 * bw), Math.round(cx - 3)) + browOf(Math.round(cx + 3), Math.round(x1 - 0.08 * bw))) / 2, chin: y1 };
}

// ─── 组 ───
const pool = (p, c, i) => readJson(`results/pool/${p}/${c}-${i}.json`).textures;
const orig = (p) => JSON.parse(fs.readFileSync(`/tmp/vm17/off/${p}.json`, 'utf8')).original;
const e2e = (c, i) => (i === 1 ? Object.fromEntries(Object.values(AID).filter((a) => fs.existsSync(labPath(`data/e2e/${FULL.dfb3bc24.slice(4)}/tex/${a}.png`))).map((a) => [a, fs.readFileSync(labPath(`data/e2e/${FULL.dfb3bc24.slice(4)}/tex/${a}.png`)).toString('base64')])) : readJson(`data/e2e/${FULL.dfb3bc24.slice(4)}/pool/${c}-${i}.json`).textures);
const devCands = (p, c, aids) => [{ name: '原贴图', t: orig(p) }, ...[1, 2, 3].map((i) => ({ name: `候选${i}`, t: pool(p, c, i) }))].map((x) => ({ name: x.name, layers: aids.map((a) => x.t[a]) }));
const dfbCands = (c, aids) => [1, 2, 3].map((i) => ({ name: `候选${i}`, layers: aids.map((a) => e2e(c, i)[a]) }));
const GROUPS = [
  { key: '1cf5ecc9-head', p: '1cf5ecc9', comp: 'head', cands: devCands('1cf5ecc9', 'head', [AID.head]) },
  { key: '9ee088da-head', p: '9ee088da', comp: 'head', cands: devCands('9ee088da', 'head', [AID.head]) },
  { key: '41e01792-head', p: '41e01792', comp: 'head', cands: devCands('41e01792', 'head', [AID.head]) },
  { key: 'dfb3bc24-body', p: 'dfb3bc24', comp: 'body', cands: dfbCands('body', [AID.body]) },
  { key: 'dfb3bc24-pupil', p: 'dfb3bc24', comp: 'pupil', cands: dfbCands('pupil', [AID.pupil]) },
  { key: '1cf5ecc9-mouth', p: '1cf5ecc9', comp: 'mouth', cands: devCands('1cf5ecc9', 'mouth', [AID.mouth_up, AID.mouth_down]) },
  { key: '41e01792-sclera', p: '41e01792', comp: 'sclera', cands: devCands('41e01792', 'sclera', [AID.sclera]) },
];
// 宽高可分别调的组件：候选拉到同批宽高比中位数
const bboxAspect = (layers) => { const ims = layers.map((b) => decode(Buffer.from(b, 'base64'))), W = ims[0].w, H = ims[0].h; let x0 = W, y0 = H, x1 = -1, y1 = -1; for (const t of ims) for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) if (t.d[(y * t.w + x) * 4 + 3] >= 128) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } return (x1 - x0 + 1) / (y1 - y0 + 1); };
for (const g of GROUPS) if (g.comp === 'sclera' || g.comp === 'mouth') g.aspect = med(g.cands.map((c) => bboxAspect(c.layers)));

const lab = await openLab(), report = { groups: [], f2: [] };
try {
  for (const p of [...new Set(GROUPS.map((g) => g.p))]) {
    await lab.call('loadProject', projectInput(FULL[p])); await lab.call('loadMaster');
    const { W, H } = await lab.call('masterForPoints'), pts = PTS[p], Q = (nm, i) => P(pts, nm, i);
    const browY = (Q('brow_l', 1) + Q('brow_r', 1)) / 2, chin = Q('chin', 1), FL = chin - browY, FW = Q('cheek_r', 0) - Q('cheek_l', 0), cx = (Q('cheek_l', 0) + Q('cheek_r', 0)) / 2;
    const ew = Math.abs(Q('eye_l_inner', 0) - Q('eye_l_outer', 0)), eh = Math.abs(Q('eye_l_bottom', 1) - Q('eye_l_top', 1)), mw = Q('mouth_r', 0) - Q('mouth_l', 0), my = (Q('mouth_l', 1) + Q('mouth_r', 1)) / 2, mx = (Q('mouth_l', 0) + Q('mouth_r', 0)) / 2;
    const rel = (x0, y0, x1, y1) => [Math.max(0, x0) / W, Math.max(0, y0) / H, (Math.min(W, x1) - Math.max(0, x0)) / W, (Math.min(H, y1) - Math.max(0, y0)) / H];
    const half = Math.max(FW, FL) * 0.75;
    const BOX = {
      head: rel(cx - half, browY - 0.45 * FL, cx + half, chin + 0.15 * FL),
      body: rel(0, chin - 0.2 * FL, W, H),
      pupil: rel(Q('iris_l_center', 0) - 0.75 * ew, Q('iris_l_center', 1) - 0.75 * ew, Q('iris_l_center', 0) + 0.75 * ew, Q('iris_l_center', 1) + 0.75 * ew),
      mouth: rel(mx - mw, my - 0.6 * mw, mx + mw, my + 0.6 * mw),
      sclera: rel(Math.min(Q('eye_l_outer', 0), Q('eye_l_inner', 0)) - 0.4 * ew, (Q('brow_l', 1) + Q('eye_l', 1)) / 2, Q('eye_r', 0) + ew * 0.9, Q('eye_l_bottom', 1) + 1.2 * eh),
    };
    // 拼图必须在当前项目（主图）加载时画好：每组所有循环移位都先画出来
    for (const g of GROUPS.filter((x) => x.p === p)) {
      g.box = BOX[g.comp]; const n = g.cands.length; g.imgs = [];
      for (let k = 0; k < n; k++) { const order = Array.from({ length: n }, (_, i) => (i - k + n) % n); const img = await lab.call('choiceImage2', g.box, order.map((i) => g.cands[i].layers), { aspect: g.aspect }); g.imgs.push(img); fs.writeFileSync(`${OUT}/${g.key}-q${k + 1}.png`, Buffer.from(img, 'base64')); }
    }
    // F2：面部候选标鼻底（并发）
    const headG = GROUPS.find((x) => x.p === p && x.comp === 'head');
    if (headG && !process.env.DRY) {
      setUsageTag(`v17-f2/${p}`);
      const masterRel = (Q('nose', 1) - browY) / FL;
      const rows = await Promise.all(headG.cands.map(async (c) => {
        const w = await lab.call('onWhite', c.layers[0]), pt = await locate(MODEL, w, { nose: '鼻底（鼻尖下沿）。这张图是单独的脸部贴图，没有眼睛和嘴；如果没画鼻子，给 null' });
        const bc = browChin(decode(Buffer.from(c.layers[0], 'base64'))), ny = pt?.nose?.[1];
        const f2 = Number.isFinite(ny) ? (ny - bc.brow) / (bc.chin - bc.brow) : NaN;
        return { p, name: c.name, nose: pt?.nose ?? null, f2, err: Number.isFinite(f2) ? f2 / masterRel - 1 : NaN };
      }));
      const best = Math.min(...rows.map((r) => Math.abs(r.err)).filter(Number.isFinite));
      rows.forEach((r) => { r.cut = Number.isFinite(r.err) && Math.abs(r.err) > 0.12 && Math.abs(r.err) - best >= 0.10; });
      report.f2.push({ p, masterRel, rows });
    }
  }
  // AI 挑选：各组并发
  const res = process.env.DRY ? [] : await Promise.all(GROUPS.map(async (g) => { setUsageTag(`v17-ai/${g.key}`); try { return await pickGroup(g); } catch (e) { return { key: g.key, error: String(e) }; } }));
  report.groups = res;
} finally { await Promise.race([lab.close(), new Promise((o) => setTimeout(o, 10000))]); }
writeJson('results/v17-ai-check/report.json', report);
for (const f of report.f2) { console.log(`== F2 ${f.p}（主图 ${f.masterRel.toFixed(3)}）`); f.rows.forEach((r) => console.log(`   ${r.name} 鼻底 ${JSON.stringify(r.nose)} F2=${Number.isFinite(r.f2) ? r.f2.toFixed(3) : '-'} 误差 ${Number.isFinite(r.err) ? (r.err * 100).toFixed(0) + '%' : '未测到'}${r.cut ? ' ← 淘汰' : ''}`)); }
for (const g of report.groups) {
  if (g.error) { console.log(`== ${g.key} 失败：${g.error}`); continue; }
  console.log(`== ${g.key}（问 ${g.asks} 次）→ 选 ${g.picked}${g.lowConf ? '（低置信）' : ''}`);
  g.names.forEach((nm, i) => console.log(`   ${nm} 平均分 ${g.avg[i]}${g.veto[i].length ? ' ← 否决：' + g.veto[i].join('、') : ''}  各问 ${g.perAsk.map((x) => x.scores[i]).join(' / ')}  缺失或画坏 ${g.perAsk.map((x) => x.bad[i].join('、') || '-').join(' / ')}`));
  if (g.voidAspects.length) console.log('   作废的方面：', g.voidAspects.join('、'));
}
process.exit(0);
