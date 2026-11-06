// v17 离线验证第一段：从 lab 页面导出各项目的模板默认贴图、项目原贴图、主图虹膜框（不调用模型）
import fs from 'node:fs';
import { openLab, projectInput, readJson } from './lab.mjs';
const OUT = '/tmp/vm17/off';
const med = (v) => { v = v.filter(Number.isFinite).sort((a, b) => a - b); return v[v.length >> 1]; };
const P = (pts, n, i) => med(pts.map((p) => p?.[n]?.[i]));
const raw = readJson('results/metric-check/raw.json');
const PTS = { ...Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.master])), 'e2e-dfb3bc24-86fd-4619-b6e3-f85e1fcc4e29': JSON.parse(fs.readFileSync('/tmp/master-pts.json', 'utf8')) };
const IDS = ['1cf5ecc9-873b-4a81-9595-2e2672a9b3c7', '41e01792-7a2c-4ce2-801d-704c1e08f4e7', '9ee088da-1409-477e-9cf4-1959c79293db', 'e2e-dfb3bc24-86fd-4619-b6e3-f85e1fcc4e29', 'e2e-5e170e65-4f1e-49ea-818d-ab6c79dfe176'];
const lab = await openLab();
try {
  for (const id of IDS) {
    const key = id.replace('e2e-', '').slice(0, 8);
    const info = await lab.call('loadProject', projectInput(id)); await lab.call('loadMaster');
    const tpl = await lab.call('templateTextures'), snap = await lab.call('textureSnapshot');
    const out = { id, riv: info?.rivFilename ?? null, template: tpl, original: snap };
    const pts = PTS[id];
    if (pts) {
      const { W, H } = await lab.call('masterForPoints'), dim = await lab.call('masterSize'), s = dim.w / W;
      const box = ['eye_l_outer', 'eye_l_top', 'eye_l_inner', 'eye_l_bottom'].map((n, i) => P(pts, n, i % 2 ? 1 : 0) * s);
      out.eye = await lab.call('eyeMaster', [Math.min(box[0], box[2]), box[1], Math.max(box[0], box[2]), box[3]]);
      out.masterScale = s;
    }
    fs.writeFileSync(`${OUT}/${key}.json`, JSON.stringify(out));
    console.log(key, 'riv', out.riv, 'template', Object.keys(tpl).length, 'original', Object.keys(snap).length, 'eye', out.eye ? JSON.stringify({ box: out.eye.box, irisW: out.eye.irisW, irisRow: out.eye.irisRow }) : '-');
  }
} finally { await Promise.race([lab.close(), new Promise((o) => setTimeout(o, 10000))]); }
process.exit(0);
