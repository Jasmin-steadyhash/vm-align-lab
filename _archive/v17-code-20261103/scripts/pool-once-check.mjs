// 验证「挑选只量 1 次、不试调」能否淘汰已知的坏候选：每个组件依次，每张候选在起点参数下只标 1 次，
// 按规则 4 的淘汰条件（最差项比最好的候选高 10 个百分点以上）判淘汰；主图目标用已有的多次定点（不再花钱）
import fs from 'node:fs';
import { openLab, projectInput, readJson, labPath, isE2E } from './lab.mjs';
import { startVmOf } from './start-vm.mjs';
import { locate, POINTS_WHITE, multiTargets, metricsWith, STAGE_METRICS_FACE, UNRELIABLE } from './landmarks.mjs';
import { setUsageTag } from './usage.mjs';
const MODEL = 'gpt-6.1-sol', GAP = 0.10;
const ORDER = [['head', 'face'], ['body', 'body'], ['sclera', 'eye'], ['pupil', 'iris'], ['mouth', 'mouth']];
const med = (v) => { v = v.filter(Number.isFinite).sort((a, b) => a - b); return v[v.length >> 1]; };
const CASES = [
  { id: 'e2e-dfb3bc24-86fd-4619-b6e3-f85e1fcc4e29', label: '耳麦女孩', masterPts: JSON.parse(fs.readFileSync('/tmp/master-pts.json', 'utf8')), pool: labPath('data/e2e/dfb3bc24-86fd-4619-b6e3-f85e1fcc4e29/pool'), baseName: '候选1' },
  { id: '1cf5ecc9-873b-4a81-9595-2e2672a9b3c7', label: '1cf5ecc9', masterPts: (() => { const a = readJson('results/metric-check/raw.json'), b = readJson('results/metric-check/raw-gpt_6.1_sol.json'), k = '1cf5ecc9-873b-4a81-9595-2e2672a9b3c7'; return [...a[k].master, ...b[k].master]; })(), pool: labPath('results/pool/1cf5ecc9'), baseName: '原贴图（没鼻子）' },
];
const lab = await openLab();
try {
  for (const c of CASES) {
    setUsageTag(`pool-once-check/${c.label}`);
    const info = await lab.call('loadProject', projectInput(c.id)); await lab.call('loadMaster');
    const specs = await lab.call('tunableParams');
    const vm = { ...startVmOf(info.savedVm, specs), ...(isE2E(c.id) ? info.savedVm : {}), Head_scale: 100 };
    const mt = multiTargets(c.masterPts);
    // 主图虹膜比例（代码找边）
    const P = (n, i) => med(c.masterPts.map((p) => p?.[n]?.[i]));
    const mfp = await lab.call('masterForPoints'), k = (await lab.call('masterSize')).w / mfp.W, xs = [P('eye_l_outer', 0) * k, P('eye_l_inner', 0) * k];
    const me = await lab.call('eyeMaster', [Math.min(...xs), P('eye_l_top', 1) * k, Math.max(...xs), P('eye_l_bottom', 1) * k]);
    const target = { ...mt.target }; if (me && me.irisW > 0 && me.eyeW >= 30) target.iris_ratio = me.irisW / me.eyeW;
    console.log(`\n== ${c.label}`);
    let keep = await lab.call('textureSnapshot');
    for (const [comp, stage] of ORDER) {
      const files = fs.existsSync(c.pool) ? fs.readdirSync(c.pool).filter((f) => f.startsWith(`${comp}-`)).sort() : [];
      if (!files.length) continue;
      const ks = (STAGE_METRICS_FACE[stage] ?? []).filter((x) => !UNRELIABLE.has(x) && x in target);
      const cands = [{ name: c.baseName, textures: {}, viewModelPatch: null }, ...files.map((f) => ({ name: f.replace('.json', '').replace(`${comp}-`, '候选'), ...JSON.parse(fs.readFileSync(`${c.pool}/${f}`, 'utf8')) }))];
      // 渲染依次做，定点同时发
      const preps = [];
      for (const cd of cands) {
        await lab.call('restoreTextures', { ...keep, ...cd.textures });
        const v = { ...vm, ...(cd.viewModelPatch ?? {}) };
        preps.push({ cd, img: await lab.call('rivForPoints', v), eye: comp === 'pupil' ? await lab.call('eyeRiv', v, 2) : null });
      }
      const rows = await Promise.all(preps.map(async ({ cd, img, eye }) => {
        const m = metricsWith(await locate(MODEL, img, POINTS_WHITE) || {}, mt.rulerOf);
        if (eye) m.iris_ratio = eye.irisW > 0 && eye.eyeW >= 30 ? eye.irisW / eye.eyeW : 1;
        const e = ks.map((x) => (Number.isFinite(m[x]) ? Math.abs(m[x] - target[x]) / Math.max(0.1, Math.abs(target[x])) : 1));
        return { cd, worst: Math.max(...e), mean: e.reduce((a, b) => a + b, 0) / e.length, detail: Object.fromEntries(ks.map((x, i) => [x, Math.round(e[i] * 100)])) };
      }));
      const bw = Math.min(...rows.map((r) => r.worst));
      const ok = rows.filter((r) => r.worst <= bw + GAP);
      const pick = ok.includes(rows[0]) ? rows[0] : ok.reduce((a, b) => (b.mean < a.mean ? b : a));
      console.log(`  ${comp}（看 ${ks.join(',')}）`);
      for (const r of rows) console.log(`     ${r.cd.name.padEnd(12)} 最差项 ${(r.worst * 100).toFixed(0).padStart(3)}%  平均 ${(r.mean * 100).toFixed(0).padStart(3)}%  ${ok.includes(r) ? '' : '← 淘汰'}  ${JSON.stringify(r.detail)}`);
      console.log(`     → 用 ${pick.cd.name}`);
      keep = { ...keep, ...pick.cd.textures }; await lab.call('restoreTextures', keep);
    }
  }
} finally { await lab.close(); }
