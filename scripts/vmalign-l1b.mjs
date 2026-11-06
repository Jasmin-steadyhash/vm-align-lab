// L1 对照：同一函数 lab 自己连跑、新代码自己连跑、新旧互比，统计 PNG 不同的次数和像素差（判断差异来自渲染抖动还是代码）
import fs from 'node:fs';
import { openLab, projectInput, labPath } from './lab.mjs';
import { startVmOf } from './start-vm.mjs';
const [id, tracePath, N0] = process.argv.slice(2); const N = Number(N0 || 6);
const trace = JSON.parse(fs.readFileSync(labPath(tracePath), 'utf8'));
const lab = await openLab();
try {
  const info = await lab.call('loadProject', projectInput(id));
  await lab.call('loadMaster');
  const specs = await lab.call('tunableParams');
  const start = { ...startVmOf(info.savedVm, specs), Head_scale: 100 };
  const rows = await lab.page.evaluate(async ({ start, final, specs, N }) => {
    const L = window.lab, S = L.__state();
    const { createTools } = await import('/@fs/Users/zhangjiawei/repos/ava-studio/client/src/vmAlign/tools/index.js');
    const { PROMPTS } = await import('/@fs/Users/zhangjiawei/repos/ava-studio/client/src/vmAlign/prompts/index.js');
    const masterBytes = new Uint8Array(await (await window.fetch(S.masterUrl)).arrayBuffer());
    const T = await createTools({ rivBuffer: S.rivBuffer, modifiedAssets: S.modifiedAssets, masterBytes, specs, tileLabels: PROMPTS.tileLabels, onHidden: () => {} });
    await L.freezeFrame(start); await T.freezeFrame(start);
    const decode = async (b64) => { const bm = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' })); const c = new OffscreenCanvas(bm.width, bm.height), g = c.getContext('2d'); g.drawImage(bm, 0, 0); return { d: g.getImageData(0, 0, bm.width, bm.height).data, w: bm.width, h: bm.height }; };
    const pxDiff = async (a, b) => { if (a === b) return { px: 0, max: 0 }; const [x, y] = [await decode(a), await decode(b)]; let px = 0, max = 0; for (let i = 0; i < x.d.length; i += 4) { let m = 0; for (let c = 0; c < 4; c++) m = Math.max(m, Math.abs(x.d[i + c] - y.d[i + c])); if (m) { px++; max = Math.max(max, m); } } return { px, max, total: x.w * x.h }; };
    const out = [];
    const cases = { 'obsPair/final': [() => L.obsPair(final, [0, 0, 1, 1]), () => T.obsPair(final, [0, 0, 1, 1])], 'rivForPoints/start': [async () => (await L.rivForPoints(start)).png, async () => (await T.rivForPoints(start)).png] };
    for (const [name, [oldFn, newFn]] of Object.entries(cases)) {
      const olds = [], news = [];
      for (let i = 0; i < N; i++) { olds.push(await oldFn()); news.push(await newFn()); }
      const pairs = async (A, B, self) => { const r = []; for (let i = 0; i < A.length; i++) for (let j = self ? i + 1 : 0; j < B.length; j++) r.push(await pxDiff(A[i], B[j])); return r; };
      const sum = (r) => ({ pairs: r.length, identical: r.filter((x) => x.px === 0).length, maxPx: Math.max(...r.map((x) => x.px)), maxDelta: Math.max(...r.map((x) => x.max)), total: r.find((x) => x.total)?.total ?? null });
      out.push({ name, oldVsOld: sum(await pairs(olds, olds, true)), newVsNew: sum(await pairs(news, news, true)), oldVsNew: sum(await pairs(olds, news, false)), distinctOld: new Set(olds).size, distinctNew: new Set(news).size, sharedVariants: [...new Set(olds)].filter((x) => news.includes(x)).length });
    }
    return out;
  }, { start, final: trace.finalVm, specs, N });
  for (const r of rows) console.log(JSON.stringify(r));
} finally { await Promise.race([lab.close(), new Promise((o) => setTimeout(o, 15000))]); }
process.exit(0);
