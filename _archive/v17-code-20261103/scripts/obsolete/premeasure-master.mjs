// 方案 A 的主图分析预先算好存进本地 D1（vm_master_measures）：本机 forge 进程从线上 CDN 拉主图偶发超时，
// 这里用本地主图副本调 forge 同一套量法（forge/vmAlign.js runVmMeasure），模型走正在跑的本地 forge 接口，结果和 forge 自己量的一样
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readJson, labPath } from './lab.mjs';

const FORGE = 'http://localhost:3110';
const FORGE_KEY = fs.readFileSync(labPath('../forge/local.env'), 'utf8').match(/^FORGE_API_KEY=(.*)$/m)?.[1]?.trim() || '';
const require = createRequire(labPath('../forge/package.json'));
const sharp = require('sharp');
const { runVmMeasure } = await import(labPath('../forge/vmAlign.js'));
const { MEASURE_VERSION } = await import(labPath('../shared/vmAlign.js'));

const models = {
  async faceParse(rgba, width, height) {
    const png = await sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } }).png().toBuffer();
    const res = await fetch(`${FORGE}/face-parse`, { method: 'POST', body: png });
    if (!res.ok) throw new Error(`face-parse ${res.status}`);
    const j = await res.json();
    return { ...j, map: new Uint8Array(Buffer.from(j.map, 'base64')) };
  },
  async removeBg(bytes) {
    const res = await fetch(`${FORGE}/remove-bg`, { method: 'POST', body: bytes, headers: { 'Content-Type': 'image/png', ...(FORGE_KEY ? { Authorization: `Bearer ${FORGE_KEY}` } : {}) } });
    if (!res.ok) throw new Error(`remove-bg ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  },
};

const projects = readJson('data/projects.json');
const imgMap = readJson('data/img/map.json');
const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(projects);
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const sql = [];
for (const id of ids) {
  const p = projects[id];
  const bytes = fs.readFileSync(labPath(`data/img/${imgMap[p.main_image]}`));
  const out = await runVmMeasure({ images: { master: bytes.toString('base64') }, purpose: '主图分析' }, { models, log: (m) => console.log(id.slice(0, 8), m) });
  if (out.master?.error) { console.log(id.slice(0, 8), 'master error', out.master.error); continue; }
  sql.push(`INSERT OR REPLACE INTO vm_master_measures (project_id, tenant_id, master_sig, measure_json, updated_at) VALUES (${q(id)}, 'lab-tenant-vm-align', ${q(`${MEASURE_VERSION}|${p.main_image}`)}, ${q(JSON.stringify(out.master))}, ${q(new Date().toISOString())});`);
}
fs.writeFileSync(labPath('data/master-measures.sql'), sql.join('\n'));
execFileSync('npx', ['wrangler', 'd1', 'execute', 'rive_ai_builder', '--local', '--file', labPath('data/master-measures.sql')], { cwd: labPath('..'), stdio: 'ignore' });
console.log('stored', sql.length, 'of', ids.length);
