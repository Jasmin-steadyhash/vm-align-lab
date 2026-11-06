// lab 渲染页：按 Studio 同样的方式恢复线上项目（模板 riv + 组件结果 + finishOnePlan），提供渲染 / 打分截图 / 方案 A 对齐。
// 由 Playwright 从 Node 调 window.lab.*，图片字节一律 base64 进出。
import { parseRiveFile } from '@client/utils/riveParser';
import { buildKnownPlansFromAssets, resolveKnownComponentKey } from '@client/constants/componentPromptMapping';
import { finishOnePlan, applyMatchedTemplate } from '@client/hooks/useAutoGenerate';
import { compositeCentered, readImageDimensions } from '@client/utils/imageUtils';
import { arrayBufferToBase64 } from '@client/utils/fileUtils';
import { OVERLAYS_OFF, createOffscreenRenderer } from '@client/utils/riveOffscreen';
import { composeScoreCapture } from '@client/components/rivScore/capture';
import { MASTER_W, MASTER_H } from '@client/constants/autoGenerate';
import { SCORE_CAPTURE_WIDTH, SCORE_CAPTURE_HEIGHT } from '../../shared/rivScore.js';

// ── 线上 CDN 图片改读本地副本（data/img，scripts/fetch-images.mjs 下的） ──
const imgMap = await (await fetch('/img/map.json')).json();
const rawFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input?.url;
  if (url && url.startsWith('http://localhost:8790/')) return rawFetch(url.replace('http://localhost:8790', ''), init);
  if (url && /^https?:/.test(url)) {
    const u = new URL(url);
    u.searchParams.delete('ctx');
    const local = imgMap[u.toString()] ?? imgMap[url];
    if (local) return rawFetch(`/img/${local}`, init?.method === 'HEAD' ? { method: 'HEAD' } : undefined);
  }
  return rawFetch(input, init);
};

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const readBytes = async (url) => {
  const res = await window.fetch(url);
  if (!res.ok) throw new Error(`fetch ${res.status} ${url}`);
  return new Uint8Array(await res.arrayBuffer());
};

// Studio 恢复时要再对齐的组件（StudioCore RESTORE_NEEDS_ALIGNMENT），其余组件（头发、嘴）结果图已在 riv 坐标里
const RESTORE_NEEDS_ALIGNMENT = new Set(['head', 'sclera', 'eyebrow', 'body', 'pupil', 'arm', 'background']);
const STEP_FOR_ROLE = { hair_back: 'back-final', hair_front: 'front-final', mouth_up: 'up-final', mouth_down: 'down-final' };

// 后发槽位比主画布大时，540×960 的旧后发居中补边（RiveContext padHairBackToSlot）
async function padHairBack(newBytes, slotBytes) {
  const [n, slot] = await Promise.all([readImageDimensions(newBytes), readImageDimensions(slotBytes)]);
  if (n.width !== MASTER_W || n.height !== MASTER_H || slot.width <= MASTER_W || slot.height <= MASTER_H) return newBytes;
  return compositeCentered(newBytes, slot.width / 2, slot.height / 2, slot.width, slot.height);
}

let S = null; // 当前项目：{ projectId, rivFilename, rivBuffer, modifiedAssets, masterUrl, savedVm, plans, has }

async function loadProject({ project, jobs }) {
  const rivFilename = project.riv_template_key;
  const rivBuffer = await (await rawFetch(`/riv/${encodeURIComponent(rivFilename)}`)).arrayBuffer();
  const file = parseRiveFile(rivBuffer.slice(0));
  const assets = [...file.assets.values()].filter((a) => a.type === 'ImageAsset');
  const plans = buildKnownPlansFromAssets(assets);
  const draft = JSON.parse(project.draft_state_json || '{}');
  const masterUrl = project.main_image;
  const masterImage = await readBytes(masterUrl);
  const headPlan = plans.find((p) => p.key === 'head');
  const headReferenceBytes = headPlan ? file.assets.get(headPlan.assetId)?.bytes : null;
  const modifiedAssets = {};
  const restored = [];
  for (const asset of assets) {
    const id = String(asset._mapKey);
    const d = draft.assetDrafts?.[id];
    if (!d) continue;
    const role = resolveKnownComponentKey(asset.name);
    const plan = plans.find((p) => String(p.assetId) === id) ?? { key: role, w: null, h: null };
    const originalBytes = asset.bytes;
    let newBytes = null;
    if (d.finalUrl) {
      newBytes = await readBytes(d.finalUrl);
    } else if (d.jobId && jobs[d.jobId]) {
      const job = jobs[d.jobId];
      const steps = JSON.parse(job.steps_json || '[]');
      const url = (STEP_FOR_ROLE[role] && steps.find((s) => s.name === STEP_FOR_ROLE[role])?.url) || job.result_image_url;
      const raw = await readBytes(url);
      newBytes = RESTORE_NEEDS_ALIGNMENT.has(role)
        ? (await finishOnePlan({ ...plan, rivFilename }, raw, originalBytes, { mode: job.mode, targetW: plan.w, targetH: plan.h, masterImage, headReferenceBytes })).finalBytes
        : raw;
    } else if (d.templateRef) {
      newBytes = role === 'head' || role === 'sclera'
        ? (await applyMatchedTemplate({ ...plan, rivFilename }, { resultImageUrl: d.templateRef, filename: d.templateRef.split('/').pop(), originalBytes })).matchedBytes
        : await readBytes(d.templateRef);
    }
    if (!newBytes) continue;
    if (role === 'hair_back' && !d.finalUrl) newBytes = await padHairBack(newBytes, originalBytes);
    modifiedAssets[asset._mapKey] = { originalBytes, newBytes, originalSize: originalBytes.length };
    restored.push(role);
  }
  // riv 里有哪些 VM 属性：开一个渲染器看一眼
  const probe = await createOffscreenRenderer(rivBuffer, modifiedAssets, { width: 64, height: 114 });
  const names = new Set();
  try {
    for (const n of Object.keys((await import('@client/constants/vmParamConfig')).VM_PARAM_CONFIG)) if (probe.has(n)) names.add(n);
  } finally { probe.destroy(); }
  M = null;
  FRAME = null;
  S = { projectId: project.id, rivFilename, rivBuffer, modifiedAssets, masterUrl, savedVm: draft.viewModelState ?? {}, plans, has: names };
  return { rivFilename, restored, vmProps: [...names], savedVm: S.savedVm };
}

// 每次渲染新建渲染器（同一渲染器连续截图会漂移，见交接文件），返回 RGBA 或 PNG
async function withRenderer(w, h, fn) {
  const r = await createOffscreenRenderer(S.rivBuffer, S.modifiedAssets, { width: w, height: h });
  try { return await fn(r); } finally { r.destroy(); }
}

/** 整幅渲染 PNG（base64），叠加层全关 */
async function render(vm, { w = 1080, h = 1920 } = {}) {
  return withRenderer(w, h, async (r) => {
    r.set({ ...vm, ...OVERLAYS_OFF });
    return arrayBufferToBase64(await r.snapshotPng());
  });
}

/** 整幅 RGBA 摘要：用于确定性检查（同一 VM 两次渲染是否一致） */
async function renderHash(vm, { w = 540, h = 960 } = {}) {
  return withRenderer(w, h, async (r) => {
    r.set({ ...vm, ...OVERLAYS_OFF });
    const d = await r.rgba();
    let hsh = 2166136261;
    for (let i = 0; i < d.length; i += 7) { hsh ^= d[i]; hsh = Math.imul(hsh, 16777619); }
    return { hash: hsh >>> 0, len: d.length };
  });
}

/** 和正式打分同样的截图：768×1365 离屏渲染、背景/背景图/参考图关掉，按角色左右裁、铺白底 */
async function scoreCapture(vm) {
  const W = SCORE_CAPTURE_WIDTH, H = SCORE_CAPTURE_HEIGHT;
  return withRenderer(W, H, async (r) => {
    r.setInputs({ BG: false });
    r.set({ ...vm, ...OVERLAYS_OFF, Background_image_alpha: 0 });
    const bitmap = await createImageBitmap(new ImageData(await r.rgba(), W, H));
    try {
      return arrayBufferToBase64(await composeScoreCapture(bitmap));
    } finally { bitmap.close(); }
  });
}

// 方案 A（原「按主图对齐比例」）已随 main 下线（5762482），对比实验结果留在 results/a/
window.lab = { loadProject, render, renderHash, scoreCapture, ready: true, b64ToBytes };

/** 同一 VM 渲染 n 次，和第一次比：不同像素数、最大通道差、差异外框 */
async function renderDiff(vm, { n = 3, w = 540, h = 960 } = {}) {
  const shots = [];
  for (let i = 0; i < n; i++) shots.push(await withRenderer(w, h, async (r) => { r.set({ ...vm, ...OVERLAYS_OFF }); return new Uint8ClampedArray(await r.rgba()); }));
  return shots.slice(1).map((d) => {
    let px = 0, maxd = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let p = 0; p < w * h; p++) {
      let m = 0;
      for (let c = 0; c < 4; c++) m = Math.max(m, Math.abs(d[p * 4 + c] - shots[0][p * 4 + c]));
      if (!m) continue;
      px++; maxd = Math.max(maxd, m);
      const x = p % w, y = (p / w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return { px, maxd, box: px ? [x0, y0, x1, y1] : null };
  });
}
window.lab.renderDiff = renderDiff;

// ════════════════════ 方案 B（AI agent）的观察工具 ════════════════════
// 只做执行：渲染、按主图取景、裁图、拼图。决策（看哪、调什么、调多少）全在 agent（scripts/agent.mjs）。
import { VM_PARAM_CONFIG } from '@client/constants/vmParamConfig';
import { translations } from '@client/i18n';

const OBS_RENDER_W = 1080, OBS_RENDER_H = 1920;
let M = null; // 主图：{ bitmap, w, h, box }
let FRAME = null; // 冻结的 riv 取景外框（freezeFrame）

// 非背景外框。透明图按 alpha；不透明图（主图常是白底 jpg）按和四角平均色的差
function contentBoxOf(data, w, h) {
  let transparent = false;
  for (let i = 3; i < data.length; i += 4 * 97) if (data[i] < 250) { transparent = true; break; }
  const corner = [0, w - 1, (h - 1) * w, h * w - 1].map((p) => [data[p * 4], data[p * 4 + 1], data[p * 4 + 2]]);
  const bg = [0, 1, 2].map((c) => corner.reduce((s, v) => s + v[c], 0) / 4);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const fg = transparent ? data[i + 3] > 16
      : Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > 40;
    if (!fg) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? { x: 0, y: 0, w, h } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

async function loadMaster() {
  const bytes = await readBytes(S.masterUrl);
  const bitmap = await createImageBitmap(new Blob([bytes]));
  const c = new OffscreenCanvas(bitmap.width, bitmap.height), g = c.getContext('2d');
  g.drawImage(bitmap, 0, 0);
  M = { bitmap, w: bitmap.width, h: bitmap.height, box: contentBoxOf(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height) };
}

// 渲染一张，按角色外框（宽度、头顶）对齐到主图取景，画进主图同尺寸白底画布
async function framedRender(vm) {
  if (!M) await loadMaster();
  const rgba = await withRenderer(OBS_RENDER_W, OBS_RENDER_H, async (r) => { r.set({ ...vm, ...OVERLAYS_OFF, Background_image_alpha: 0 }); return new Uint8ClampedArray(await r.rgba()); });
  // 取景：冻结时一直用起点算出的那个（参数改大改小在图里看得出来），没冻结按当前外框
  const rb = FRAME ?? contentBoxOf(rgba, OBS_RENDER_W, OBS_RENDER_H);
  const src = await createImageBitmap(new ImageData(rgba, OBS_RENDER_W, OBS_RENDER_H));
  const s = M.box.w / rb.w;
  const c = new OffscreenCanvas(M.w, M.h), g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, M.w, M.h);
  g.drawImage(src, M.box.x - rb.x * s, M.box.y - rb.y * s, OBS_RENDER_W * s, OBS_RENDER_H * s);
  src.close();
  return c;
}

// 相对框 [x, y, w, h]（0..1，主图坐标）→ 像素
const boxPx = ([x, y, w, h]) => [x * M.w, y * M.h, w * M.w, h * M.h].map(Math.round);

function drawTile(g, src, box, dx, dy, tw, th, label) {
  const [sx, sy, sw, sh] = boxPx(box);
  g.fillStyle = '#fff'; g.fillRect(dx, dy, tw, th);
  const k = Math.min(tw / sw, (th - 28) / sh);
  g.drawImage(src, sx, sy, sw, sh, dx + (tw - sw * k) / 2, dy + 28 + (th - 28 - sh * k) / 2, sw * k, sh * k);
  g.fillStyle = '#000'; g.font = 'bold 22px sans-serif'; g.fillText(label, dx + 8, dy + 22);
  g.strokeStyle = '#999'; g.strokeRect(dx + 0.5, dy + 0.5, tw - 1, th - 1);
}

async function pngB64(c) {
  const blob = await c.convertToBlob({ type: 'image/png' });
  return arrayBufferToBase64(new Uint8Array(await blob.arrayBuffer()));
}

/** 主图 | 当前渲染，同一相对框各裁一块并排。tile：每格边长 */
async function obsPair(vm, box = [0, 0, 1, 1], tile = 640) {
  const fr = await framedRender(vm);
  const [, , sw, sh] = boxPx(box);
  const th = Math.round(tile * Math.min(2, Math.max(0.5, sh / sw))) + 28;
  const c = new OffscreenCanvas(tile * 2, th), g = c.getContext('2d');
  drawTile(g, M.bitmap, box, 0, 0, tile, th, '主图');
  drawTile(g, fr, box, tile, 0, tile, th, '当前 riv');
  return pngB64(c);
}

/** 主图 + 若干候选 VM 的渲染，同一相对框，排成一行：主图 | 候选 1 | 候选 2 … */
async function obsCandidates(vms, box = [0, 0, 1, 1], tile = 420) {
  const frames = [];
  for (const vm of vms) frames.push(await framedRender(vm));
  const [, , sw, sh] = boxPx(box);
  const th = Math.round(tile * Math.min(2, Math.max(0.5, sh / sw))) + 28;
  const c = new OffscreenCanvas(tile * (vms.length + 1), th), g = c.getContext('2d');
  drawTile(g, M.bitmap, box, 0, 0, tile, th, '主图');
  frames.forEach((fr, i) => drawTile(g, fr, box, tile * (i + 1), 0, tile, th, `候选 ${i + 1}`));
  return pngB64(c);
}

/** agent 可调的参数：VM_PARAM_CONFIG 里有范围、riv 里有、不属于参考图/背景显示的数值参数 */
const EXCLUDED_PANELS = new Set(['guide', 'bg', 'background']);
function tunableParams() {
  const zh = translations.zh;
  return Object.entries(VM_PARAM_CONFIG)
    .filter(([n, c]) => S.has.has(n) && typeof c.min === 'number' && !EXCLUDED_PANELS.has(c.panel))
    .map(([n, c]) => ({ name: n, label: zh[`vm_label_${n}`] || n, panel: c.panel, min: c.min, max: c.max, step: c.step, default: c.default }));
}

Object.assign(window.lab, { obsPair, obsCandidates, tunableParams, loadMaster: async () => { M = null; await loadMaster(); return { w: M.w, h: M.h, box: M.box }; } });

/** 按这组 VM 的角色外框冻结取景，之后所有观察图都用它；传 null 取消冻结 */
async function freezeFrame(vm) {
  if (!vm) { FRAME = null; return null; }
  const rgba = await withRenderer(OBS_RENDER_W, OBS_RENDER_H, async (r) => { r.set({ ...vm, ...OVERLAYS_OFF, Background_image_alpha: 0 }); return new Uint8ClampedArray(await r.rgba()); });
  FRAME = contentBoxOf(rgba, OBS_RENDER_W, OBS_RENDER_H);
  return FRAME;
}

/** 每个可调参数改一点，看画面上哪块变了（主图坐标下的相对框），给 agent 当参数说明 */
async function probeParams(vm, specs) {
  if (!M) await loadMaster();
  if (!FRAME) await freezeFrame(vm);
  const render = async (v) => withRenderer(540, 960, async (r) => { r.set({ ...v, ...OVERLAYS_OFF, Background_image_alpha: 0 }); return new Uint8ClampedArray(await r.rgba()); });
  const base = await render(vm);
  const out = {};
  for (const p of specs) {
    const cur = vm[p.name] ?? p.default;
    const delta = (p.max - p.min) * 0.15;
    const v = cur + delta <= p.max ? cur + delta : cur - delta;
    const d = await render({ ...vm, [p.name]: v });
    let x0 = 540, y0 = 960, x1 = -1, y1 = -1, n = 0;
    for (let i = 0; i < 540 * 960; i++) {
      if (Math.abs(d[i * 4 + 3] - base[i * 4 + 3]) + Math.abs(d[i * 4] - base[i * 4]) < 24) continue;
      n++; const x = i % 540, y = (i / 540) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (n < 20) { out[p.name] = null; continue; }
    // 渲染像素（540×960，即 1080×1920 的一半）→ 观察图（主图）坐标的相对框，和 view/compare 的 box 同一坐标
    const s = M.box.w / FRAME.w, toX = (x) => (M.box.x + (x * 2 - FRAME.x) * s) / M.w, toY = (y) => (M.box.y + (y * 2 - FRAME.y) * s) / M.h;
    const bx0 = toX(x0), by0 = toY(y0), bx1 = toX(x1 + 1), by1 = toY(y1 + 1);
    out[p.name] = { box: [bx0, by0, bx1 - bx0, by1 - by0].map((t) => Math.round(t * 100) / 100), tried: Math.round(v * 10) / 10 };
  }
  return out;
}
Object.assign(window.lab, { freezeFrame, probeParams });

// ════════════ 参数 → 部件 影响关系（实测）════════════
// 每个部件贴图换成一种纯色，参数改一点，看哪些颜色的像素动了（质心位移、外框尺寸变化），得到「改这个参数会带动哪些部件」
const PART_COLORS = {
  hair_back: [0, 255, 0], hair_front: [0, 0, 255], head: [255, 0, 0], body: [255, 255, 0], sclera: [255, 0, 255],
  pupil: [0, 255, 255], mouth_up: [128, 0, 0], mouth_down: [0, 128, 0], eyebrow: [0, 0, 128], arm: [128, 128, 0],
};
async function tintBytes(bytes, color) {
  const bmp = await createImageBitmap(new Blob([bytes]));
  const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d');
  g.drawImage(bmp, 0, 0); bmp.close();
  const im = g.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < im.data.length; i += 4) [im.data[i], im.data[i + 1], im.data[i + 2]] = color;
  g.putImageData(im, 0, 0);
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
}
// isolate：每次只显示一个部件（其余贴图换成全透明），排除「被别的部件挡住才看起来动了」的误判
async function clearBytes(bytes) {
  const bmp = await createImageBitmap(new Blob([bytes]));
  const c = new OffscreenCanvas(bmp.width, bmp.height); c.getContext('2d'); bmp.close();
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
}
async function couplingIsolated(vm, specs) {
  const file = parseRiveFile(S.rivBuffer.slice(0));
  const assets = [...file.assets.values()].filter((a) => a.type === 'ImageAsset');
  const layers = [];
  for (const a of assets) {
    const role = resolveKnownComponentKey(a.name);
    if (!PART_COLORS[role]) continue;
    const cur = S.modifiedAssets[a._mapKey]?.newBytes ?? a.bytes;
    layers.push({ id: a._mapKey, role, orig: a.bytes, tinted: await tintBytes(cur, PART_COLORS[role]), clear: await clearBytes(cur) });
  }
  const W = 540, H = 960, out = {}, visibleParts = [];
  for (const L of layers) {
    const mods = Object.fromEntries(layers.map((o) => [o.id, { originalBytes: o.orig, newBytes: o === L ? o.tinted : o.clear, originalSize: o.orig.length }]));
    const shot = async (v) => {
      const r = await createOffscreenRenderer(S.rivBuffer, mods, { width: W, height: H });
      try { r.set({ ...v, ...OVERLAYS_OFF, Background_image_alpha: 0 }); return new Uint8ClampedArray(await r.rgba()); } finally { r.destroy(); }
    };
    // 只数这个部件的纯色像素：没登记的贴图（嘴里、睫毛、饰品等）不清空，按透明度数会把它们算进来
    const col = PART_COLORS[L.role];
    const st = (d) => { let n = 0, sx = 0, sy = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let i = 0; i < W * H; i++) { const k = i * 4; if (d[k + 3] < 128 || Math.abs(d[k] - col[0]) + Math.abs(d[k + 1] - col[1]) + Math.abs(d[k + 2] - col[2]) > 60) continue; const x = i % W, y = (i / W) | 0; n++; sx += x; sy += y; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      return n < 30 ? null : { cx: sx / n, cy: sy / n, w: x1 - x0 + 1, h: y1 - y0 + 1 }; };
    const base = st(await shot(vm));
    if (!base) continue;
    visibleParts.push(L.role);
    for (const p of specs) {
      const cur = vm[p.name] ?? p.default, delta = (p.max - p.min) * 0.12;
      const v = cur + delta <= p.max ? cur + delta : cur - delta;
      const b = st(await shot({ ...vm, [p.name]: v }));
      out[p.name] ??= { tried: +v.toFixed(1), moved: {} };
      if (!b) { out[p.name].moved[L.role] = { hidden: true }; continue; }
      const dPos = Math.hypot(b.cx - base.cx, b.cy - base.cy), dSize = Math.max(Math.abs(b.w - base.w), Math.abs(b.h - base.h));
      if (dPos > 1.5 || dSize > 2) out[p.name].moved[L.role] = { dx: +(b.cx - base.cx).toFixed(1), dy: +(b.cy - base.cy).toFixed(1), dw: b.w - base.w, dh: b.h - base.h };
    }
  }
  return { parts: visibleParts, out };
}
window.lab.couplingIsolated = couplingIsolated;

async function couplingMap(vm, specs) {
  const file = parseRiveFile(S.rivBuffer.slice(0));
  const assets = [...file.assets.values()].filter((a) => a.type === 'ImageAsset');
  const tinted = {}, parts = [];
  for (const a of assets) {
    const role = resolveKnownComponentKey(a.name);
    if (!PART_COLORS[role]) continue;
    const cur = S.modifiedAssets[a._mapKey]?.newBytes ?? a.bytes;
    tinted[a._mapKey] = { originalBytes: a.bytes, newBytes: await tintBytes(cur, PART_COLORS[role]), originalSize: a.bytes.length };
    parts.push(role);
  }
  const W = 540, H = 960;
  const shot = async (v) => {
    const r = await createOffscreenRenderer(S.rivBuffer, tinted, { width: W, height: H });
    try { r.set({ ...v, ...OVERLAYS_OFF, Background_image_alpha: 0 }); return new Uint8ClampedArray(await r.rgba()); } finally { r.destroy(); }
  };
  const stats = (d) => Object.fromEntries(parts.map((p) => {
    const col = PART_COLORS[p];
    let n = 0, sx = 0, sy = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let i = 0; i < W * H; i++) {
      const k = i * 4;
      if (d[k + 3] < 200 || Math.abs(d[k] - col[0]) + Math.abs(d[k + 1] - col[1]) + Math.abs(d[k + 2] - col[2]) > 60) continue;
      const x = i % W, y = (i / W) | 0; n++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return [p, n < 30 ? null : { cx: sx / n, cy: sy / n, w: x1 - x0 + 1, h: y1 - y0 + 1, n }];
  }));
  const base = stats(await shot(vm));
  const out = {};
  for (const p of specs) {
    const cur = vm[p.name] ?? p.default, delta = (p.max - p.min) * 0.12;
    const v = cur + delta <= p.max ? cur + delta : cur - delta;
    const s = stats(await shot({ ...vm, [p.name]: v }));
    const moved = {};
    for (const part of parts) {
      const a = base[part], b = s[part];
      if (!a || !b) continue;
      const dPos = Math.hypot(b.cx - a.cx, b.cy - a.cy), dSize = Math.max(Math.abs(b.w - a.w), Math.abs(b.h - a.h));
      if (dPos > 1.5 || dSize > 2) moved[part] = { dx: +(b.cx - a.cx).toFixed(1), dy: +(b.cy - a.cy).toFixed(1), dw: b.w - a.w, dh: b.h - a.h };
    }
    out[p.name] = { tried: +v.toFixed(1), moved };
  }
  return { parts, out };
}
window.lab.couplingMap = couplingMap;

/** 只显示 role 这个部件（纯色），vmA / vmB 各渲染一次，返回两张图里这个颜色的像素有几个不一样、不一样的像素外框 */
async function isolatedDiff(role, vmA, vmB) {
  const file = parseRiveFile(S.rivBuffer.slice(0));
  const assets = [...file.assets.values()].filter((a) => a.type === 'ImageAsset');
  const mods = {};
  for (const a of assets) {
    const r = resolveKnownComponentKey(a.name);
    if (!PART_COLORS[r]) continue;
    const cur = S.modifiedAssets[a._mapKey]?.newBytes ?? a.bytes;
    mods[a._mapKey] = { originalBytes: a.bytes, newBytes: r === role ? await tintBytes(cur, PART_COLORS[r]) : await clearBytes(cur), originalSize: a.bytes.length };
  }
  const W = 540, H = 960, col = PART_COLORS[role];
  const shot = async (v) => { const r = await createOffscreenRenderer(S.rivBuffer, mods, { width: W, height: H }); try { r.set({ ...v, ...OVERLAYS_OFF, Background_image_alpha: 0 }); return new Uint8ClampedArray(await r.rgba()); } finally { r.destroy(); } };
  const is = (d, k) => d[k + 3] >= 128 && Math.abs(d[k] - col[0]) + Math.abs(d[k + 1] - col[1]) + Math.abs(d[k + 2] - col[2]) <= 60;
  const a = await shot(vmA), b = await shot(vmB);
  let n = 0, x0 = W, y0 = H, x1 = -1, y1 = -1, na = 0;
  for (let i = 0; i < W * H; i++) {
    const k = i * 4; if (is(a, k)) na++;
    if (is(a, k) === is(b, k)) continue;
    n++; const x = i % W, y = (i / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { partPx: na, changedPx: n, box: n ? [x0, y0, x1, y1] : null };
}
window.lab.isolatedDiff = isolatedDiff;

// ════════════ v4：参数作用规则、部位框、分区放大检查图 ════════════
// 只显示 roles 这些部件（纯色）的渲染器工厂：同一套贴图替换反复用来渲染不同 VM
async function isolatedShooter(roles) {
  const file = parseRiveFile(S.rivBuffer.slice(0));
  const assets = [...file.assets.values()].filter((a) => a.type === 'ImageAsset');
  const mods = {};
  for (const a of assets) {
    const r = resolveKnownComponentKey(a.name);
    if (!PART_COLORS[r]) continue;
    const cur = S.modifiedAssets[a._mapKey]?.newBytes ?? a.bytes;
    mods[a._mapKey] = { originalBytes: a.bytes, newBytes: roles.includes(r) ? await tintBytes(cur, PART_COLORS[r]) : await clearBytes(cur), originalSize: a.bytes.length };
  }
  const W = 540, H = 960;
  return async (v) => {
    const r = await createOffscreenRenderer(S.rivBuffer, mods, { width: W, height: H });
    let d;
    try { r.set({ ...v, ...OVERLAYS_OFF, Background_image_alpha: 0 }); d = new Uint8ClampedArray(await r.rgba()); } finally { r.destroy(); }
    // 这些部件纯色像素的质心和外框，换算成主图坐标（px，和观察图同一坐标）
    let n = 0, sx = 0, sy = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let i = 0; i < W * H; i++) {
      const k = i * 4;
      if (d[k + 3] < 128 || !roles.some((role) => { const c = PART_COLORS[role]; return Math.abs(d[k] - c[0]) + Math.abs(d[k + 1] - c[1]) + Math.abs(d[k + 2] - c[2]) <= 60; })) continue;
      const x = i % W, y = (i / W) | 0; n++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (n < 30) return null;
    const s = M.box.w / FRAME.w, X = (x) => M.box.x + (x * 2 - FRAME.x) * s, Y = (y) => M.box.y + (y * 2 - FRAME.y) * s;
    return { cx: X(sx / n), cy: Y(sy / n), x0: X(x0), y0: Y(y0), x1: X(x1 + 1), y1: Y(y1 + 1), w: (x1 - x0 + 1) * 2 * s, h: (y1 - y0 + 1) * 2 * s };
  };
}

/**
 * 一个阶段的参数作用规则：每个参数调大、调小各渲染一次（只显示该阶段的部件），量出每单位让部件质心、宽高变多少（主图像素），
 * 外加部件在主图坐标的相对框（放大看用）。roles：该阶段的部件
 */
async function stageEffects(vm, roles, params) {
  if (!M) await loadMaster();
  if (!FRAME) await freezeFrame(vm);
  const shoot = await isolatedShooter(roles);
  const base = await shoot(vm);
  if (!base) return { box: null, effects: {} };
  const specs = tunableParams();
  const effects = {};
  for (const name of params) {
    const p = specs.find((q) => q.name === name);
    if (!p) continue;
    const cur = vm[name] ?? p.default, d = Math.max(p.step, (p.max - p.min) * 0.06);
    const up = Math.min(p.max, cur + d), dn = Math.max(p.min, cur - d);
    const [a, b] = [await shoot({ ...vm, [name]: up }), await shoot({ ...vm, [name]: dn })];
    if (!a || !b || up === dn) { effects[name] = null; continue; }
    const per = (k) => +((a[k] - b[k]) / (up - dn)).toFixed(3);
    effects[name] = { dx: per('cx'), dy: per('cy'), dw: per('w'), dh: per('h') };
  }
  const pad = 0.6;
  const bw = base.x1 - base.x0, bh = base.y1 - base.y0;
  const bx0 = Math.max(0, base.x0 - bw * pad), by0 = Math.max(0, base.y0 - bh * pad);
  const bx1 = Math.min(M.w, base.x1 + bw * pad), by1 = Math.min(M.h, base.y1 + bh * pad);
  return {
    part: { cx: Math.round(base.cx), cy: Math.round(base.cy), w: Math.round(base.w), h: Math.round(base.h) },
    box: [bx0 / M.w, by0 / M.h, (bx1 - bx0) / M.w, (by1 - by0) / M.h].map((t) => Math.round(t * 1000) / 1000),
    effects,
  };
}

/** 分区放大检查图：每个框一行「标签 | 主图 | 当前 riv」，拼成一张 */
async function obsGrid(vm, items, tile = 360) {
  const fr = await framedRender(vm);
  const rows = items.map((it) => { const [, , sw, sh] = boxPx(it.box); return Math.round(tile * Math.min(1.4, Math.max(0.5, sh / sw))) + 28; });
  const c = new OffscreenCanvas(tile * 2, rows.reduce((s, h) => s + h, 0)), g = c.getContext('2d');
  let y = 0;
  items.forEach((it, i) => {
    drawTile(g, M.bitmap, it.box, 0, y, tile, rows[i], `${it.label} · 主图`);
    drawTile(g, fr, it.box, tile, y, tile, rows[i], `${it.label} · 当前 riv`);
    y += rows[i];
  });
  return pngB64(c);
}
Object.assign(window.lab, { stageEffects, obsGrid });

/** riv 里所有 VM 数值属性名（不限 VM_PARAM_CONFIG） */
async function allVmNumbers() {
  const riveModule = await import('@rive-app/canvas');
  const names = [];
  await withRenderer(64, 114, async (r) => { names.push(...(r.names?.() ?? [])); });
  return names;
}
/** 只显示瞳孔（纯色），分左右半边各算质心：看参数是镜像移动还是同向 */
async function pupilHalves(vm, name, delta) {
  const shootSplit = async (v) => {
    const shoot = await isolatedShooter(['pupil']);
    return shoot;
  };
  const W = 540, H = 960;
  const file = parseRiveFile(S.rivBuffer.slice(0));
  const mods = {};
  for (const a of [...file.assets.values()].filter((x) => x.type === 'ImageAsset')) {
    const r = resolveKnownComponentKey(a.name);
    if (!PART_COLORS[r]) continue;
    const cur = S.modifiedAssets[a._mapKey]?.newBytes ?? a.bytes;
    mods[a._mapKey] = { originalBytes: a.bytes, newBytes: r === 'pupil' ? await tintBytes(cur, PART_COLORS.pupil) : await clearBytes(cur), originalSize: a.bytes.length };
  }
  const shot = async (v) => { const r = await createOffscreenRenderer(S.rivBuffer, mods, { width: W, height: H }); try { r.set({ ...v, ...OVERLAYS_OFF, Background_image_alpha: 0 }); return new Uint8ClampedArray(await r.rgba()); } finally { r.destroy(); } };
  const halves = (d) => [[0, W / 2], [W / 2, W]].map(([a, b]) => { let n = 0, sx = 0, sy = 0; for (let y = 0; y < H; y++) for (let x = a; x < b; x++) { const k = (y * W + x) * 4; if (d[k + 3] < 128) continue; n++; sx += x; sy += y; } return n ? { cx: +(sx / n).toFixed(2), cy: +(sy / n).toFixed(2), n } : null; });
  const base = halves(await shot(vm)), moved = halves(await shot({ ...vm, [name]: (vm[name] ?? 0) + delta }));
  return { base, moved };
}
Object.assign(window.lab, { pupilHalves });

// ════════════ 参数说明表：每个参数对每个部件的作用（平移、缩放、镜像、缩放中心）════════════
// 一次只显示一个部件（纯色、其余清空），参数调大调小各渲染一次；部件分左右两半各量一次（中线 = 部件起点质心 x）
async function paramAtlas(vm, names, roles = Object.keys(PART_COLORS)) {
  const W = 540, H = 960;
  const file = parseRiveFile(S.rivBuffer.slice(0));
  const assets = [...file.assets.values()].filter((a) => a.type === 'ImageAsset');
  const specs = Object.fromEntries(Object.entries(VM_PARAM_CONFIG));
  const out = {};
  for (const role of roles) {
    const mods = {};
    let found = false;
    for (const a of assets) {
      const r = resolveKnownComponentKey(a.name);
      if (!PART_COLORS[r]) continue;
      if (r === role) found = true;
      const cur = S.modifiedAssets[a._mapKey]?.newBytes ?? a.bytes;
      mods[a._mapKey] = { originalBytes: a.bytes, newBytes: r === role ? await tintBytes(cur, PART_COLORS[r]) : await clearBytes(cur), originalSize: a.bytes.length };
    }
    if (!found) continue;
    const col = PART_COLORS[role];
    const shot = async (v) => { const r = await createOffscreenRenderer(S.rivBuffer, mods, { width: W, height: H }); try { r.set({ ...v, ...OVERLAYS_OFF, Background_image_alpha: 0 }); return new Uint8ClampedArray(await r.rgba()); } finally { r.destroy(); } };
    const isPx = (d, k) => d[k + 3] >= 128 && Math.abs(d[k] - col[0]) + Math.abs(d[k + 1] - col[1]) + Math.abs(d[k + 2] - col[2]) <= 60;
    const box = (d, xa, xb) => { let n = 0, sx = 0, sy = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let y = 0; y < H; y++) for (let x = xa; x < xb; x++) { const k = (y * W + x) * 4; if (!isPx(d, k)) continue; n++; sx += x; sy += y; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      return n < 20 ? null : { n, cx: sx / n, cy: sy / n, x0, y0, x1: x1 + 1, y1: y1 + 1, w: x1 + 1 - x0, h: y1 + 1 - y0 }; };
    const d0 = await shot(vm);
    const all0 = box(d0, 0, W);
    if (!all0) continue;
    const mid = Math.round(all0.cx);
    // 左右两半之间有空隙（两只眼）才算成对部件
    const L0 = box(d0, 0, mid), R0 = box(d0, mid, W);
    const paired = !!(L0 && R0 && L0.x1 < mid - 2 && R0.x0 > mid + 2);
    for (const name of names) {
      const sp = specs[name];
      if (!sp || typeof sp.min !== 'number') continue;
      const cur = vm[name] ?? sp.default, d = Math.max(sp.step, (sp.max - sp.min) * 0.1);
      const up = Math.min(sp.max, cur + d), dn = Math.max(sp.min, cur - d);
      const [da, db] = [await shot({ ...vm, [name]: up }), await shot({ ...vm, [name]: dn })];
      const meas = (xa, xb) => {
        const a = box(da, xa, xb), b = box(db, xa, xb), o = box(d0, xa, xb);
        if (!a || !b || !o) return a || b ? { vanished: true } : null;
        const per = (k) => (a[k] - b[k]) / (up - dn);
        const r = { dx: per('cx'), dy: per('cy'), dw: per('w'), dh: per('h'), w: o.w, h: o.h, cx: o.cx, cy: o.cy };
        // 缩放中心：边缘变化量 = (缩放比例 - 1) × (边缘 - 中心)，按两侧边缘解
        const sx = (a.w - b.w) / o.w, sy = (a.h - b.h) / o.h;
        if (Math.abs(sx) > 0.01) r.pivotX = o.x0 - ((a.x0 - b.x0) / sx);
        if (Math.abs(sy) > 0.01) r.pivotY = o.y0 - ((a.y0 - b.y0) / sy);
        return r;
      };
      const whole = meas(0, W);
      const moved = whole && (whole.vanished || Math.abs(whole.dx) * d > 1 || Math.abs(whole.dy) * d > 1 || Math.abs(whole.dw) * d > 1.5 || Math.abs(whole.dh) * d > 1.5);
      // 判断变化量太小的再用像素差确认（防外框抖动误判：要两张图实际不同）
      let diffPx = 0; for (let i = 0; i < W * H; i++) { const k = i * 4; if (isPx(da, k) !== isPx(db, k)) diffPx++; }
      if (!moved && diffPx < 30) continue;
      (out[name] ??= { range: [sp.min, sp.max], step: sp.step, default: sp.default, tried: [dn, up], parts: {} }).parts[role] = {
        diffPx, whole, ...(paired ? { left: meas(0, mid), right: meas(mid, W) } : {}),
      };
    }
  }
  return out;
}
window.lab.paramAtlas = paramAtlas;

// ════════════ 评审用的观察图 ════════════
// 部位框（主图坐标相对框）由当前参数下各部件的实际位置算出：头+肩、脸部（眉眼鼻嘴）、左眼单只、嘴
async function partBoxes(vm) {
  const get = async (roles) => (await isolatedShooter(roles))(vm);
  const [head, body, eye, mouth] = [await get(['head']), await get(['body']), await get(['sclera']), await get(['mouth_up', 'mouth_down'])];
  const rel = (x0, y0, x1, y1) => {
    const a = Math.max(0, x0), b = Math.max(0, y0), c = Math.min(M.w, x1), d = Math.min(M.h, y1);
    return [a / M.w, b / M.h, (c - a) / M.w, (d - b) / M.h].map((t) => Math.round(t * 1000) / 1000);
  };
  const out = {};
  if (head && body) out.headShoulder = rel(Math.min(head.x0, body.x0) - 10, head.y0 - head.h * 0.25, Math.max(head.x1, body.x1) + 10, body.y0 + (body.y1 - body.y0) * 0.45);
  if (head) out.face = rel(head.cx - head.w * 0.42, head.cy - head.h * 0.42, head.cx + head.w * 0.42, head.cy + head.h * 0.32);
  if (eye) { const ew = eye.w / 2; out.leftEye = rel(eye.x0 - ew * 0.25, eye.cy - ew * 0.55, eye.x0 + ew * 1.05, eye.cy + ew * 0.55); out.eyes = rel(eye.x0 - ew * 0.3, eye.cy - ew * 0.6, eye.x1 + ew * 0.3, eye.cy + ew * 0.6); }
  if (mouth) out.mouth = rel(mouth.cx - mouth.w * 1.6, mouth.cy - mouth.w * 1.1, mouth.cx + mouth.w * 1.6, mouth.cy + mouth.w * 1.1);
  return out;
}
const BOX_LABEL = { headShoulder: '头和肩', face: '脸部', eyes: '双眼', leftEye: '左眼（画面左侧）', mouth: '嘴' };
async function judgeImages(vm) {
  if (!M) await loadMaster();
  const boxes = await partBoxes(vm);
  const items = Object.entries(boxes).map(([k, box]) => ({ label: BOX_LABEL[k], box }));
  // 眼睛单独一张大图（虹膜判断靠它），其余部位一张分区图
  const eyeItems = items.filter((it) => it.label === BOX_LABEL.leftEye || it.label === BOX_LABEL.eyes);
  const rest = items.filter((it) => !eyeItems.includes(it));
  return { full: await obsPair(vm, [0, 0, 1, 1], 512), grid: await obsGrid(vm, rest, 340), eyes: eyeItems.length ? await obsGrid(vm, eyeItems, 560) : null, boxes };
}
Object.assign(window.lab, { partBoxes, judgeImages });

// ════════════ v6：代码穿帮守卫 ════════════
// 全部部件纯色渲染（按 riv 本来的层级叠），再分别单独渲染眼眶、瞳孔：
//   hairOverEye = 眼眶像素里被前发颜色盖住的比例；irisOut = 可见虹膜里落在眼眶贴图（眼白开口）外的比例
async function glitchMetrics(vm) {
  const W = 540, H = 960;
  const file = parseRiveFile(S.rivBuffer.slice(0));
  const assets = [...file.assets.values()].filter((a) => a.type === 'ImageAsset');
  const build = async (show) => {
    const mods = {};
    for (const a of assets) {
      const r = resolveKnownComponentKey(a.name);
      if (!PART_COLORS[r]) continue;
      const cur = S.modifiedAssets[a._mapKey]?.newBytes ?? a.bytes;
      mods[a._mapKey] = { originalBytes: a.bytes, newBytes: show.includes(r) ? await tintBytes(cur, PART_COLORS[r]) : await clearBytes(cur), originalSize: a.bytes.length };
    }
    const r = await createOffscreenRenderer(S.rivBuffer, mods, { width: W, height: H });
    try { r.set({ ...vm, ...OVERLAYS_OFF, Background_image_alpha: 0 }); return new Uint8ClampedArray(await r.rgba()); } finally { r.destroy(); }
  };
  const near = (d, k, c) => d[k + 3] >= 128 && Math.abs(d[k] - c[0]) + Math.abs(d[k + 1] - c[1]) + Math.abs(d[k + 2] - c[2]) <= 60;
  const [eyeOnly, eyeHair, pupilOnly] = [await build(['sclera']), await build(['sclera', 'hair_front']), await build(['pupil'])];
  // 眼白开口：眼眶贴图原色单独渲染，取亮、低饱和的像素；每列眼白的上下边界
  const real = {};
  for (const a of assets) {
    const r = resolveKnownComponentKey(a.name);
    if (!PART_COLORS[r]) continue;
    const cur = S.modifiedAssets[a._mapKey]?.newBytes ?? a.bytes;
    real[a._mapKey] = { originalBytes: a.bytes, newBytes: r === 'sclera' ? cur : await clearBytes(cur), originalSize: a.bytes.length };
  }
  const rr = await createOffscreenRenderer(S.rivBuffer, real, { width: W, height: H });
  let white;
  try { rr.set({ ...vm, ...OVERLAYS_OFF, Background_image_alpha: 0 }); white = new Uint8ClampedArray(await rr.rgba()); } finally { rr.destroy(); }
  const top = new Int32Array(W).fill(H), bot = new Int32Array(W).fill(-1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = (y * W + x) * 4, r = white[k], g = white[k + 1], b = white[k + 2];
    if (white[k + 3] < 128 || Math.min(r, g, b) < 170 || Math.max(r, g, b) - Math.min(r, g, b) > 45) continue;
    if (y < top[x]) top[x] = y; if (y > bot[x]) bot[x] = y;
  }
  let sc = 0, covered = 0, pu = 0, out = 0;
  for (let i = 0; i < W * H; i++) {
    const k = i * 4;
    const isSc = near(eyeOnly, k, PART_COLORS.sclera);
    if (isSc) { sc++; if (near(eyeHair, k, PART_COLORS.hair_front)) covered++; }
    if (near(pupilOnly, k, PART_COLORS.pupil)) { pu++; const x = i % W, y = (i / W) | 0; if (bot[x] < 0 || y < top[x] - 1 || y > bot[x] + 1) out++; }
  }
  return { hairOverEye: sc ? +(covered / sc).toFixed(3) : 0, irisOut: pu ? +(out / pu).toFixed(3) : 0 };
}
window.lab.glitchMetrics = glitchMetrics;

// ════════════ 模型评测题目 ════════════
/** 两组参数的渲染并排（不含主图），同一相对框：A | B */
async function obsTwo(vmA, vmB, box = [0, 0, 1, 1], tile = 420) {
  if (!M) await loadMaster();
  const [a, b] = [await framedRender(vmA), await framedRender(vmB)];
  const [, , sw, sh] = boxPx(box);
  const th = Math.round(tile * Math.min(2, Math.max(0.5, sh / sw))) + 28;
  const c = new OffscreenCanvas(tile * 2, th), g = c.getContext('2d');
  drawTile(g, a, box, 0, 0, tile, th, 'A');
  drawTile(g, b, box, tile, 0, tile, th, 'B');
  return pngB64(c);
}
Object.assign(window.lab, { obsTwo });

// ════════════ 关键点评测：riv 渲染上代码算出的真值 ════════════
/** 当前参数的整幅渲染（叠加层关）+ 各部件纯色单独量出的关键点（像素，渲染图坐标） */
async function landmarkTruth(vm, W = 720, H = 1280) {
  const png = await withRenderer(W, H, async (r) => { r.set({ ...vm, ...OVERLAYS_OFF, Background_image_alpha: 0 }); return arrayBufferToBase64(await r.snapshotPng()); });
  const file = parseRiveFile(S.rivBuffer.slice(0));
  const assets = [...file.assets.values()].filter((a) => a.type === 'ImageAsset');
  const shot = async (role) => {
    const mods = {};
    for (const a of assets) {
      const r = resolveKnownComponentKey(a.name);
      if (!PART_COLORS[r]) continue;
      const cur = S.modifiedAssets[a._mapKey]?.newBytes ?? a.bytes;
      mods[a._mapKey] = { originalBytes: a.bytes, newBytes: r === role ? await tintBytes(cur, PART_COLORS[r]) : await clearBytes(cur), originalSize: a.bytes.length };
    }
    const r = await createOffscreenRenderer(S.rivBuffer, mods, { width: W, height: H });
    try { r.set({ ...vm, ...OVERLAYS_OFF, Background_image_alpha: 0 }); return new Uint8ClampedArray(await r.rgba()); } finally { r.destroy(); }
  };
  const boxIn = (d, xa, xb) => { let n = 0, sx = 0, sy = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = xa; x < xb; x++) { const k = (y * W + x) * 4; if (d[k + 3] < 128) continue; n++; sx += x; sy += y; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return n ? { cx: sx / n, cy: sy / n, x0, y0, x1, y1 } : null; };
  const sc = await shot('sclera'), pu = await shot('pupil'), mu = await shot('mouth_up'), md = await shot('mouth_down'), hd = await shot('head');
  const all = boxIn(sc, 0, W), mid = Math.round(all.cx);
  const eL = boxIn(sc, 0, mid), eR = boxIn(sc, mid, W), iL = boxIn(pu, 0, mid), iR = boxIn(pu, mid, W);
  const mouthBoth = new Uint8ClampedArray(mu.length); for (let i = 3; i < mu.length; i += 4) mouthBoth[i] = Math.max(mu[i], md[i]);
  const m = boxIn(mouthBoth, 0, W), h = boxIn(hd, 0, W);
  return { png, W, H, truth: {
    left_eye_center: [eL.cx, eL.cy], right_eye_center: [eR.cx, eR.cy],
    left_iris_center: [iL.cx, iL.cy], right_iris_center: [iR.cx, iR.cy],
    mouth_left_corner: [m.x0, (m.y0 + m.y1) / 2], mouth_right_corner: [m.x1, (m.y0 + m.y1) / 2],
    chin: [h.cx, h.y1],
  }, faceWidthPx: (eR.x1 - eL.x0) };
}
window.lab.landmarkTruth = landmarkTruth;

// ════════════ v7：给 AI 定点用的图 ════════════
/** 主图缩到高不超过 1280 的 PNG */
async function masterForPoints() {
  if (!M) await loadMaster();
  const k = Math.min(1, 1280 / M.h), W = Math.round(M.w * k), H = Math.round(M.h * k);
  const c = new OffscreenCanvas(W, H); c.getContext('2d').drawImage(M.bitmap, 0, 0, W, H);
  return { png: await pngB64(c), W, H };
}
/** riv 当前参数整幅渲染（720×1280，白底，叠加层关） */
async function rivForPoints(vm) {
  const W = 720, H = 1280;
  const rgba = await withRenderer(W, H, async (r) => { r.set({ ...vm, ...OVERLAYS_OFF, Background_image_alpha: 0 }); return new Uint8ClampedArray(await r.rgba()); });
  const c = new OffscreenCanvas(W, H), g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.drawImage(await createImageBitmap(new ImageData(rgba, W, H)), 0, 0);
  return { png: await pngB64(c), W, H };
}
Object.assign(window.lab, { masterForPoints, rivForPoints });

// ════════════ v8：重新生成组件贴图（本地 worker + forge 生图，处理方式同 Studio）════════════
import { setPipelineRuntime } from '@client/utils/pipelineRuntime';
import { awaitJob } from '@client/utils/awaitJob';
import { apiFetchJson } from '@client/api/client';
import { buildComponentJobRequest } from '../../shared/componentJob.js';
import { generateHairPipeline, generateMouthPipeline } from '@client/hooks/useAutoGenerate';

setPipelineRuntime({
  createJob: async (body) => (await apiFetchJson('api/generation-jobs', { method: 'POST', body: JSON.stringify(body) })).job,
  awaitJob,
  registerBackfill: (id, fn) => awaitJob(id).then((job) => fn({ resultImageUrl: job.resultImageUrl, meta: job.meta, job })),
});

const assetOf = (role) => {
  const file = parseRiveFile(S.rivBuffer.slice(0));
  return [...file.assets.values()].find((a) => a.type === 'ImageAsset' && resolveKnownComponentKey(a.name) === role);
};
const setTexture = (asset, newBytes) => { S.modifiedAssets[asset._mapKey] = { originalBytes: asset.bytes, newBytes, originalSize: asset.bytes.length }; };

/**
 * 重新生成一个组件（role：head / sclera / pupil / body / hair / mouth），生成完替换进当前 riv。
 * 返回 { ok, jobId, ms, viewModelPatch }；失败返回 { ok: false, error }
 */
async function regenerate(role) {
  const t0 = performance.now();
  const masterImage = await readBytes(S.masterUrl);
  try {
    if (role === 'hair') {
      const back = assetOf('hair_back'), front = assetOf('hair_front'), head = assetOf('head');
      const plan = S.plans.find((p) => p.key === 'hair_back');
      const r = await generateHairPipeline(masterImage, head.bytes, S.projectId, { masterImageUrl: S.masterUrl, backCanvas: plan ? { width: plan.w, height: plan.h } : null });
      setTexture(back, await padHairBack(r.hairBackBytes, back.bytes));
      setTexture(front, r.hairFrontBytes);
      return { ok: true, jobId: r.jobId, ms: Math.round(performance.now() - t0) };
    }
    if (role === 'mouth') {
      const up = assetOf('mouth_up'), down = assetOf('mouth_down');
      const r = await generateMouthPipeline(masterImage, up.bytes, down.bytes, S.projectId, { masterImageUrl: S.masterUrl });
      setTexture(up, r.mouthUpBytes); setTexture(down, r.mouthDownBytes);
      return { ok: true, jobId: r.jobId, ms: Math.round(performance.now() - t0) };
    }
    const asset = assetOf(role);
    const plan = S.plans.find((p) => p.key === role);
    if (!asset || !plan) return { ok: false, error: `riv 里没有 ${role}` };
    const job = (await apiFetchJson('api/generation-jobs', { method: 'POST', body: JSON.stringify(buildComponentJobRequest(plan, { mainImageUrl: S.masterUrl, projectId: S.projectId, kind: 'component' })) })).job;
    const done = await awaitJob(job.id);
    const raw = await readBytes(done.resultImageUrl);
    const headAsset = assetOf('head');
    const { finalBytes, viewModelPatch } = await finishOnePlan({ ...plan, rivFilename: S.rivFilename }, raw, asset.bytes, { mode: done.mode, targetW: plan.w, targetH: plan.h, masterImage, headReferenceBytes: headAsset?.bytes });
    setTexture(asset, finalBytes);
    return { ok: true, jobId: job.id, ms: Math.round(performance.now() - t0), viewModelPatch: viewModelPatch ?? null };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), ms: Math.round(performance.now() - t0) };
  }
}
/** 当前替换后的贴图（换项目或重来时恢复用）：返回 { 部件: 贴图 base64 } 以便 trace 记录 / 复现 */
function textureSnapshot() {
  return Object.fromEntries(Object.entries(S.modifiedAssets).map(([id, v]) => [id, arrayBufferToBase64(v.newBytes)]));
}
function restoreTextures(snap) {
  for (const [id, b64] of Object.entries(snap || {})) { const cur = S.modifiedAssets[id]; if (cur) S.modifiedAssets[id] = { ...cur, newBytes: b64ToBytes(b64) }; }
}
Object.assign(window.lab, { regenerate, textureSnapshot, restoreTextures });

/** 两套贴图（textureSnapshot）同一组参数各渲染一次：主图 | 候选 1（贴图 A）| 候选 2（贴图 B），同一相对框 */
async function obsTextures(vm, snapA, snapB, box = [0, 0, 1, 1], tile = 400) {
  if (!M) await loadMaster();
  const keep = textureSnapshot();
  restoreTextures(snapA); const a = await framedRender(vm);
  restoreTextures(snapB); const b = await framedRender(vm);
  restoreTextures(keep);
  const [, , sw, sh] = boxPx(box);
  const th = Math.round(tile * Math.min(2, Math.max(0.5, sh / sw))) + 28;
  const c = new OffscreenCanvas(tile * 3, th), g = c.getContext('2d');
  drawTile(g, M.bitmap, box, 0, 0, tile, th, '主图');
  drawTile(g, a, box, tile, 0, tile, th, '候选 1');
  drawTile(g, b, box, tile * 2, 0, tile, th, '候选 2');
  return pngB64(c);
}
Object.assign(window.lab, { obsTextures });

// ════════════ v11：riv 侧虹膜比例由代码量 ════════════
// 画面左侧那只眼：眼白开口宽 = 眼眶贴图原色单独渲染里亮、低饱和像素的横向范围；
// 可见虹膜宽 = 瞳孔纯色单独渲染里落在眼白开口（每列上下沿之间）的像素横向范围
async function irisCode(vm) {
  const W = 720, H = 1280;
  const file = parseRiveFile(S.rivBuffer.slice(0));
  const assets = [...file.assets.values()].filter((a) => a.type === 'ImageAsset');
  const render = async (mk) => {
    const mods = {};
    for (const a of assets) {
      const r = resolveKnownComponentKey(a.name);
      if (!PART_COLORS[r]) continue;
      const cur = S.modifiedAssets[a._mapKey]?.newBytes ?? a.bytes;
      mods[a._mapKey] = { originalBytes: a.bytes, newBytes: await mk(r, cur), originalSize: a.bytes.length };
    }
    const rr = await createOffscreenRenderer(S.rivBuffer, mods, { width: W, height: H });
    try { rr.set({ ...vm, ...OVERLAYS_OFF, Background_image_alpha: 0 }); return new Uint8ClampedArray(await rr.rgba()); } finally { rr.destroy(); }
  };
  const white = await render((r, cur) => (r === 'sclera' ? cur : clearBytes(cur)));
  const pupil = await render((r, cur) => (r === 'pupil' ? tintBytes(cur, PART_COLORS.pupil) : clearBytes(cur)));
  const top = new Int32Array(W).fill(H), bot = new Int32Array(W).fill(-1);
  let sx = 0, n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = (y * W + x) * 4, r = white[k], g = white[k + 1], b = white[k + 2];
    if (white[k + 3] < 128 || Math.min(r, g, b) < 170 || Math.max(r, g, b) - Math.min(r, g, b) > 45) continue;
    if (y < top[x]) top[x] = y; if (y > bot[x]) bot[x] = y; sx += x; n++;
  }
  if (!n) return null;
  const mid = Math.round(sx / n);
  let ex0 = W, ex1 = -1, ix0 = W, ix1 = -1;
  for (let x = 0; x < mid; x++) {
    if (bot[x] < 0) continue;
    if (x < ex0) ex0 = x; if (x > ex1) ex1 = x;
    for (let y = top[x]; y <= bot[x]; y++) if (pupil[(y * W + x) * 4 + 3] >= 128) { if (x < ix0) ix0 = x; if (x > ix1) ix1 = x; break; }
  }
  if (ex1 < ex0 || ix1 < ix0) return null;
  return { eyeW: ex1 - ex0 + 1, irisW: ix1 - ix0 + 1, iris_ratio: (ix1 - ix0 + 1) / (ex1 - ex0 + 1) };
}
window.lab.irisCode = irisCode;
/** 调试：眼眶原色单独渲染 + 瞳孔纯色单独渲染，裁到画面左侧眼睛附近放大 */
async function irisDebug(vm) {
  const W = 720, H = 1280;
  const file = parseRiveFile(S.rivBuffer.slice(0));
  const assets = [...file.assets.values()].filter((a) => a.type === 'ImageAsset');
  const render = async (show) => {
    const mods = {};
    for (const a of assets) {
      const r = resolveKnownComponentKey(a.name);
      if (!PART_COLORS[r]) continue;
      const cur = S.modifiedAssets[a._mapKey]?.newBytes ?? a.bytes;
      mods[a._mapKey] = { originalBytes: a.bytes, newBytes: show.includes(r) ? cur : await clearBytes(cur), originalSize: a.bytes.length };
    }
    const rr = await createOffscreenRenderer(S.rivBuffer, mods, { width: W, height: H });
    try { rr.set({ ...vm, ...OVERLAYS_OFF, Background_image_alpha: 0 }); return new Uint8ClampedArray(await rr.rgba()); } finally { rr.destroy(); }
  };
  const d = await render(['sclera', 'pupil']);
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] >= 128) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const k = 6, cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const c = new OffscreenCanvas(cw * k, ch * k), g = c.getContext('2d');
  g.imageSmoothingEnabled = false; g.fillStyle = '#888'; g.fillRect(0, 0, cw * k, ch * k);
  g.drawImage(await createImageBitmap(new ImageData(d, W, H)), x0, y0, cw, ch, 0, 0, cw * k, ch * k);
  return pngB64(c);
}
window.lab.irisDebug = irisDebug;

// ════════════ 按脸对齐的整图对比（人工判定 / 评审用） ════════════
// 主图原样缩放到 tile 宽；riv 按 rivForPoints 同一渲染（720×1280），缩放 s 倍（脸的尺度对上），平移让两眼中心和主图重合。
// mEye：主图坐标下两眼中心；rEye：riv 渲染坐标下两眼中心；s：主图脸尺度 ÷ riv 脸尺度
async function obsPairAligned(vm, { mEye, rEye: rEye0, s: s0 }, tile = 900) {
  let rEye = rEye0, s = s0;
  if (!M) await loadMaster();
  // riv 按 2 倍分辨率渲染（取景同 720×1280，只是像素更多），坐标和缩放随之换算，放大后不糊
  const Q = 2, W = 720 * Q, H = 1280 * Q;
  const rgba = await withRenderer(W, H, async (r) => { r.set({ ...vm, ...OVERLAYS_OFF, Background_image_alpha: 0 }); return new Uint8ClampedArray(await r.rgba()); });
  const src = await createImageBitmap(new ImageData(rgba, W, H));
  rEye = [rEye[0] * Q, rEye[1] * Q]; s /= Q;
  const t = tile / M.w, th = Math.round(M.h * t) + 28;
  const c = new OffscreenCanvas(tile * 2, th), g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, tile * 2, th);
  g.drawImage(M.bitmap, 0, 28, tile, M.h * t);
  g.save(); g.beginPath(); g.rect(tile, 28, tile, th - 28); g.clip();
  const k = s * t;
  g.drawImage(src, tile + mEye[0] * t - rEye[0] * k, 28 + mEye[1] * t - rEye[1] * k, W * k, H * k);
  g.restore(); src.close();
  g.fillStyle = '#000'; g.font = 'bold 22px sans-serif'; g.fillText('主图', 8, 22); g.fillText('当前 riv（按脸对齐）', tile + 8, 22);
  g.strokeStyle = '#999'; g.strokeRect(0.5, 0.5, tile - 1, th - 1); g.strokeRect(tile + 0.5, 0.5, tile - 1, th - 1);
  return pngB64(c);
}
window.lab.obsPairAligned = obsPairAligned;
window.lab.masterSize = async () => { if (!M) await loadMaster(); return { w: M.w, h: M.h }; };
/** 并排图（左主图 | 右 riv，等宽）→ 叠加图：主图上盖 alpha 的 riv；crop 为左半格内的像素框 [x, y, w, h]，可选，放大到 outW */
window.lab.blendHalves = async (b64, alpha = 0.5, crop = null, outW = 900) => {
  const bm = await createImageBitmap(new Blob([b64ToBytes(b64)], { type: 'image/png' }));
  const half = bm.width / 2;
  const [x, y, w, h] = crop ?? [0, 0, half, bm.height];
  const k = outW / w, c = new OffscreenCanvas(outW, Math.round(h * k)), g = c.getContext('2d');
  g.drawImage(bm, x, y, w, h, 0, 0, outW, h * k);
  g.globalAlpha = alpha; g.drawImage(bm, half + x, y, w, h, 0, 0, outW, h * k);
  return pngB64(c);
};
/** 眼眉区域三联图：主图 / riv / 叠加（竖排，带标签），crop 为并排图左半格内的像素框 */
window.lab.eyeTriptych = async (b64, crop, outW = 900) => {
  const bm = await createImageBitmap(new Blob([b64ToBytes(b64)], { type: 'image/png' }));
  const half = bm.width / 2, [x, y, w, h] = crop, k = outW / w, rh = Math.round(h * k) + 26;
  const c = new OffscreenCanvas(outW, rh * 3), g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, outW, rh * 3);
  [['主图', 0], ['riv', 1], ['叠加 50%', 0.5]].forEach(([label, a], i) => {
    const oy = i * rh + 26;
    if (a < 1) g.drawImage(bm, x, y, w, h, 0, oy, outW, h * k);
    if (a > 0) { g.globalAlpha = a; g.drawImage(bm, half + x, y, w, h, 0, oy, outW, h * k); g.globalAlpha = 1; }
    g.fillStyle = '#000'; g.font = 'bold 20px sans-serif'; g.fillText(label, 6, i * rh + 20);
  });
  return pngB64(c);
};
/** 并排图（左主图 | 右 riv，等宽、已按脸对齐）→ 两边同一像素框各裁一块，左右并排放大，带标签 */
window.lab.cropPair = async (b64, crop, outW = 1000) => {
  const bm = await createImageBitmap(new Blob([b64ToBytes(b64)], { type: 'image/png' }));
  const half = bm.width / 2, [x, y, w, h] = crop, tw = outW / 2, k = tw / w, th = Math.round(h * k) + 26;
  const c = new OffscreenCanvas(outW, th), g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, outW, th);
  g.drawImage(bm, x, y, w, h, 0, 26, tw, h * k);
  g.drawImage(bm, half + x, y, w, h, tw, 26, tw, h * k);
  g.fillStyle = '#000'; g.font = 'bold 20px sans-serif'; g.fillText('主图', 6, 20); g.fillText('riv', tw + 6, 20);
  g.strokeStyle = '#999'; g.beginPath(); g.moveTo(tw, 0); g.lineTo(tw, th); g.stroke();
  return pngB64(c);
};
/** 当前各组件贴图（PNG base64），按组件名：head / sclera / pupil / mouth_up / mouth_down / hair_front / hair_back / body */
window.lab.roleTextures = async () => {
  const file = parseRiveFile(S.rivBuffer.slice(0));
  const out = {};
  for (const a of file.assets.values()) {
    if (a.type !== 'ImageAsset') continue;
    const r = resolveKnownComponentKey(a.name);
    if (!r || out[r]) continue;
    out[r] = { assetId: a._mapKey, png: arrayBufferToBase64(S.modifiedAssets[a._mapKey]?.newBytes ?? a.bytes) };
  }
  return out;
};

// ════════════ v13 第 1 步：眼睛 / 虹膜「粗定位 + 代码找边」 ════════════
// 主图和 riv 用同一套像素规则（同一个函数），只有粗定位来源不同：主图来自 AI 定点，riv 来自眼眶图层质心。
//   眼白：亮（min(r,g,b) ≥ 170）且低饱和（max-min ≤ 45）的像素；只取以粗定位为中心、半径 r 的框内、与中心最近的那块眼白所在的眼。
//   眼白开口宽 = 眼白像素的横向范围；每行「左眼白段 | 中间非眼白 | 右眼白段」的中间段视为虹膜，虹膜宽 = 各行中间段的最大宽度；
//   开口高 = 眼白 ∪ 虹膜段 的纵向范围。
// box：[x0, y0, x1, y1] 搜索框；mask(x, y)：可选，riv 侧「这个像素可见的是眼眶图层」；主图没有掩码，靠搜索框 + 连通块过滤
function eyeFromPixels(d, W, H, box, mask = null) {
  const [x0, y0, x1, y1] = [Math.max(0, Math.round(box[0])), Math.max(0, Math.round(box[1])), Math.min(W - 1, Math.round(box[2])), Math.min(H - 1, Math.round(box[3]))];
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, r = (x1 - x0) / 2;
  // 眼白要和这张脸自己的皮肤比：先取眼睛下方脸颊的肤色，眼白 = 够亮、且明显比皮肤偏冷（r-b 小、b 高）的像素。
  // 固定阈值不行：有的主图眼白偏暖灰（约 205,195,190），有的肤色很浅（约 230,210,195）
  const sk = [[], [], []];
  for (let y = Math.round(cy + r * 0.75); y <= Math.round(cy + r * 1.05) && y < H; y++) for (let x = Math.round(cx - r * 0.3); x <= Math.round(cx + r * 0.3); x++) {
    if (x < 0 || x >= W) continue; const k = (y * W + x) * 4; if (d[k + 3] < 128 || d[k] < 120) continue; sk[0].push(d[k]); sk[1].push(d[k + 1]); sk[2].push(d[k + 2]);
  }
  const mid = (v) => { v.sort((a, b) => a - b); return v.length ? v[v.length >> 1] : NaN; };
  const [sr, , sb] = sk.map(mid), skinRB = sr - sb;
  const white0 = (x, y) => { const k = (y * W + x) * 4; const a = d[k], b = d[k + 1], c = d[k + 2]; return d[k + 3] >= 128 && Math.min(a, b, c) >= 120 && a - c <= Math.min(42, skinRB * 0.5) && c >= sb + 10 && (!mask || mask(x, y)); };
  // 连通块过滤：只留面积够大、且质心落在搜索框中间区域的白块（排除框边上的白发、衣领等）
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, lab = new Int32Array(bw * bh).fill(-1), keep = new Set();
  let comp = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = (y - y0) * bw + (x - x0);
    if (lab[i] >= 0 || !white0(x, y)) continue;
    const q = [i]; lab[i] = comp; let n = 0, sx = 0, sy = 0;
    while (q.length) { const j = q.pop(), jx = j % bw, jy = (j / bw) | 0; n++; sx += jx; sy += jy;
      for (const [ax, ay] of [[jx + 1, jy], [jx - 1, jy], [jx, jy + 1], [jx, jy - 1]]) { if (ax < 0 || ay < 0 || ax >= bw || ay >= bh) continue; const k2 = ay * bw + ax; if (lab[k2] < 0 && white0(x0 + ax, y0 + ay)) { lab[k2] = comp; q.push(k2); } } }
    const mx = sx / n / bw, my = sy / n / bh;
    // 虹膜把眼白分成左右两块，各自质心会靠近框边，只排除贴着框边的块；riv 有图层掩码，不用这一条
    if (n >= bw * bh * 0.01 && (mask || (mx > 0.04 && mx < 0.96 && my > 0.08 && my < 0.92))) keep.add(comp);
    comp++;
  }
  const white = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1 && keep.has(lab[(y - y0) * bw + (x - x0)]);
  // 每行的眼白段（长度 ≥ minSeg，过滤虹膜高光等小白点）
  const rows = [];
  for (let y = y0; y <= y1; y++) {
    const segs = []; let s0 = -1;
    for (let x = x0; x <= x1 + 1; x++) { const w = x <= x1 && white(x, y); if (w && s0 < 0) s0 = x; if (!w && s0 >= 0) { segs.push([s0, x - 1]); s0 = -1; } }
    rows.push({ y, segs });
  }
  const span = Math.max(...rows.flatMap((r0) => r0.segs.map(([a, b]) => b))) - Math.min(...rows.flatMap((r0) => r0.segs.map(([a]) => a)));
  if (!Number.isFinite(span) || span <= 0) return null;
  const minSeg = Math.max(2, Math.round(span * 0.05));
  let wx0 = W, wx1 = -1, top = H, bot = -1, irisW = 0, irisRow = -1;
  for (const { y, segs } of rows) {
    const big = segs.filter(([a, b]) => b - a + 1 >= minSeg);
    if (!big.length) continue;
    wx0 = Math.min(wx0, big[0][0]); wx1 = Math.max(wx1, big[big.length - 1][1]); top = Math.min(top, y); bot = Math.max(bot, y);
    // 相邻两段大眼白之间的最长间隔 = 这一行的虹膜
    for (let i = 1; i < big.length; i++) { const gap = big[i][0] - big[i - 1][1] - 1; if (gap > irisW) { irisW = gap; irisRow = y; } }
  }
  if (wx1 < 0) return null;
  return { eyeW: wx1 - wx0 + 1, eyeH: bot - top + 1, irisW, box: [wx0, top, wx1, bot], irisRow, skin: [sr, sb] };
}
async function imageData(src, W, H) { const c = new OffscreenCanvas(W, H), g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.drawImage(src, 0, 0, W, H); return g.getImageData(0, 0, W, H).data; }
/** 主图：粗定位 (cx, cy) 为主图原尺寸坐标，r 为搜索半径（像素） */
/** 主图：box 为 AI 定点给的眼白开口框（主图原尺寸坐标），横向外扩 25%、纵向外扩 90% 作搜索框（AI 标的上下眼睑常偏向中间） */
window.lab.eyeMaster = async (box) => {
  if (!M) await loadMaster();
  const d = await imageData(M.bitmap, M.w, M.h), [bx0, by0, bx1, by1] = box, w = bx1 - bx0, h = by1 - by0;
  return { ...eyeFromPixels(d, M.w, M.h, [bx0 - w * 0.25, by0 - h * 0.9, bx1 + w * 0.25, by1 + h * 0.9]), W: M.w, H: M.h };
};
/** riv：按 Q 倍分辨率整幅渲染（取景同 rivForPoints 的 720×1280），粗定位取眼眶图层在画面左半的质心 */
window.lab.eyeRiv = async (vm, Q = 2) => {
  const W = 720 * Q, H = 1280 * Q;
  const rgba = await withRenderer(W, H, async (r) => { r.set({ ...vm, ...OVERLAYS_OFF, Background_image_alpha: 0 }); return new Uint8ClampedArray(await r.rgba()); });
  const c = new OffscreenCanvas(W, H), g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.drawImage(await createImageBitmap(new ImageData(rgba, W, H)), 0, 0);
  const d = g.getImageData(0, 0, W, H).data;
  const file = parseRiveFile(S.rivBuffer.slice(0));
  const assets = [...file.assets.values()].filter((a) => a.type === 'ImageAsset');
  const mods = {};
  for (const a of assets) { const r = resolveKnownComponentKey(a.name); if (!PART_COLORS[r]) continue; const cur = S.modifiedAssets[a._mapKey]?.newBytes ?? a.bytes; mods[a._mapKey] = { originalBytes: a.bytes, newBytes: ['sclera', 'pupil', 'hair_front'].includes(r) ? await tintBytes(cur, PART_COLORS[r]) : await clearBytes(cur), originalSize: a.bytes.length }; }
  const rr = await createOffscreenRenderer(S.rivBuffer, mods, { width: W, height: H });
  let own; try { rr.set({ ...vm, ...OVERLAYS_OFF, Background_image_alpha: 0 }); own = new Uint8ClampedArray(await rr.rgba()); } finally { rr.destroy(); }
  const C = PART_COLORS.sclera, isSc = (x, y) => { const k = (y * W + x) * 4; return own[k + 3] >= 128 && Math.abs(own[k] - C[0]) + Math.abs(own[k + 1] - C[1]) + Math.abs(own[k + 2] - C[2]) <= 60; };
  const CP = PART_COLORS.pupil, isPu = (x, y) => { const k = (y * W + x) * 4; return own[k + 3] >= 128 && Math.abs(own[k] - CP[0]) + Math.abs(own[k + 1] - CP[1]) + Math.abs(own[k + 2] - CP[2]) <= 60; };
  // 画面左半那只眼的眼眶范围作搜索框
  let all = 0, allN = 0;
  for (let i = 0; i < W * H; i++) if (isSc(i % W, (i / W) | 0)) { all += i % W; allN++; }
  const mid = all / allN; let x0 = W, x1 = 0, y0 = H, y1 = 0;
  for (let i = 0; i < W * H; i++) { const x = i % W, y = (i / W) | 0; if (x < mid && isSc(x, y)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
  const gap = eyeFromPixels(d, W, H, [x0, y0, x1, y1], isSc);
  // 2026-11-02：riv 的瞳孔是单独图层，直接数「可见的瞳孔像素」，不再靠「虹膜两侧都有眼白」去推——
  // 虹膜贴着一侧眼角（另一侧只露粉色眼角）时，推法量不出虹膜，会误判成「虹膜盖满眼白」（耳麦女孩 v15/v15p）。
  // 虹膜宽 = 可见瞳孔的横向范围（瞳孔是单独图层，直接数）
  let px0 = W, px1 = -1;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (isPu(x, y)) { if (x < px0) px0 = x; if (x > px1) px1 = x; }
  // 开口（按颜色，正式用）：眼眶图层上的浅色冷色像素 ∪ 可见瞳孔——会把画在眼眶贴图上的浅色眼睑皮肤算进来（耳麦女孩 v15p 量宽）
  let cx0 = W, cx1 = -1;
  const sk = gap?.skin;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const k = (y * W + x) * 4;
    const wh = isSc(x, y) && Math.min(d[k], d[k + 1], d[k + 2]) >= 120 && (!sk || (d[k] - d[k + 2] <= Math.min(42, (sk[0] - sk[1]) * 0.5) && d[k + 2] >= sk[1] + 10));
    if (isPu(x, y) || wh) { if (x < cx0) cx0 = x; if (x > cx1) cx1 = x; }
  }
  // 开口（按遮罩，只作兜底上限）：虹膜临时放到最大铺满眼眶遮罩，可见瞳孔的范围 = 遮罩露出的开口，不靠颜色判断
  // （从瞳孔往外扩的做法试过：虹膜外圈阴影会截断、眼线有缺口会漏出去，不可靠）
  const rr2 = await createOffscreenRenderer(S.rivBuffer, mods, { width: W, height: H });
  let own2; try { rr2.set({ ...vm, Eye_iris_scale: 200, ...OVERLAYS_OFF, Background_image_alpha: 0 }); own2 = new Uint8ClampedArray(await rr2.rgba()); } finally { rr2.destroy(); }
  let ox0 = W, ox1 = -1, oy0 = H, oy1 = -1;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const k = (y * W + x) * 4;
    if (own2[k + 3] >= 128 && Math.abs(own2[k] - CP[0]) + Math.abs(own2[k + 1] - CP[1]) + Math.abs(own2[k + 2] - CP[2]) <= 60) { if (x < ox0) ox0 = x; if (x > ox1) ox1 = x; if (y < oy0) oy0 = y; if (y > oy1) oy1 = y; }
  }
  if (ox1 < 0) return { ...gap, W, H, Q };
  // 开口宽：按颜色（和主图同一口径；人工对照 0.88），只在按颜色明显过宽（> 遮罩 × 1.2，眼睑皮肤被当成眼白）时用遮罩 × 1.2 兜住。
  // 只用遮罩不行：主图没有遮罩、只能按颜色量，两边口径不同（人工对照 0.25）
  const maskW = ox1 - ox0 + 1, colorW = cx1 >= 0 ? cx1 - cx0 + 1 : maskW;
  return { eyeW: Math.min(colorW, Math.round(maskW * 1.2)), eyeH: oy1 - oy0 + 1, irisW: px1 >= 0 ? px1 - px0 + 1 : 0, colorEyeW: colorW, maskEyeW: maskW, box: [ox0, oy0, ox1, oy1], W, H, Q };
};

/** 调试：主图或 riv（vm 非空）上眼睛测量结果的放大图（绿框 = 眼白开口，红线 = 虹膜宽所在行） */
window.lab.eyeDebug = async (res, vm = null, Q = 2) => {
  let src, W, H;
  if (vm) { W = 720 * Q; H = 1280 * Q; const rgba = await withRenderer(W, H, async (r) => { r.set({ ...vm, ...OVERLAYS_OFF, Background_image_alpha: 0 }); return new Uint8ClampedArray(await r.rgba()); }); src = await createImageBitmap(new ImageData(rgba, W, H)); }
  else { if (!M) await loadMaster(); src = M.bitmap; W = M.w; H = M.h; }
  const [bx0, by0, bx1, by1] = res.box, pad = (bx1 - bx0) * 0.4, x = bx0 - pad, y = by0 - pad, w = bx1 - bx0 + pad * 2, h = by1 - by0 + pad * 2, k = 400 / w;
  const c = new OffscreenCanvas(400, Math.round(h * k)), g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(src, x, y, w, h, 0, 0, 400, h * k);
  g.strokeStyle = '#0c0'; g.lineWidth = 2; g.strokeRect((bx0 - x) * k, (by0 - y) * k, (bx1 - bx0) * k, (by1 - by0) * k);
  g.strokeStyle = '#f00'; g.beginPath(); g.moveTo(0, (res.irisRow - y) * k); g.lineTo(400, (res.irisRow - y) * k); g.stroke();
  return pngB64(c);
};
/** 调试：主图某一行（y）在 [x0, x1] 的像素颜色 */
window.lab.masterRow = async (y, x0, x1, step = 2) => { if (!M) await loadMaster(); const d = await imageData(M.bitmap, M.w, M.h); const out = []; for (let x = Math.round(x0); x <= x1; x += step) { const k = (Math.round(y) * M.w + x) * 4; out.push([x, d[k], d[k + 1], d[k + 2]]); } return out; };

// ════════════ 前发「盖住多少脸」：在给定高度从中线往两边扫，连续皮肤的宽度 ════════════
// 肤色取鼻子附近（中线、鼻底上方）；皮肤 = 和肤色差距小的像素。主图、riv 用同一函数
function skinSpans(d, W, H, cx, ys, skinAt) {
  const k0 = (Math.round(skinAt[1]) * W + Math.round(skinAt[0])) * 4, sr = d[k0], sg = d[k0 + 1], sb = d[k0 + 2];
  const isSkin = (x, y) => { const k = (y * W + x) * 4; return d[k + 3] >= 128 && Math.abs(d[k] - sr) + Math.abs(d[k + 1] - sg) + Math.abs(d[k + 2] - sb) <= 70; };
  return ys.map((y0) => {
    const y = Math.round(y0); let l = Math.round(cx), r = Math.round(cx), miss = 0;
    // 允许中间有少量非皮肤（眉毛、眼睛、阴影）：连续 6% 宽以上的非皮肤才算到边
    const gapMax = Math.max(3, Math.round(W * 0.012));
    for (let x = Math.round(cx); x >= 0; x--) { if (isSkin(x, y)) { l = x; miss = 0; } else if (++miss > gapMax) break; }
    miss = 0;
    for (let x = Math.round(cx); x < W; x++) { if (isSkin(x, y)) { r = x; miss = 0; } else if (++miss > gapMax) break; }
    return r - l + 1;
  });
}
window.lab.skinMaster = async (cx, ys, skinAt) => { if (!M) await loadMaster(); const d = await imageData(M.bitmap, M.w, M.h); return skinSpans(d, M.w, M.h, cx, ys, skinAt); };
window.lab.skinRiv = async (vm, cx, ys, skinAt, Q = 2) => {
  const W = 720 * Q, H = 1280 * Q;
  const rgba = await withRenderer(W, H, async (r) => { r.set({ ...vm, ...OVERLAYS_OFF, Background_image_alpha: 0 }); return new Uint8ClampedArray(await r.rgba()); });
  const c = new OffscreenCanvas(W, H), g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.drawImage(await createImageBitmap(new ImageData(rgba, W, H)), 0, 0);
  return skinSpans(g.getImageData(0, 0, W, H).data, W, H, cx * Q, ys.map((y) => y * Q), [skinAt[0] * Q, skinAt[1] * Q]);
};
/** 贴图缩略图：裁到不透明区域，缩到 size 以内，白底 */
window.lab.thumb = async (b64, size = 220) => {
  const bm = await createImageBitmap(new Blob([b64ToBytes(b64)], { type: 'image/png' }));
  const c0 = new OffscreenCanvas(bm.width, bm.height), g0 = c0.getContext('2d'); g0.drawImage(bm, 0, 0);
  const d = g0.getImageData(0, 0, bm.width, bm.height).data;
  let x0 = bm.width, y0 = bm.height, x1 = -1, y1 = -1;
  for (let y = 0; y < bm.height; y++) for (let x = 0; x < bm.width; x++) if (d[(y * bm.width + x) * 4 + 3] > 16) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) { x0 = 0; y0 = 0; x1 = bm.width - 1; y1 = bm.height - 1; }
  const w = x1 - x0 + 1, h = y1 - y0 + 1, k = Math.min(size / w, size / h);
  const c = new OffscreenCanvas(Math.round(w * k), Math.round(h * k)), g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bm, x0, y0, w, h, 0, 0, c.width, c.height);
  return pngB64(c);
};

// ════════════ v15 穿帮：部件碎块 ════════════
// 每个组件两种渲染：① 只渲染它自己（看贴图本身有没有分离的小块）；② 全部组件按原层级纯色叠（看最终画面上它可见的部分有没有被切成小碎块）
// 返回每个组件：主体面积、各小块（面积、外框、离主体距离）
function blobs(mask, W, H) {
  const lab = new Int32Array(W * H).fill(-1), out = [];
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || lab[i] >= 0) continue;
    const id = out.length, q = [i]; lab[i] = id; let n = 0, x0 = W, y0 = H, x1 = 0, y1 = 0;
    while (q.length) { const j = q.pop(), x = j % W, y = (j / W) | 0; n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const k of [j - 1, j + 1, j - W, j + W]) if (k >= 0 && k < W * H && mask[k] && lab[k] < 0 && Math.abs((k % W) - x) <= 1) { lab[k] = id; q.push(k); } }
    out.push({ n, box: [x0, y0, x1, y1] });
  }
  return out.sort((a, b) => b.n - a.n);
}
window.lab.partIslands = async (vm, W = 720, H = 1280) => {
  const file = parseRiveFile(S.rivBuffer.slice(0));
  const assets = [...file.assets.values()].filter((a) => a.type === 'ImageAsset');
  const roles = [...new Set(assets.map((a) => resolveKnownComponentKey(a.name)).filter((r) => PART_COLORS[r]))];
  const render = async (show) => {
    const mods = {};
    for (const a of assets) { const r = resolveKnownComponentKey(a.name); if (!PART_COLORS[r]) continue; const cur = S.modifiedAssets[a._mapKey]?.newBytes ?? a.bytes; mods[a._mapKey] = { originalBytes: a.bytes, newBytes: show.includes(r) ? await tintBytes(cur, PART_COLORS[r]) : await clearBytes(cur), originalSize: a.bytes.length }; }
    const rr = await createOffscreenRenderer(S.rivBuffer, mods, { width: W, height: H });
    try { rr.set({ ...vm, ...OVERLAYS_OFF, Background_image_alpha: 0 }); return new Uint8ClampedArray(await rr.rgba()); } finally { rr.destroy(); }
  };
  const near = (d, k, c) => d[k + 3] >= 128 && Math.abs(d[k] - c[0]) + Math.abs(d[k + 1] - c[1]) + Math.abs(d[k + 2] - c[2]) <= 60;
  const all = await render(roles), res = {};
  for (const r of roles) {
    const solo = await render([r]);
    const mSolo = new Uint8Array(W * H), mVis = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) { if (solo[i * 4 + 3] >= 128) mSolo[i] = 1; if (near(all, i * 4, PART_COLORS[r])) mVis[i] = 1; }
    const fmt = (bs) => { const main = bs[0]; if (!main) return null; return { main: main.n, small: bs.slice(1).filter((b) => b.n >= 4).slice(0, 8).map((b) => ({ n: b.n, box: b.box, dist: Math.max(0, main.box[0] - b.box[2], b.box[0] - main.box[2], main.box[1] - b.box[3], b.box[1] - main.box[3]) })) }; };
    res[r] = { solo: fmt(blobs(mSolo, W, H)), visible: fmt(blobs(mVis, W, H)) };
  }
  return res;
};
/** 调试：riv 某区域放大图（720×1280 坐标系的框），可选只显示某些组件（纯色） */
window.lab.rivCrop = async (vm, box, scale = 4, tintRoles = null) => {
  const W = 720, H = 1280;
  let rgba;
  if (tintRoles) {
    const file = parseRiveFile(S.rivBuffer.slice(0)); const mods = {};
    for (const a of [...file.assets.values()].filter((x) => x.type === 'ImageAsset')) { const r = resolveKnownComponentKey(a.name); if (!PART_COLORS[r]) continue; const cur = S.modifiedAssets[a._mapKey]?.newBytes ?? a.bytes; mods[a._mapKey] = { originalBytes: a.bytes, newBytes: tintRoles.includes(r) ? await tintBytes(cur, PART_COLORS[r]) : cur, originalSize: a.bytes.length }; }
    const rr = await createOffscreenRenderer(S.rivBuffer, mods, { width: W, height: H });
    try { rr.set({ ...vm, ...OVERLAYS_OFF, Background_image_alpha: 0 }); rgba = new Uint8ClampedArray(await rr.rgba()); } finally { rr.destroy(); }
  } else rgba = await withRenderer(W, H, async (r) => { r.set({ ...vm, ...OVERLAYS_OFF, Background_image_alpha: 0 }); return new Uint8ClampedArray(await r.rgba()); });
  const src = await createImageBitmap(new ImageData(rgba, W, H)); const [x, y, w, h] = box;
  const c = new OffscreenCanvas(w * scale, h * scale), g = c.getContext('2d'); g.imageSmoothingEnabled = false; g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(src, x, y, w, h, 0, 0, w * scale, h * scale); return pngB64(c);
};
/** v15 穿帮：上层组件破洞里露出下层的小块。
 *  可见归属图里，某组件的小连通块（面积小）周边像素大多属于同一个「画在它上面」的组件 → 记为破洞。
 *  眼睛、嘴等画在脸上面，被下层包着，不会被记。层级由两组件单独渲染重叠处在全图里显示谁的颜色判断。 */
window.lab.partHoles = async (vm, W = 720, H = 1280, maxN = 400) => {
  const file = parseRiveFile(S.rivBuffer.slice(0));
  const assets = [...file.assets.values()].filter((a) => a.type === 'ImageAsset');
  const roles = [...new Set(assets.map((a) => resolveKnownComponentKey(a.name)).filter((r) => PART_COLORS[r]))];
  const render = async (show) => {
    const mods = {};
    for (const a of assets) { const r = resolveKnownComponentKey(a.name); if (!PART_COLORS[r]) continue; const cur = S.modifiedAssets[a._mapKey]?.newBytes ?? a.bytes; mods[a._mapKey] = { originalBytes: a.bytes, newBytes: show.includes(r) ? await tintBytes(cur, PART_COLORS[r]) : await clearBytes(cur), originalSize: a.bytes.length }; }
    const rr = await createOffscreenRenderer(S.rivBuffer, mods, { width: W, height: H });
    try { rr.set({ ...vm, ...OVERLAYS_OFF, Background_image_alpha: 0 }); return new Uint8ClampedArray(await rr.rgba()); } finally { rr.destroy(); }
  };
  const all = await render(roles);
  const owner = new Int8Array(W * H).fill(-1);
  for (let i = 0; i < W * H; i++) { if (all[i * 4 + 3] < 128) continue; let best = -1, bd = 61; roles.forEach((r, j) => { const c = PART_COLORS[r], d = Math.abs(all[i * 4] - c[0]) + Math.abs(all[i * 4 + 1] - c[1]) + Math.abs(all[i * 4 + 2] - c[2]); if (d < bd) { bd = d; best = j; } }); owner[i] = best; }
  const solo = {}; for (const r of roles) { const d = await render([r]); const m = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) m[i] = d[i * 4 + 3] >= 128 ? 1 : 0; solo[r] = m; }
  // above[a][b]：a、b 重叠处全图显示 a 的比例
  const above = (a, b) => { let n = 0, wa = 0; const ia = roles.indexOf(a); for (let i = 0; i < W * H; i++) if (solo[a][i] && solo[b][i]) { n++; if (owner[i] === ia) wa++; } return n >= 20 ? wa / n : null; };
  const holes = [];
  roles.forEach((r, j) => {
    const mask = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) mask[i] = owner[i] === j ? 1 : 0;
    const lab = new Int32Array(W * H).fill(-1); let id = 0;
    for (let s = 0; s < W * H; s++) {
      if (!mask[s] || lab[s] >= 0) continue;
      const q = [s], px = []; lab[s] = id;
      while (q.length) { const p = q.pop(); px.push(p); const x = p % W; for (const k of [p - 1, p + 1, p - W, p + W]) if (k >= 0 && k < W * H && Math.abs((k % W) - x) <= 1 && mask[k] && lab[k] < 0) { lab[k] = id; q.push(k); } }
      id++;
      if (px.length < 2 || px.length > maxN) continue;
      // 周边一圈像素的归属
      const cnt = {}; let tot = 0;
      for (const p of px) { const x = p % W; for (const k of [p - 1, p + 1, p - W, p + W]) { if (k < 0 || k >= W * H || Math.abs((k % W) - x) > 1 || lab[k] === lab[p]) continue; tot++; const o = owner[k]; cnt[o] = (cnt[o] || 0) + 1; } }
      const [o, c] = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0] ?? [];
      if (!tot || Number(o) < 0 || c / tot < 0.8) continue;
      const enc = roles[Number(o)], ab = above(enc, r);
      if (ab != null && ab > 0.5) { const xs = px.map((p) => p % W), ys = px.map((p) => (p / W) | 0); holes.push({ part: r, through: enc, n: px.length, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] }); }
    }
  });
  return holes;
};


// ════════════ 完整流程：主图 + 模板 → 按 Studio 的方式生成各组件候选 ════════════
// 和 Studio 批量生成（StudioCore 批量 effect）同一套函数：AI 组件先抽取外观描述再 enqueueOnePlanJob；
// 前后发走 generateHairPipeline，上下唇走 generateMouthPipeline。新项目的原图 / 对齐基准都是模板自带贴图。
import { extractComponentDescriptionForPlan } from '@client/studio/editcomponents/useComponentEditGenerate';
import { getComponentExtractKeywords } from '@client/constants/componentPromptMapping';
import { templateHasComponent } from '@client/constants/componentTemplates';
import { enqueueOnePlanJob } from '@client/hooks/useAutoGenerate';

/** 新项目：只有模板和主图（主图是同源路径，如 /e2e/<名字>/master.png），贴图全是模板原样 */
async function newProjectFromMaster({ id, rivFilename, masterPath }) {
  const rivBuffer = await (await rawFetch(`/riv/${encodeURIComponent(rivFilename)}`)).arrayBuffer();
  const file = parseRiveFile(rivBuffer.slice(0));
  const assets = [...file.assets.values()].filter((a) => a.type === 'ImageAsset');
  const plans = buildKnownPlansFromAssets(assets).filter((p) => templateHasComponent(rivFilename, p.key));
  M = null; FRAME = null;
  S = { projectId: id, rivFilename, rivBuffer, modifiedAssets: {}, masterUrl: masterPath, savedVm: {}, plans, has: new Set() };
  return { plans: plans.map((p) => ({ key: p.key, assetId: String(p.assetId), w: p.w, h: p.h })) };
}
/** 按组件组（head / sclera / pupil / body / … / hair / mouth）生成一次，返回 { ok, textures: {资源 id: base64}, viewModelPatch, calls }。
 *  不改当前 S.modifiedAssets（候选各自独立）。描述抽取结果按组件缓存，同一项目多次生成复用（Studio 一次批量也只抽一次） */
const DESC_CACHE = {};
async function genGroup(group) {
  const masterImage = await readBytes(S.masterUrl);
  const file = parseRiveFile(S.rivBuffer.slice(0));
  const byKey = Object.fromEntries(S.plans.map((p) => [p.key, p]));
  const orig = (assetId) => file.assets.get(Number(assetId))?.bytes ?? file.assets.get(assetId)?.bytes ?? null;
  const tex = (assetId, bytes) => [String(assetId), arrayBufferToBase64(bytes)];
  try {
    if (group === 'hair') {
      const back = byKey.hair_back, front = byKey.hair_front, head = byKey.head;
      const r = await generateHairPipeline(masterImage, orig(head.assetId), S.projectId, { headAssetId: (back || front).assetId, masterImageUrl: '', backCanvas: back ? { width: back.w, height: back.h } : null });
      const out = [];
      if (back) out.push(tex(back.assetId, await padHairBack(r.hairBackBytes, orig(back.assetId))));
      if (front) out.push(tex(front.assetId, r.hairFrontBytes));
      return { ok: true, textures: Object.fromEntries(out), viewModelPatch: null, calls: 2 };
    }
    if (group === 'mouth') {
      const up = byKey.mouth_up, down = byKey.mouth_down;
      const r = await generateMouthPipeline(masterImage, orig(up.assetId), orig(down.assetId), S.projectId, { masterImageUrl: '' });
      return { ok: true, textures: Object.fromEntries([tex(up.assetId, r.mouthUpBytes), tex(down.assetId, r.mouthDownBytes)]), viewModelPatch: null, calls: 3 };
    }
    const plan = byKey[group];
    if (!plan) return { ok: false, error: `模板里没有 ${group}` };
    let eff = plan, calls = 1;
    if (!plan.useMainImage && getComponentExtractKeywords(plan.key).length > 0) {
      if (!DESC_CACHE[`${S.projectId}/${plan.key}`]) {
        DESC_CACHE[`${S.projectId}/${plan.key}`] = await extractComponentDescriptionForPlan({ plan, projectId: S.projectId, masterImage, mainImageUrl: '', ensureMasterImage: async () => masterImage, useMainImage: plan.useMainImage });
        calls++;
      }
      const x = DESC_CACHE[`${S.projectId}/${plan.key}`];
      eff = { ...plan, componentDescStructured: x.componentDescStructured, prompt: x.prompt, useMainImage: x.useMainImage };
    }
    const headPlan = byKey.head;
    const genResult = await new Promise((resolve, reject) => {
      enqueueOnePlanJob({ ...eff, rivFilename: S.rivFilename }, (id) => orig(id), masterImage, '', {
        projectId: S.projectId, headBytes: headPlan ? orig(headPlan.assetId) : null, headReferenceBytes: headPlan ? orig(headPlan.assetId) : null,
        getReferenceBytes: (id) => orig(id), onResult: (r) => resolve(r), onError: (e) => reject(e),
      }).catch(reject);
    });
    return { ok: true, textures: Object.fromEntries([tex(plan.assetId, genResult.finalBytes)]), viewModelPatch: genResult.viewModelPatch ?? null, calls };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
/** 组件组：模板里有的组件，前后发合为 hair、上下唇合为 mouth */
function genGroups() {
  const keys = S.plans.map((p) => p.key), out = [];
  for (const k of keys) {
    if (k === 'hair_back' || k === 'hair_front') { if (!out.includes('hair')) out.push('hair'); continue; }
    if (k === 'mouth_up' || k === 'mouth_down') { if (!out.includes('mouth') && keys.includes('mouth_up') && keys.includes('mouth_down')) out.push('mouth'); continue; }
    out.push(k);
  }
  return out;
}
Object.assign(window.lab, { newProjectFromMaster, genGroup, genGroups: async () => genGroups() });
/** 调试：在主图上画多组定点（每组一种颜色），裁到 box（定点图坐标系，masterForPoints 的尺寸） */
window.lab.drawMasterPoints = async (sets, box, scale = 2) => {
  if (!M) await loadMaster();
  const k0 = Math.min(1, 1280 / M.h), W = Math.round(M.w * k0), H = Math.round(M.h * k0);
  const [x, y, w, h] = box, c = new OffscreenCanvas(w * scale, h * scale), g = c.getContext('2d');
  g.drawImage(M.bitmap, x / k0, y / k0, w / k0, h / k0, 0, 0, w * scale, h * scale);
  const colors = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#00bcd4'];
  sets.forEach((pts, i) => { g.fillStyle = colors[i % colors.length]; for (const p of Object.values(pts || {})) { if (!Array.isArray(p)) continue; g.beginPath(); g.arc((p[0] - x) * scale, (p[1] - y) * scale, 3, 0, 7); g.fill(); } });
  return pngB64(c);
};

// ════════════ v17 挑选验证：主图裁剪 + 候选贴图并排给 AI 看 ════════════
/** 主图按相对框裁一块 + 各候选贴图（裁到不透明区域）排成一行，带标签：主图 | 候选 1 | 候选 2 | … */
window.lab.choiceImage = async (box, textures, tile = 420) => {
  if (!M) await loadMaster();
  const n = textures.length + 1, c = new OffscreenCanvas(tile * n, tile + 30), g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  const fit = (src, sx, sy, sw, sh, i) => { const k = Math.min((tile - 16) / sw, (tile - 16) / sh), w = sw * k, h = sh * k; g.drawImage(src, sx, sy, sw, sh, i * tile + (tile - w) / 2, 30 + (tile - h) / 2, w, h); };
  const [bx, by, bw, bh] = [box[0] * M.w, box[1] * M.h, box[2] * M.w, box[3] * M.h];
  fit(M.bitmap, bx, by, bw, bh, 0);
  for (let i = 0; i < textures.length; i++) {
    const bm = await createImageBitmap(new Blob([b64ToBytes(textures[i])], { type: 'image/png' }));
    const c0 = new OffscreenCanvas(bm.width, bm.height), g0 = c0.getContext('2d'); g0.drawImage(bm, 0, 0);
    const d = g0.getImageData(0, 0, bm.width, bm.height).data;
    let x0 = bm.width, y0 = bm.height, x1 = -1, y1 = -1;
    for (let y = 0; y < bm.height; y++) for (let x = 0; x < bm.width; x++) if (d[(y * bm.width + x) * 4 + 3] > 16) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 >= 0) fit(bm, x0, y0, x1 - x0 + 1, y1 - y0 + 1, i + 1);
  }
  g.fillStyle = '#000'; g.font = 'bold 22px sans-serif'; g.fillText('主图', 8, 23);
  textures.forEach((_, i) => g.fillText(`候选 ${i + 1}`, (i + 1) * tile + 8, 23));
  g.strokeStyle = '#999'; for (let i = 0; i < n; i++) g.strokeRect(i * tile + 0.5, 0.5, tile - 1, c.height - 1);
  return pngB64(c);
};

// ════════════ v17 离线验证：模板默认贴图 ════════════
/** 当前项目 riv 模板里各图片资源的默认贴图（生成之前的样子）：{ assetId: base64 } */
window.lab.templateTextures = () => {
  const file = parseRiveFile(S.rivBuffer.slice(0)), out = {};
  for (const [id, a] of file.assets) if (a?.bytes) out[String(id)] = arrayBufferToBase64(a.bytes);
  return out;
};
/** v17 AI 挑选拼图：第一格主图裁剪（相对框），后面每格一张候选（layers：要叠在一起显示的若干贴图，如上下唇），标签 A/B/C…
 *  opts.aspect：候选统一拉伸到的宽高比（眼眶、嘴用），不给则保持原比例；背景按候选平均亮度选中灰 / 深灰 / 浅灰 */
window.lab.choiceImage2 = async (box, cands, opts = {}) => {
  if (!M) await loadMaster();
  // opts.ref：参考贴图（如后发挑选时的已选前发），放在主图后面，不是候选、不编字母
  if (opts.ref) cands = [opts.ref, ...cands];
  const tile = opts.tile ?? 420, n = cands.length + 1, c = new OffscreenCanvas(tile * n, tile + 34), g = c.getContext('2d');
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  const [bx, by, bw, bh] = [box[0] * M.w, box[1] * M.h, box[2] * M.w, box[3] * M.h];
  // 候选：各层叠到同一画布后按 alpha≥128 外框裁剪
  const layered = [];
  let lumSum = 0, lumN = 0;
  for (const layers of cands) {
    const bms = await Promise.all(layers.map((b64) => createImageBitmap(new Blob([b64ToBytes(b64)], { type: 'image/png' }))));
    const W = Math.max(...bms.map((b) => b.width)), H = Math.max(...bms.map((b) => b.height));
    const c0 = new OffscreenCanvas(W, H), g0 = c0.getContext('2d'); bms.forEach((b) => g0.drawImage(b, 0, 0));
    const d = g0.getImageData(0, 0, W, H).data; let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = (y * W + x) * 4; if (d[k + 3] >= 128) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; lumSum += 0.3 * d[k] + 0.59 * d[k + 1] + 0.11 * d[k + 2]; lumN++; } }
    layered.push({ c0, x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  const lum = lumSum / Math.max(1, lumN), bg = Math.abs(lum - 128) > 50 ? '#808080' : lum > 128 ? '#404040' : '#c8c8c8';
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  const fit = (src, sx, sy, sw, sh, i, aspect) => {
    const tw = aspect ? sh * aspect : sw, k = Math.min((tile - 16) / tw, (tile - 16) / sh), w = tw * k, h = sh * k;
    g.drawImage(src, sx, sy, sw, sh, i * tile + (tile - w) / 2, 34 + (tile - h) / 2, w, h);
  };
  fit(M.bitmap, bx, by, bw, bh, 0);
  layered.forEach((L, i) => { g.fillStyle = bg; g.fillRect((i + 1) * tile + 1, 34, tile - 2, tile - 1); fit(L.c0, L.x0, L.y0, L.w, L.h, i + 1, opts.aspect); });
  g.fillStyle = '#000'; g.font = 'bold 24px sans-serif'; g.fillText('主图', 8, 26);
  cands.forEach((_, i) => g.fillText(opts.ref ? (i ? String.fromCharCode(64 + i) : '参考（已选前发，不是候选）') : String.fromCharCode(65 + i), (i + 1) * tile + 8, 26));
  g.strokeStyle = '#999'; for (let i = 0; i < n; i++) g.strokeRect(i * tile + 0.5, 0.5, tile - 1, c.height - 1);
  return pngB64(c);
};
/** 贴图铺到白底上（给 AI 标点用），返回 { png, W, H } */
window.lab.onWhite = async (b64) => {
  const bm = await createImageBitmap(new Blob([b64ToBytes(b64)], { type: 'image/png' }));
  const c = new OffscreenCanvas(bm.width, bm.height), g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bm, 0, 0);
  return { png: await pngB64(c), W: bm.width, H: bm.height };
};
