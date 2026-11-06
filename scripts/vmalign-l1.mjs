// L1：client/src/vmAlign/tools 和 page/main.js 对同一项目同一 vm 比输出（PNG base64、数值）。不调模型。
// 用法：node scripts/vmalign-l1.mjs <项目 id> <trace 路径>
import fs from 'node:fs';
import { openLab, projectInput, labPath } from './lab.mjs';
import { startVmOf } from './start-vm.mjs';
const [id, tracePath] = process.argv.slice(2);
const trace = JSON.parse(fs.readFileSync(labPath(tracePath), 'utf8'));
const lab = await openLab();
try {
  const info = await lab.call('loadProject', projectInput(id));
  await lab.call('loadMaster');
  const specs = await lab.call('tunableParams');
  const start = { ...startVmOf(info.savedVm, specs), Head_scale: 100 };
  const rows = await lab.page.evaluate(async ({ start, final, specs }) => {
    const L = window.lab, S = L.__state();
    const { createTools } = await import('/@fs/Users/zhangjiawei/repos/ava-studio/client/src/vmAlign/tools/index.js');
    const { PROMPTS } = await import('/@fs/Users/zhangjiawei/repos/ava-studio/client/src/vmAlign/prompts/index.js');
    const masterBytes = new Uint8Array(await (await window.fetch(S.masterUrl)).arrayBuffer());
    const T = await createTools({ rivBuffer: S.rivBuffer, modifiedAssets: S.modifiedAssets, masterBytes, specs, tileLabels: PROMPTS.tileLabels, onHidden: () => {} });
    const out = [];
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const check = async (name, oldFn, newFn) => {
      const t0 = performance.now(); const a = await oldFn(); const t1 = performance.now(); const b = await newFn(); const t2 = performance.now();
      out.push({ name, same: same(a, b), oldMs: Math.round(t1 - t0), newMs: Math.round(t2 - t1), ...(same(a, b) ? {} : { old: JSON.stringify(a).slice(0, 300), new: JSON.stringify(b).slice(0, 300) }) });
    };
    await check('freezeFrame', () => L.freezeFrame(start), () => T.freezeFrame(start));
    await check('masterForPoints', () => L.masterForPoints(), () => T.masterForPoints());
    await check('masterSize', () => L.masterSize(), () => T.masterSize());
    for (const [tag, vm] of [['start', start], ['final', final]]) {
      await check(`rivForPoints/${tag}`, () => L.rivForPoints(vm), () => T.rivForPoints(vm));
      await check(`obsPair/${tag}/full`, () => L.obsPair(vm, [0, 0, 1, 1]), () => T.obsPair(vm, [0, 0, 1, 1]));
      await check(`obsPair/${tag}/crop`, () => L.obsPair(vm, [0.2, 0.15, 0.6, 0.3]), () => T.obsPair(vm, [0.2, 0.15, 0.6, 0.3]));
      await check(`partBoxes/${tag}`, () => L.partBoxes(vm), () => T.partBoxes(vm));
      await check(`glitchMetrics/${tag}`, () => L.glitchMetrics(vm), () => T.glitchMetrics(vm));
      await check(`eyeRiv/${tag}`, () => L.eyeRiv(vm, 2), () => T.eyeRiv(vm, 2));
      const boxes = await L.partBoxes(vm);
      const items = Object.entries(boxes).map(([k, box]) => ({ label: k, box }));
      await check(`obsGrid/${tag}`, () => L.obsGrid(vm, items), () => T.obsGrid(vm, items));
    }
    await check('obsCandidates', () => L.obsCandidates([start, final], [0, 0, 1, 1], 300), () => T.obsCandidates([start, final], [0, 0, 1, 1], 300));
    for (const [roles, params] of [[['head'], ['Head_Y']], [['body'], ['Body_scale', 'Body_Y', 'Body_X']], [['hair_front'], ['Hair_top_scale', 'Hair_top_Y']], [['sclera'], ['Eye_R_Y', 'Eye_R_X', 'Eye_scale_X', 'Eye_scale_Y']], [['pupil'], ['Eye_iris_scale']], [['mouth_up', 'mouth_down'], ['Mouth_Y', 'Mouth_scale_X']]]) {
      await check(`stageEffects/${roles.join('+')}`, async () => { const r = await L.stageEffects(start, roles, params); return r; }, async () => { const { part, box, effects } = await T.stageEffects(start, roles, params); return { part, box, effects }; });
    }
    await check('eyeMaster', () => L.eyeMaster([100, 300, 200, 340]), () => T.eyeMaster([100, 300, 200, 340]));
    await check('gapBaseSet', () => L.gapBaseSet(start), () => T.gapBaseSet(start));
    await check('gapVsBase/final', () => L.gapVsBase(final), () => T.gapVsBase(final));
    await check('gapVsBase/hairShift', () => L.gapVsBase({ ...final, Hair_back_scale: 70 }), () => T.gapVsBase({ ...final, Hair_back_scale: 70 }));
    return out;
  }, { start, final: trace.finalVm, specs });
  let bad = 0;
  for (const r of rows) { console.log(r.same ? 'SAME' : 'DIFF', r.name, `${r.oldMs}ms → ${r.newMs}ms`); if (!r.same) { bad++; console.log('  old', r.old); console.log('  new', r.new); } }
  console.log(`\n${rows.length - bad}/${rows.length} 一致`);
} finally { await Promise.race([lab.close(), new Promise((o) => setTimeout(o, 15000))]); }
process.exit(0);
