// 完整流程第 1 步：主图 + 模板 → 按 Studio 的方式生成各组件（能按度量挑的组件各 N 张候选，其余 1 张；失败重试 2 次）
// 用法：node scripts/e2e-gen.mjs <名字> <主图文件> [--template <riv 文件名>] [--n 3] [--add <组件组> --count <张数>]
// --add：已有项目只给某个组件组补生成候选（接在现有 pool/<组>-<i> 后面），不动 project.json、tex/
// 产出 data/e2e/<名字>/：master.png、project.json（候选 1 作为起始贴图）、tex/<资源 id>.png、pool/<组件>-<i>.json（候选 2..N，供挑选）
// 需要本地 worker（8790）+ forge（3110）在跑；生图次数记进 logs/usage.jsonl（tag e2e-gen/<名字>）
import fs from 'node:fs';
import path from 'node:path';
import { openLab, writeJson, labPath } from './lab.mjs';
import { logUsage, setUsageTag } from './usage.mjs';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const [name, masterFile] = args;
const TEMPLATE = opt('template', '龙虾小女孩26.10.28.1.riv'), N = Number(opt('n', 3)), ADD = opt('add', null), ADD_N = Number(opt('count', 2));
if (!name || !masterFile) { console.error('用法：node scripts/e2e-gen.mjs <名字> <主图文件> [--template riv] [--n 3]'); process.exit(1); }
const id = `e2e-${name}`, root = labPath(`data/e2e/${name}`);
for (const d of ['tex', 'pool']) fs.mkdirSync(`${root}/${d}`, { recursive: true });
if (!ADD) fs.copyFileSync(path.resolve(masterFile), `${root}/master.png`);
setUsageTag(`e2e-gen/${id}`);
const lab = await openLab();
const cands = {};  // group → [{ textures, viewModelPatch }]
try {
  const { plans } = await lab.call('newProjectFromMaster', { id, rivFilename: TEMPLATE, masterPath: `/e2e/${name}/master.png` });
  const groups = ADD ? [ADD] : await lab.call('genGroups');
  console.log(id, '模板', TEMPLATE, '组件组', groups.join(','), '每组', N, '张');
  // 各组并行、组内依次生成（单组失败重试 2 次）
  // 要挑选的组件各生成 N 张（v17 起头发也由 AI 挑）；手臂、背景各 1 张（和 Studio 一次批量一致）
  const SELECTABLE = new Set(['head', 'body', 'sclera', 'pupil', 'mouth', 'hair']);
  await Promise.all(groups.map(async (g) => {
    cands[g] = [];
    for (let i = 1; i <= (ADD ? ADD_N : SELECTABLE.has(g) ? N : 1); i++) {
      let r = null;
      for (let attempt = 1; attempt <= 3; attempt++) { r = await lab.call('genGroup', g); if (r.ok) break; console.log(id, g, i, '失败', attempt, r.error); }
      if (!r?.ok) continue;
      logUsage('regen', 'gptimage', {}, { calls: r.calls, component: g });
      cands[g].push({ component: g, textures: r.textures, viewModelPatch: r.viewModelPatch ?? null });
      console.log(id, g, i, 'ok');
    }
  }));
  if (ADD) {
    const have = fs.readdirSync(`${root}/pool`).filter((f) => f.startsWith(`${ADD}-`)).length;
    cands[ADD].forEach((c, j) => writeJson(`data/e2e/${name}/pool/${ADD}-${have + j + 2}.json`, c));
    console.log(id, '补生成', ADD, cands[ADD].length, '张');
  } else {
  // 候选 1 = 起始贴图（写进 project.json）；候选 2..N 进候选池
  const assetDrafts = {}, vmPatch = {};
  for (const [g, list] of Object.entries(cands)) {
    if (!list.length) { console.log(id, g, '全部失败，用模板原贴图'); continue; }
    for (const [aid, b64] of Object.entries(list[0].textures)) { fs.writeFileSync(`${root}/tex/${aid}.png`, Buffer.from(b64, 'base64')); assetDrafts[aid] = { finalUrl: `/e2e/${name}/tex/${aid}.png` }; }
    Object.assign(vmPatch, list[0].viewModelPatch ?? {});
    list.slice(1).forEach((c, j) => writeJson(`data/e2e/${name}/pool/${g}-${j + 2}.json`, c));
  }
  writeJson(`data/e2e/${name}/project.json`, { id, name: `完整流程 ${name}`, riv_template_key: TEMPLATE, main_image: `/e2e/${name}/master.png`, draft_state_json: JSON.stringify({ assetDrafts, viewModelState: vmPatch }), plans });
  console.log(id, '完成', Object.fromEntries(Object.entries(cands).map(([g, l]) => [g, l.length])));
  }
} finally { await lab.close(); }
