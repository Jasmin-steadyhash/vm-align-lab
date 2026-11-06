// 贴图缺陷检查的测试集：收集出现过的每张组件贴图（项目原贴图、候选池、agent 运行中换上的），去重，
// 存 results/human/defect/tex/<编号>.png，清单 results/human/defect/items.json（编号 → 项目、组件、来源）
import fs from 'node:fs';
import crypto from 'node:crypto';
import { openLab, projectInput, readJson, writeJson, labPath } from './lab.mjs';
const ROLES = ['head', 'sclera', 'pupil', 'mouth_up', 'mouth_down', 'hair_front'];
const ids = fs.readFileSync(labPath('data/dev-ids.txt'), 'utf8').trim().split(/\s+/);
const dir = labPath('results/human/defect/tex');
fs.mkdirSync(dir, { recursive: true });
const items = [], seen = new Map();
const add = (p8, role, source, png) => {
  const h = crypto.createHash('md5').update(png).digest('hex');
  if (seen.has(h)) { seen.get(h).sources.push(source); return; }
  const it = { no: String(items.length + 1).padStart(3, '0'), id: p8, role, sources: [source] };
  fs.writeFileSync(`${dir}/${it.no}.png`, Buffer.from(png, 'base64'));
  items.push(it); seen.set(h, it);
};
const lab = await openLab();
try {
  for (const id of ids) {
    const p8 = id.slice(0, 8);
    await lab.call('loadProject', projectInput(id));
    const orig = await lab.call('roleTextures');
    const byAsset = Object.fromEntries(Object.entries(orig).map(([r, v]) => [v.assetId, r]));
    for (const r of ROLES) if (orig[r]) add(p8, r, 'original', orig[r].png);
    // 候选池（mouth 一张候选含上下唇两张贴图）
    const pool = labPath(`results/pool/${p8}`);
    for (const f of fs.existsSync(pool) ? fs.readdirSync(pool).sort() : []) {
      const c = JSON.parse(fs.readFileSync(`${pool}/${f}`, 'utf8'));
      for (const [aid, png] of Object.entries(c.textures)) if (byAsset[aid]) add(p8, byAsset[aid], `pool:${f.replace('.json', '')}`, png);
    }
    // agent 运行中换上的贴图（textures.json 里和原贴图不同的）
    for (const v of fs.readdirSync(labPath('results/agent')).sort()) {
      const tf = labPath(`results/agent/${v}/${p8}/textures.json`);
      if (!fs.existsSync(tf)) continue;
      const snap = JSON.parse(fs.readFileSync(tf, 'utf8'));
      for (const [aid, png] of Object.entries(snap)) { const r = byAsset[aid]; if (r && ROLES.includes(r) && png !== orig[r].png) add(p8, r, `agent:${v}`, png); }
    }
  }
} finally { await lab.close(); }
writeJson('results/human/defect/items.json', items);
const cnt = {}; for (const it of items) cnt[`${it.id} ${it.role}`] = (cnt[`${it.id} ${it.role}`] || 0) + 1;
console.log(items.length, 'textures'); console.log(cnt);
