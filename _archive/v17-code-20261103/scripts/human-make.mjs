// 人工标注第 0 轮：20 组（3 项目 × 不同版本 / 分数段，含眉眼距离有争议的）+ 3 组重复，渲染高清整图对比（主图 | riv，同评审的取景），
// 打乱顺序、匿名编号存 results/human/img/NN.png；编号 → 项目/版本的对应只存 results/human/key.json（网页不读）
import fs from 'node:fs';
import { openLab, projectInput, writeJson, labPath } from './lab.mjs';
import { startVmOf } from './start-vm.mjs';

const PICK = {
  '9ee088da-1409-477e-9cf4-1959c79293db': ['agent/v6', 'start', 'agent/v11b', 'agent/v11', 'agent/v10', 'agent/v12', 'agent/v9'],
  '41e01792-7a2c-4ce2-801d-704c1e08f4e7': ['agent/v5', 'start', 'agent/v12b', 'agent/v11b', 'agent/v10', 'agent/v12', 'agent/v11'],
  '1cf5ecc9-873b-4a81-9595-2e2672a9b3c7': ['start', 'agent/v10b', 'agent/v11b', 'agent/v12b', 'agent/v11', 'agent/v9'],
};
const DUP = [['41e01792-7a2c-4ce2-801d-704c1e08f4e7', 'agent/v11b'], ['9ee088da-1409-477e-9cf4-1959c79293db', 'agent/v11'], ['1cf5ecc9-873b-4a81-9595-2e2672a9b3c7', 'agent/v11']];
const list = [...Object.entries(PICK).flatMap(([id, ms]) => ms.map((m) => [id, m])), ...DUP];
// 固定种子打乱，重复的两份不相邻
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const order = list.map((x, i) => [rnd(), i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
const key = [];
const lab = await openLab();
try {
  for (let n = 0; n < order.length; n++) {
    const [id, method] = list[order[n]];
    const info = await lab.call('loadProject', projectInput(id));
    await lab.call('loadMaster');
    const start = { ...startVmOf(info.savedVm, await lab.call('tunableParams')), Head_scale: 100 };
    const dir = labPath(`results/${method}/${id.slice(0, 8)}`);
    const vm = method === 'start' ? start : JSON.parse(fs.readFileSync(`${dir}/trace.json`, 'utf8')).finalVm;
    if (method !== 'start' && fs.existsSync(`${dir}/textures.json`)) await lab.call('restoreTextures', JSON.parse(fs.readFileSync(`${dir}/textures.json`, 'utf8')));
    await lab.call('freezeFrame', start);
    const no = String(n + 1).padStart(2, '0');
    fs.writeFileSync(labPath(`results/human/img/${no}.png`), Buffer.from(await lab.call('obsPair', vm, [0, 0, 1, 1], 900), 'base64'));
    key.push({ no, id: id.slice(0, 8), method, dup: order[n] >= list.length - DUP.length });
    console.log(no, id.slice(0, 8), method);
  }
} finally { await lab.close(); }
writeJson('results/human/key.json', key);
