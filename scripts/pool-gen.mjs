// v12 候选池：每个项目每个组件按 Studio 同样的方式生成 N 张候选贴图（失败自动重试 2 次），存 results/pool/<项目>/<组件>-<i>.json
// 每张候选只存相对项目原贴图变了的那几张（{ textures: { 资源 id: base64 }, viewModelPatch }），两次运行共用同一个池
// 用法：node scripts/pool-gen.mjs <项目 id ...>（COMPONENTS、N 可用环境变量改）
import fs from 'node:fs';
import { openLab, projectInput, writeJson, labPath } from './lab.mjs';
import { logUsage, setUsageTag } from './usage.mjs';

const COMPONENTS = (process.env.COMPONENTS || 'head,sclera,pupil,mouth').split(',');
const N = Number(process.env.N || 3);
const GEN_CALLS = { head: 2, hair: 2, mouth: 3 };
const lab = await openLab();
try {
  for (const id of process.argv.slice(2)) {
    const p8 = id.slice(0, 8);
    setUsageTag(`pool/${p8}`);
    await lab.call('loadProject', projectInput(id));
    const base = await lab.call('textureSnapshot');
    for (const comp of COMPONENTS) {
      for (let i = 1; i <= N; i++) {
        const f = `results/pool/${p8}/${comp}-${i}.json`;
        if (fs.existsSync(labPath(f))) continue;
        let r = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          await lab.call('restoreTextures', base);
          r = await lab.call('regenerate', comp);
          if (r.ok) break;
          console.log(p8, comp, i, 'failed', attempt, r.error);
        }
        if (!r?.ok) continue;
        logUsage('regen', 'gptimage', {}, { calls: GEN_CALLS[comp] ?? 1, component: comp });
        const snap = await lab.call('textureSnapshot');
        const textures = Object.fromEntries(Object.entries(snap).filter(([k, v]) => v !== base[k]));
        writeJson(f, { component: comp, textures, viewModelPatch: r.viewModelPatch ?? null, ms: r.ms });
        console.log(p8, comp, i, 'ok', Math.round(r.ms / 1000), 's', Object.keys(textures).length, 'textures');
      }
    }
    await lab.call('restoreTextures', base);
  }
} finally { await lab.close(); }
