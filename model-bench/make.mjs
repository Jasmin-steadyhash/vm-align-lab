// 生成评测题：以项目保存的参数为答案，每题改偏一个参数。
//   pick：主图 | 候选 1 | 候选 2（一个是答案、一个改偏），局部放大，问哪个更像主图
//   change：A | B 两张渲染（B = A 改偏一个参数），局部放大，问哪个部位怎么变了
// 题目存 model-bench/questions/，答案存 model-bench/questions.json
import fs from 'node:fs';
import { openLab, projectInput, labPath } from '../scripts/lab.mjs';

const PARAMS = {
  Head_Y: ['头部整体', '下移', 'headShoulder'], Body_scale: ['身体', '变大', 'headShoulder'], Body_Y: ['身体', '下移', 'headShoulder'],
  Face_scale: ['脸', '变大', 'face'], Face_Y: ['脸', '下移', 'face'], Hair_top_scale: ['前发', '变大', 'headShoulder'], Hair_top_Y: ['前发', '下移', 'headShoulder'],
  Hair_back_scale: ['后发', '变大', 'headShoulder'], Eye_R_Y: ['眼睛', '下移', 'eyes'], Eye_R_X: ['眼睛', '两侧向中间', 'eyes'],
  Eye_scale_X: ['眼睛', '变宽', 'eyes'], Eye_scale_Y: ['眼睛', '变高', 'eyes'], Eye_iris_scale: ['虹膜', '变大', 'leftEye'],
  Eye_iris_R_Y: ['虹膜', '下移', 'leftEye'], Mouth_Y: ['嘴', '下移', 'mouth'], Mouth_scale_X: ['嘴', '变宽', 'mouth'],
};
const OPP = { 下移: '上移', 变大: '变小', 两侧向中间: '两侧向外', 变宽: '变窄', 变高: '变扁' };
const ids = fs.readFileSync(labPath('data/dev-ids.txt'), 'utf8').trim().split('\n');
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
fs.mkdirSync(labPath('model-bench/questions'), { recursive: true });
const qs = [];
const lab = await openLab();
try {
  for (const id of ids) {
    const info = await lab.call('loadProject', projectInput(id));
    await lab.call('loadMaster');
    const specs = await lab.call('tunableParams');
    const truth = { ...info.savedVm, Head_scale: 100 };
    await lab.call('freezeFrame', truth);
    const boxes = await lab.call('partBoxes', truth);
    for (const [name, [part, dir, view]] of Object.entries(PARAMS)) {
      const sp = specs.find((p) => p.name === name);
      if (!sp) continue;
      for (const level of ['大', '细微']) {
        const frac = level === '大' ? 0.12 : 0.05;
        const sign = rnd() < 0.5 ? 1 : -1;
        const cur = truth[name] ?? sp.default;
        let v = cur + sign * frac * (sp.max - sp.min);
        if (v > sp.max || v < sp.min) v = cur - sign * frac * (sp.max - sp.min);
        v = Math.round(v / sp.step) * sp.step;
        const realSign = Math.sign(v - cur);
        const off = { ...truth, [name]: v };
        const box = boxes[view] ?? [0, 0, 1, 1];
        // pick
        const truthFirst = rnd() < 0.5;
        const p = await lab.call('obsCandidates', truthFirst ? [truth, off] : [off, truth], box, 420);
        const pid = `${id.slice(0, 8)}-${name}-${level}-pick`;
        fs.writeFileSync(labPath(`model-bench/questions/${pid}.png`), Buffer.from(p, 'base64'));
        qs.push({ id: pid, type: 'pick', level, param: name, answer: truthFirst ? 1 : 2 });
        // change
        const c = await lab.call('obsTwo', truth, off, box, 420);
        const cid = `${id.slice(0, 8)}-${name}-${level}-change`;
        fs.writeFileSync(labPath(`model-bench/questions/${cid}.png`), Buffer.from(c, 'base64'));
        qs.push({ id: cid, type: 'change', level, param: name, part, dir: realSign > 0 ? dir : OPP[dir] });
      }
    }
    console.log(id.slice(0, 8), 'questions so far', qs.length);
  }
} finally { await lab.close(); }
fs.writeFileSync(labPath('model-bench/questions.json'), JSON.stringify(qs, null, 2));
