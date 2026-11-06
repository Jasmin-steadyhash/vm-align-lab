// L2 比较：lab 和新流程发给假模型的消息逐条比；图片已归一成 [IMG]，「已用 N 秒」归一。再比最终参数。
import fs from 'node:fs';
const [aPath, bPath, labTrace, newResult] = process.argv.slice(2);
const read = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const norm = (r) => JSON.stringify(r.messages).replace(/已用 \d+ 秒/g, '已用 N 秒');
const key = (r) => `${r.kind}#${r.n}`;
const A = read(aPath), B = read(bPath);
const count = (R) => R.reduce((m, r) => ({ ...m, [r.kind]: (m[r.kind] ?? 0) + 1 }), {});
console.log('lab 请求', A.length, JSON.stringify(count(A)), '| 新流程请求', B.length, JSON.stringify(count(B)));
const seqSame = A.length === B.length && A.every((r, i) => r.kind === B[i].kind);
console.log('调用顺序（用途序列）一致:', seqSame);
const mapB = new Map(B.map((r) => [key(r), r]));
let same = 0, diff = 0, first = null;
for (const r of A) { const o = mapB.get(key(r)); if (o && norm(r) === norm(o)) same++; else { diff++; first ??= { key: key(r), a: r, b: o }; } }
console.log('消息内容一致', same, '/', A.length, '，不一致', diff);
if (first) {
  const [x, y] = [norm(first.a), first.b ? norm(first.b) : ''];
  let i = 0; while (i < x.length && x[i] === y[i]) i++;
  console.log('第一处不一致', first.key, '位置', i, '\n  lab:', x.slice(Math.max(0, i - 120), i + 200), '\n  新 :', y.slice(Math.max(0, i - 120), i + 200));
}
const lt = JSON.parse(fs.readFileSync(labTrace, 'utf8')), nr = JSON.parse(fs.readFileSync(newResult, 'utf8'));
const keys = new Set([...Object.keys(lt.finalVm), ...Object.keys(nr.finalVm)]);
const vmDiff = [...keys].filter((k) => lt.finalVm[k] !== nr.finalVm[k]);
console.log('最终参数一致:', vmDiff.length === 0, vmDiff.map((k) => `${k}: ${lt.finalVm[k]} / ${nr.finalVm[k]}`).join(', '));
console.log('步数', lt.calls, nr.calls, '验收门', JSON.stringify(lt.gateLog.map((g) => [g.stage, g.keep])) === JSON.stringify(nr.gateLog.map((g) => [g.stage, g.keep])) ? '一致' : `不一致 ${JSON.stringify(lt.gateLog.map((g) => [g.stage, g.keep]))} / ${JSON.stringify(nr.gateLog.map((g) => [g.stage, g.keep]))}`, '| 新流程 endedBy', nr.endedBy, '降级', JSON.stringify(nr.degrades), '阶段', nr.stageIds.join(','));
