// v21 标点协议（点目录 + 提示词 + 三步流程）。主图和 riv 用逐字相同的定义；只标看得见的，看不见给 null。
// 第 1 步全图基础点 → 代码定行 → 第 2 步把行画在图上、标每行脸 / 头发左右外沿并说明「落在什么上」→ 第 3 步放大标两只眼、嘴。
// 坐标一律换回「标点基础坐标」：主图 = masterForPoints 图（等比缩到高 1280），riv = rivForPoints 图（720×1280）。
import { LLM_URL, LLM_KEY, maxTok, postJson } from '../gateway.mjs';
import { logUsage } from '../usage.mjs';

export const PROTOCOL_VERSION = 'v21-points-2';  // 2：第 1 步加配饰有没有
export const MODEL = 'gpt-6.1-sol';

// ── 点目录 ──
export const BASE_POINTS = {
  eye_l: '画面左侧眼睛眼白开口的中心', eye_r: '画面右侧眼睛眼白开口的中心',
  nose: '鼻底（鼻尖下沿）', mouth_l: '嘴的左嘴角', mouth_r: '嘴的右嘴角', chin: '下巴最低点',
  head_top: '头发最高点', brow_l: '画面左侧眉毛的中点（被头发挡住给 null）', brow_r: '画面右侧眉毛的中点（被头发挡住给 null）',
  bang_center: '刘海在脸正中处的下沿（没有刘海给 null）',
  shoulder_l: '左肩最外侧的上沿（肩膀和手臂交界）', shoulder_r: '右肩最外侧的上沿',
  head_l: '头部（脸加头发，不含耳机、发饰、帽子等配饰）在画面左右方向最宽那一处的最左端', head_r: '同一处的最右端',
};
// 第 1 步顺带回答有没有（开关只检测、写报告；耳机不是模板组件，记作遮挡物来源）
export const ACCESSORIES = { glasses: '眼镜', hat: '帽子', hair_ornament: '发饰（发卡、蝴蝶结、头花等）', beard: '胡须', brooch: '胸针', headphones: '耳机 / 头戴设备' };
export const ROW_EDGES = {
  face_l: '这条线上，看得见的脸部皮肤在画面左侧的外沿（不含耳朵）', face_r: '这条线上，看得见的脸部皮肤在画面右侧的外沿（不含耳朵）',
  hair_l: '这条线上，整团头发（前发、后发、鬓发都算）在画面左侧的最外沿', hair_r: '这条线上，整团头发在画面右侧的最外沿',
};
export const ON_WHAT = ['皮肤', '头发', '遮挡物', '衣服', '出画', '看不见'];
export const EYE_POINTS = {
  outer: '眼白开口靠脸外侧的尽头（只看眼白露出的范围，不算眼线、睫毛、眼影）', inner: '眼白开口靠鼻子一侧的尽头（同上）',
  top: '眼白开口在正中那一列的上沿（上眼睑内缘）', bottom: '眼白开口在正中那一列的下沿（下眼睑内缘）',
  iris_left: '虹膜（黑眼珠）看得见部分的最左沿', iris_right: '虹膜看得见部分的最右沿', iris_center: '虹膜的中心',
};
export const MOUTH_POINTS = { mouth_l: '左嘴角', mouth_r: '右嘴角', lip_top: '上唇上沿的正中点（两个唇峰之间的凹点）', lip_bottom: '下唇下沿的正中点' };

// ── 调用 ──
async function ask(text, png, tag) {
  for (let attempt = 1; attempt <= 8; attempt++) {
    const t0 = Date.now();
    const r = await postJson(LLM_URL, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` }, body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }] }], response_format: { type: 'json_object' }, ...maxTok(4000) }), signal: AbortSignal.timeout(180000) });
    if (r.ok) { logUsage(`landmark-${tag}`, MODEL, r.data.usage, { ms: Date.now() - t0, protocol: PROTOCOL_VERSION }); try { return JSON.parse(r.data.choices[0].message.content); } catch { return null; } }
    if (r.status === 429) { await new Promise((o) => setTimeout(o, 20000)); continue; }
    await new Promise((o) => setTimeout(o, 5000 * attempt));
  }
  return null;
}
const list = (defs) => Object.entries(defs).map(([k, v]) => `- ${k}：${v}`).join('\n');
const xyOk = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);

// ── 行：主图由基础点定；riv 由脸部锚点（鼻底、下巴）按主图的相对位置定 ──
/** 主图行：眼睛行为原点，D = 眼睛行到鼻底；从头顶到下巴按 D/2 铺行（r 后跟半步数，r0 = 眼睛行、r-2 = 眉毛行、r2 = 鼻底行），另加嘴行 m */
export function masterRows(base) {
  const eye = (base.eye_l[1] + base.eye_r[1]) / 2, D = base.nose[1] - eye, rows = {};
  for (let s = -12; s <= 12; s++) { const y = eye + (s * D) / 2; if (y < base.head_top[1] + D * 0.15 || y > base.chin[1] - D * 0.1) continue; rows[`r${s}`] = y; }
  if (xyOk(base.mouth_l) && xyOk(base.mouth_r)) rows.m = (base.mouth_l[1] + base.mouth_r[1]) / 2;
  return { rows, eye, D };
}
/** riv 行：每行相对主图（鼻底, 下巴）的位置 t，原样放到 riv 的（鼻底, 下巴）之间 */
export function anchoredRows(mRows, mBase, rBase) {
  const out = {};
  for (const [k, y] of Object.entries(mRows)) { const t = (y - mBase.nose[1]) / (mBase.chin[1] - mBase.nose[1]); out[k] = rBase.nose[1] + t * (rBase.chin[1] - rBase.nose[1]); }
  return out;
}

// ── 三步 ──
export async function step1(img, tag) {
  const text = `这是一张 ${img.W}×${img.H} 像素的 2D 角色图。给出下列点的像素坐标 [x,y]（x 向右、y 向下，原点左上角）。"左/右"指画面左右。看不到的点给 null，不要猜。\n${list(BASE_POINTS)}\n另外判断图上有没有下列东西（true / false）：${Object.entries(ACCESSORIES).map(([k, v]) => `${k}=${v}`).join('、')}\n只输出 JSON：{"eye_l":[x,y],...,"has":{"glasses":false,...}}`;
  return ask(text, img.png, `${tag}-base`);
}
/** rows：{ 行名: y }；drawLines(png, rows) 由调用方提供（在图上画线、标行名） */
export async function step2(img, rows, drawLines, tag) {
  const lines = Object.entries(rows).map(([k, y]) => `- ${k}：y = ${Math.round(y)}`).join('\n');
  const text = `这是一张 ${img.W}×${img.H} 像素的 2D 角色图，图上画了几条水平线，线的名字写在线的左端：\n${lines}\n"左/右"指画面左右。对每一条线，给出下列点的 x 坐标（整数，点就在这条线上），并说明这个点落在什么上（只能是：${ON_WHAT.join(' / ')}）。只标看得见的边，看不到给 null，不要猜：\n${list(ROW_EDGES)}\n只输出 JSON：{"rows":{"行名":{"face_l":[x,"落在什么上"],"face_r":[x,"…"],"hair_l":[x,"…"],"hair_r":[x,"…"]},...}}`;
  return ask(text, await drawLines(img.png, rows), `${tag}-rows`);
}
const eyeDefs = Object.fromEntries(['l', 'r'].flatMap((s) => Object.entries(EYE_POINTS).map(([k, v]) => [`${s}_${k}`, `${s === 'l' ? '画面左侧' : '画面右侧'}那只眼：${v}`])));
export async function step3eyes(zoom, tag) {
  const text = `这是一张 ${zoom.W}×${zoom.H} 像素的放大图，里面是一个 2D 角色的两只眼睛。给出下列点的像素坐标 [x,y]（x 向右、y 向下）。"左/右"指画面左右。看不到的点给 null，不要猜。\n${list(eyeDefs)}\n只输出 JSON：{"l_outer":[x,y],...}`;
  return ask(text, zoom.png, `${tag}-eyes`);
}
export async function step3mouth(zoom, tag) {
  const text = `这是一张 ${zoom.W}×${zoom.H} 像素的放大图，里面是一个 2D 角色的嘴。给出下列点的像素坐标 [x,y]（x 向右、y 向下）。"左/右"指画面左右。看不到的点给 null，不要猜。\n${list(MOUTH_POINTS)}\n只输出 JSON：{"mouth_l":[x,y],...}`;
  return ask(text, zoom.png, `${tag}-mouth`);
}
/** 放大框（基础坐标）：两眼 / 嘴，由基础点算 */
export function eyesBox(base) { const span = base.eye_r[0] - base.eye_l[0], cy = (base.eye_l[1] + base.eye_r[1]) / 2; return [base.eye_l[0] - span * 0.55, cy - span * 0.3, base.eye_r[0] + span * 0.55, cy + span * 0.3]; }
export function mouthBox(base) { const w = base.mouth_r[0] - base.mouth_l[0], cy = (base.mouth_l[1] + base.mouth_r[1]) / 2; return [base.mouth_l[0] - w * 0.45, cy - w * 0.45, base.mouth_r[0] + w * 0.45, cy + w * 0.45]; }
/** 放大图坐标 → 基础坐标 */
export const unzoom = (pts, box, k) => Object.fromEntries(Object.entries(pts || {}).map(([n, p]) => [n, xyOk(p) ? [box[0] + p[0] / k, box[1] + p[1] / k] : null]));
