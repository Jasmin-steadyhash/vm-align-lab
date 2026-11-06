// 验证「上层破洞露出下层」检查：对已评审的结果逐个检测，和评审 / 人工的「无穿帮」判定对照
import fs from 'node:fs';
import { openLab, projectInput, readJson, writeJson, labPath } from './lab.mjs';
import { startVmOf } from './start-vm.mjs';
const S2 = readJson('results/judge/std2/summary.json');
const H = readJson('results/human/labels.json'), K = readJson('results/human/key.json');
const out = {};
const lab = await openLab();
try {
  for (const id of Object.keys(S2)) {
    const p8 = id.slice(0, 8);
    const info = await lab.call('loadProject', projectInput(id));
    const start = { ...startVmOf(info.savedVm, await lab.call('tunableParams')), Head_scale: 100 };
    for (const method of Object.keys(S2[id])) {
      await lab.call('loadProject', projectInput(id));
      const dir = labPath(`results/${method}/${p8}`);
      const vm = method === 'start' ? start : JSON.parse(fs.readFileSync(`${dir}/trace.json`, 'utf8')).finalVm;
      if (method !== 'start' && fs.existsSync(`${dir}/textures.json`)) await lab.call('restoreTextures', JSON.parse(fs.readFileSync(`${dir}/textures.json`, 'utf8')));
      const holes = await lab.call('partHoles', vm);
      const human = K.filter((k) => k.id === p8 && k.method === method).map((k) => H[k.no].no_glitch);
      out[`${p8} ${method}`] = { holes, judge: S2[id][method].majority.no_glitch, human: human[0] ?? null };
      console.log(p8, method.replace('agent/', '').padEnd(6), '评审', S2[id][method].majority.no_glitch.padEnd(8), '人工', String(human[0] ?? '-').padEnd(8), '破洞', holes.map((h) => `${h.part}<${h.through} ${h.n}px@${h.box[0]},${h.box[1]}`).join('; ') || '无');
    }
  }
} finally { await lab.close(); }
writeJson('results/metric-check/holes.json', out);
