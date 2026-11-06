// 多模板验证（假模型，不花钱）：在 lab 页面用模板贴图跑新流程，看阶段跳过、参数映射、隐藏组件。用法：node scripts/vmalign-templates.mjs <假模型端口> <riv 文件名 ...>
import fs from 'node:fs';
import { openLab } from './lab.mjs';
const [fakePort, ...rivs] = process.argv.slice(2);
const master = '/e2e/' + fs.readdirSync(new URL('../data/e2e', import.meta.url)).find((d) => fs.existsSync(new URL(`../data/e2e/${d}/master.png`, import.meta.url))) + '/master.png';
const lab = await openLab();
try {
  for (const rivFilename of rivs) {
    await fetch(`http://localhost:${fakePort}/reset`, { method: 'POST', body: JSON.stringify({ log: `results/vmalign-l2/tpl-${encodeURIComponent(rivFilename)}.jsonl` }) });
    const r = await lab.page.evaluate(async ({ rivFilename, master, fakePort }) => {
      const L = window.lab;
      await L.newProjectFromMaster({ id: 'tpl', rivFilename, masterPath: master });
      const S = L.__state();
      const base = '/@fs/Users/zhangjiawei/repos/ava-studio/client/src';
      const { createTools } = await import(`${base}/vmAlign/tools/index.js`);
      const { PROMPTS } = await import(`${base}/vmAlign/prompts/index.js`);
      const { runAlign } = await import(`${base}/vmAlign/run/runner.js`);
      const { resolveStages, buildStartVm } = await import(`${base}/vmAlign/stages.js`);
      const { buildPatch } = await import(`${base}/vmAlign/writeback.js`);
      const { createLlmClient } = await import(`${base}/vmAlign/llmClient.js`);
      const { createRunClock } = await import(`${base}/vmAlign/clock.js`);
      const { createOffscreenRenderer } = await import(`${base}/utils/riveOffscreen.js`);
      const { VM_PARAM_CONFIG, getRivVmDefaults } = await import(`${base}/constants/vmParamConfig.js`);
      const { templateHasComponent, promptSetVmPatch } = await import(`${base}/constants/componentTemplates.js`);
      const { translations } = await import(`${base}/i18n/index.js`);
      const probe = await createOffscreenRenderer(S.rivBuffer, {}, { width: 64, height: 114 });
      const specs = Object.entries(VM_PARAM_CONFIG).filter(([n, c]) => probe.has(n) && typeof c.min === 'number' && !['guide', 'bg', 'background'].includes(c.panel)).map(([name, c]) => ({ name, label: translations.zh[`vm_label_${name}`] || name, panel: c.panel, min: c.min, max: c.max, step: c.step, default: c.default }));
      probe.destroy();
      const masterBytes = new Uint8Array(await (await window.fetch(S.masterUrl)).arrayBuffer());
      const tools = await createTools({ rivBuffer: S.rivBuffer, modifiedAssets: {}, masterBytes, specs, tileLabels: PROMPTS.tileLabels, onHidden: () => {} });
      const { stages, paramVars, writeKeys } = resolveStages({ specs, hasRole: (x) => tools.roles.has(x), hasComponent: (k) => templateHasComponent(rivFilename, k) });
      const templateDefaults = { ...getRivVmDefaults(), ...promptSetVmPatch(rivFilename) };
      const startVm = buildStartVm({ templateDefaults, viewModelState: {}, writeKeys, specs });
      const post = (body, { signal }) => fetch(`http://localhost:${fakePort}/proxy`, { method: 'POST', body: JSON.stringify(body), signal });
      const out = await runAlign({ tools, llm: createLlmClient({ post }), prompts: PROMPTS, stages, paramVars, specs, startVm, clock: createRunClock() });
      const patch = buildPatch(out.finalVm, writeKeys);
      const hidden = ['Mouth_scale_X', 'Mouth_scale_Y', 'Hair_Switch'];
      return { rivFilename, stages: stages.map((s) => `${s.id}(${s.params.length})`), eyeParams: stages.find((s) => s.id === 'eye')?.params, paramVars, writeKeyCount: writeKeys.length, calls: out.calls, endedBy: out.endedBy, degrades: out.degrades, hiddenInPatch: hidden.filter((k) => k in patch), startHidden: Object.fromEntries(hidden.map((k) => [k, startVm[k]])), finalHidden: Object.fromEntries(hidden.map((k) => [k, out.finalVm[k]])), steps: out.steps.map((s) => s.action ?? '?').reduce((m, a) => ({ ...m, [a]: (m[a] ?? 0) + 1 }), {}) };
    }, { rivFilename, master, fakePort }).catch((e) => ({ rivFilename, ERROR: e.message.slice(0, 500) }));
    console.log(JSON.stringify(r));
  }
} finally { await Promise.race([lab.close(), new Promise((o) => setTimeout(o, 15000))]); }
process.exit(0);
