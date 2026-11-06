// L2 新流程：lab 页面里用真实渲染、假模型跑 client/src/vmAlign 的 runAlign，起点和 lab 一致。用法：node scripts/vmalign-l2.mjs <项目 id> <假模型端口>
import fs from 'node:fs';
import { openLab, projectInput, writeJson } from './lab.mjs';
import { startVmOf } from './start-vm.mjs';
const [id, fakePort] = process.argv.slice(2);
const lab = await openLab();
try {
  const info = await lab.call('loadProject', projectInput(id));
  await lab.call('loadMaster');
  const specs = await lab.call('tunableParams');
  const startVm = { ...startVmOf(info.savedVm, specs), Head_scale: 100 };
  const result = await lab.page.evaluate(async ({ startVm, specs, fakePort }) => {
    const S = window.lab.__state();
    const base = '/@fs/Users/zhangjiawei/repos/ava-studio/client/src/vmAlign';
    const { createTools } = await import(`${base}/tools/index.js`);
    const { PROMPTS } = await import(`${base}/prompts/index.js`);
    const { runAlign } = await import(`${base}/run/runner.js`);
    const { resolveStages } = await import(`${base}/stages.js`);
    const { createLlmClient } = await import(`${base}/llmClient.js`);
    const { createRunClock } = await import(`${base}/clock.js`);
    const masterBytes = new Uint8Array(await (await window.fetch(S.masterUrl)).arrayBuffer());
    const tools = await createTools({ rivBuffer: S.rivBuffer, modifiedAssets: S.modifiedAssets, masterBytes, specs, tileLabels: PROMPTS.tileLabels, onHidden: () => {} });
    const { stages, paramVars, writeKeys } = resolveStages({ specs, hasRole: (r) => tools.roles.has(r), hasComponent: () => true });
    const post = (body, { signal }) => fetch(`http://localhost:${fakePort}/proxy`, { method: 'POST', body: JSON.stringify(body), signal });
    const llm = createLlmClient({ post });
    const r = await runAlign({ tools, llm, prompts: PROMPTS, stages, paramVars, specs, startVm, clock: createRunClock() });
    return { finalVm: r.finalVm, endedBy: r.endedBy, calls: r.calls, degrades: r.degrades, gateLog: r.gateLog.map((g) => ({ stage: g.stage, keep: g.keep, biased: g.biased, byMetrics: g.byMetrics })), target: r.target, current: r.current, stageIds: stages.map((s) => s.id), writeKeys };
  }, { startVm, specs, fakePort });
  writeJson('results/vmalign-l2/new-result.json', result);
  console.log('new done', result.calls, 'calls', result.endedBy, JSON.stringify(result.degrades));
} finally { await Promise.race([lab.close(), new Promise((o) => setTimeout(o, 15000))]); }
process.exit(0);
