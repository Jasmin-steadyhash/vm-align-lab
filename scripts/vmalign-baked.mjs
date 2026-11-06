// 发布烘焙后再对齐：用真实 bakeScaledAssetsForPublish + buildPreviewBuffer 生成烘焙 riv，比较和烘焙前的测量、裁切量，并用假模型跑一遍流程。
import fs from 'node:fs';
import { openLab, projectInput, labPath, CLIENT_FS } from './lab.mjs';
const [id, tracePath, fakePort] = process.argv.slice(2);
const final = JSON.parse(fs.readFileSync(labPath(tracePath), 'utf8')).finalVm;
const lab = await openLab();
try {
  await lab.call('loadProject', projectInput(id));
  await lab.call('loadMaster');
  const specs = await lab.call('tunableParams');
  const r = await lab.page.evaluate(async ({ final, specs, fakePort, clientFs }) => {
    const S = window.lab.__state();
    const base = clientFs;
    const imp = (p) => import(`${base}/${p}`);
    const { bakeScaledAssetsForPublish } = await imp('utils/rivePublishBake.js');
    const { buildPreviewBuffer } = await imp('utils/riveExport.js');
    const { parseRiveFile } = await imp('utils/riveParser.js');
    const { resolveKnownComponentKey } = await imp('constants/componentPromptMapping.js');
    const { createTools } = await imp('vmAlign/tools/index.js');
    const { PROMPTS } = await imp('vmAlign/prompts/index.js');
    const { runAlign } = await imp('vmAlign/run/runner.js');
    const { resolveStages, buildStartVm } = await imp('vmAlign/stages.js');
    const { createLlmClient } = await imp('vmAlign/llmClient.js');
    const { createRunClock } = await imp('vmAlign/clock.js');
    const baked = await bakeScaledAssetsForPublish(S.modifiedAssets, final, S.plans);
    const buf0 = buildPreviewBuffer(S.rivBuffer, baked.modifiedAssets);
    const u8 = buf0 instanceof Uint8Array ? buf0 : new Uint8Array(buf0);
    const bakedRiv = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    const out = { bakedAssetIds: baked.bakedAssetIds.length, reset: baked.resetPatch, scales: Object.fromEntries(Object.keys(baked.resetPatch).map((k) => [k, final[k]])) };

    // 裁切量：不透明像素数 烘焙前 vs 烘焙后（缩放 factor 后理论像素数 = 前 × factor²，少的就是被画布裁掉的）
    const alpha = async (b) => { const bm = await createImageBitmap(new Blob([b])); const c = new OffscreenCanvas(bm.width, bm.height), g = c.getContext('2d'); g.drawImage(bm, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] >= 128) n++; return n; };
    const file = parseRiveFile(S.rivBuffer.slice(0));
    out.crop = [];
    for (const idv of baked.bakedAssetIds) {
      const a = file.assets.get(idv) ?? file.assets.get(Number(idv)); const role = resolveKnownComponentKey(a?.name);
      const key = { body: 'Body_scale', head: 'Face_scale', hair_front: 'Hair_top_scale', hair_back: 'Hair_back_scale' }[role];
      const f = final[key] / 100, before = await alpha(S.modifiedAssets[idv].newBytes), after = await alpha(baked.modifiedAssets[idv].newBytes), expected = before * f * f;
      out.crop.push({ role, scale: final[key], before, after, expected: Math.round(expected), lostPct: +((1 - after / expected) * 100).toFixed(1) });
    }

    const masterBytes = new Uint8Array(await (await window.fetch(S.masterUrl)).arrayBuffer());
    const mk = (rivBuffer, modifiedAssets) => createTools({ rivBuffer, modifiedAssets, masterBytes, specs, tileLabels: PROMPTS.tileLabels, onHidden: () => {} });
    const A = await mk(S.rivBuffer, S.modifiedAssets), B = await mk(bakedRiv, {});
    out.rolesBaked = [...B.roles].sort();
    const bakedVm = baked.viewModelState;
    await A.freezeFrame(final); await B.freezeFrame(bakedVm);
    const parts = {};
    for (const roles of [['head'], ['body'], ['hair_front'], ['hair_back'], ['sclera'], ['pupil'], ['mouth_up', 'mouth_down']]) {
      const [x, y] = [await A.stageEffects(final, roles, []), await B.stageEffects(bakedVm, roles, [])];
      parts[roles[0]] = { before: x.part, after: y.part };
    }
    out.parts = parts;
    out.glitch = [await A.glitchMetrics(final), await B.glitchMetrics(bakedVm)];
    const decode = async (b64) => { const bm = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' })); const c = new OffscreenCanvas(bm.width, bm.height), g = c.getContext('2d'); g.drawImage(bm, 0, 0); return g.getImageData(0, 0, bm.width, bm.height).data; };
    const [pa, pb] = [await decode((await A.rivForPoints(final)).png), await decode((await B.rivForPoints(bakedVm)).png)];
    let diff = 0, big = 0; for (let i = 0; i < pa.length; i += 4) { const m = Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2])); if (m > 2) diff++; if (m > 40) big++; }
    out.renderDiff = { total: pa.length / 4, over2: diff, over40: big };

    // 流程：烘焙 riv 上跑一遍（Studio 打开发布过的项目时就是这个状态）
    const { stages, paramVars, writeKeys } = resolveStages({ specs, hasRole: (x) => B.roles.has(x), hasComponent: () => true });
    const startVm = buildStartVm({ templateDefaults: {}, viewModelState: bakedVm, writeKeys, specs });
    const post = (body, { signal }) => fetch(`http://localhost:${fakePort}/proxy`, { method: 'POST', body: JSON.stringify(body), signal });
    const fresh = await mk(bakedRiv, {});
    const run = await runAlign({ tools: fresh, llm: createLlmClient({ post }), prompts: PROMPTS, stages, paramVars, specs, startVm, clock: createRunClock() });
    out.run = { stages: stages.map((s) => s.id), calls: run.calls, endedBy: run.endedBy, degrades: run.degrades };
    return out;
  }, { final, specs, fakePort, clientFs: CLIENT_FS }).catch((e) => ({ ERROR: e.message.slice(0, 800) }));
  console.log(JSON.stringify(r, null, 1));
} finally { await Promise.race([lab.close(), new Promise((o) => setTimeout(o, 15000))]); }
process.exit(0);
