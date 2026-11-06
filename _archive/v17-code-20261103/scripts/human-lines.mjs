// 标注页参考线：主图关键点（AI 定点 3 次取中位）换算到对比图坐标，两半共用同一组线（两边已按脸对齐，眼睛中心重合）
import fs from 'node:fs';
import { openLab, projectInput, readJson, writeJson } from './lab.mjs';
const key = readJson('results/human/key.json');
const raw = readJson('results/metric-check/raw.json');
const fullId = Object.fromEntries(Object.keys(raw).map((k) => [k.slice(0, 8), k]));
const ok = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const med = (v) => { v = v.filter(Number.isFinite).sort((a, b) => a - b); return v[v.length >> 1]; };
const pt = (list, k) => { const ps = list.map((l) => l?.[k]).filter(ok); return ps.length ? [med(ps.map((p) => p[0])), med(ps.map((p) => p[1]))] : null; };
const TILE = 900, TOP = 28;
const perProject = {};
const lab = await openLab();
try {
  for (const p8 of new Set(key.map((k) => k.id))) {
    await lab.call('loadProject', projectInput(fullId[p8]));
    await lab.call('loadMaster');
    const m = await lab.call('masterForPoints'), dim = await lab.call('masterSize');
    const k = dim.w / m.W, t = TILE / dim.w;
    const P = (name) => { const v = pt(raw[fullId[p8]].master, name); return v && [v[0] * k * t, TOP + v[1] * k * t]; };
    const avgY = (...ns) => { const v = ns.map(P).filter(Boolean); return v.reduce((s, p) => s + p[1], 0) / v.length; };
    perProject[p8] = {
      h: [['眉毛', avgY('brow_l', 'brow_r')], ['上眼睑', P('eye_l_top')?.[1]], ['眼睛中心', avgY('eye_l', 'eye_r')], ['下眼睑', P('eye_l_bottom')?.[1]],
        ['鼻底', P('nose')?.[1]], ['嘴', avgY('mouth_l', 'mouth_r')], ['下巴', P('chin')?.[1]], ['肩线', avgY('shoulder_l', 'shoulder_r')]].filter(([, y]) => Number.isFinite(y)),
      // 脸左右边缘（cheek）的 AI 定点落在轮廓内侧，不画；加鼻尖竖线作中线，看身体是否对齐
      v: [['左眼外', P('eye_l_outer')?.[0]], ['左眼内', P('eye_l_inner')?.[0]], ['中线（鼻）', P('nose')?.[0]],
        ['左肩', P('shoulder_l')?.[0]], ['右肩', P('shoulder_r')?.[0]]].filter(([, x]) => Number.isFinite(x)),
    };
  }
} finally { await lab.close(); }
writeJson('results/human/lines.json', Object.fromEntries(key.map(({ no, id }) => [no, perProject[id]])));
console.log('ok');
