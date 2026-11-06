// 方案 A：现有「按主图对齐比例」，从共同起点（startVmOf）跑全部部位，结果存 results/a/<项目前 8 位>.json
import { openLab, projectInput, writeJson } from './lab.mjs';
import { startVmOf } from './start-vm.mjs';
const ids = process.argv.slice(2);
const lab = await openLab();
try {
  for (const id of ids) {
    const info = await lab.call('loadProject', projectInput(id));
    const start = startVmOf(info.savedVm, await lab.call('tunableParams'));
    const t0 = Date.now();
    let out;
    try {
      const res = await lab.call('runA', start);
      out = { id, ok: true, ms: res.ms, vm: res.vm, rows: res.rows, unsolved: res.unsolved, notes: res.notes, clamped: res.clamped };
    } catch (e) {
      out = { id, ok: false, ms: Date.now() - t0, error: e.message.split('\n')[0].replace(/^page\.evaluate: Error: /, '') };
    }
    writeJson(`results/a/${id.slice(0, 8)}.json`, out);
    console.log(id.slice(0, 8), out.ok ? 'ok' : 'FAIL', Math.round(out.ms / 1000), 's', out.error ?? JSON.stringify(out.unsolved));
  }
} finally { await lab.close(); }
