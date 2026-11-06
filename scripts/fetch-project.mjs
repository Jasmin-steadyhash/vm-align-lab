// 准备线上项目的 lab 数据：从线上 D1 只读拷项目和它引用的生成任务，下载实际用到的图片，缺模板时从仓库 rivs/ 复制。
// 产出 data/projects/<完整 id>/：project.json、jobs.json、img/（图片 + map.json：线上 URL → 文件名）；删项目 = 删这个目录
// 用法：node scripts/fetch-project.mjs <完整项目 id ...>（已有的项目重跑会覆盖 project.json / jobs.json，已下载的图片不重下）
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { labPath, writeJson } from './lab.mjs';

// 成对拆分的任务：加载时这些组件取步骤图（page/main.js STEP_FOR_ROLE，同 Studio 恢复），步骤图齐全就不用下载结果图
const PAIR_FINALS = { hair: ['back-final', 'front-final'], mouth: ['up-final', 'down-final'] };

const d1 = (sql) => {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'rive_ai_builder', '--remote', '--json', '--command', sql], { cwd: labPath('..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(out)[0].results;
};
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** 项目用到的图片 URL：主图、模板贴图引用、各任务的结果图（成对任务步骤图齐全时只取步骤图） */
function usedUrls(project, jobs) {
  const urls = new Set([project.main_image]);
  for (const x of Object.values(JSON.parse(project.draft_state_json || '{}').assetDrafts || {})) {
    if (x.templateRef) urls.add(x.templateRef);
    const j = x.jobId && jobs[x.jobId];
    if (!j) continue;
    const finals = JSON.parse(j.steps_json || '[]').filter((s) => /final$/.test(s.name));
    finals.forEach((s) => urls.add(s.url));
    const need = PAIR_FINALS[j.kind];
    if (!(need && need.every((n) => finals.some((s) => s.name === n))) && j.result_image_url) urls.add(j.result_image_url);
  }
  return [...urls].filter(Boolean);
}

for (const id of process.argv.slice(2)) {
  const [project] = d1(`SELECT id, tenant_id, name, riv_template_key, main_image, main_image_history, draft_state_json, updated_at FROM projects WHERE id = ${q(id)}`);
  if (!project) { console.error(id, '线上没有这个项目'); continue; }
  const jobIds = [...new Set(Object.values(JSON.parse(project.draft_state_json || '{}').assetDrafts || {}).map((x) => x.jobId).filter(Boolean))];
  const jobs = Object.fromEntries((jobIds.length ? d1(`SELECT id, mode, kind, meta_json, result_image_url, steps_json FROM generation_jobs WHERE id IN (${jobIds.map(q).join(',')})`) : []).map((j) => [j.id, j]));
  const dir = `data/projects/${id}`;
  fs.mkdirSync(labPath(`${dir}/img`), { recursive: true });
  writeJson(`${dir}/project.json`, project);
  writeJson(`${dir}/jobs.json`, jobs);

  const mapFile = labPath(`${dir}/img/map.json`);
  const map = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, 'utf8')) : {};
  let bytes = 0;
  const urls = usedUrls(project, jobs);
  for (const url of urls) {
    if (map[url] && fs.existsSync(labPath(`${dir}/img/${map[url]}`))) continue;
    const res = await fetch(url);
    if (!res.ok) { console.warn('fail', res.status, url); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    const name = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16) + '.' + (url.split('?')[0].split('.').pop() || 'png');
    fs.writeFileSync(labPath(`${dir}/img/${name}`), buf);
    map[url] = name;
    bytes += buf.length;
  }
  fs.writeFileSync(mapFile, JSON.stringify(map, null, 2));

  // 模板：多个项目共用，放 data/riv/；只在缺的时候从仓库 rivs/ 复制（仓库里的模板和线上 R2 同名同内容）
  const riv = project.riv_template_key, rivDst = labPath(`data/riv/${riv}`), rivSrc = labPath(`../rivs/${riv}`);
  const rivNote = fs.existsSync(rivDst) ? '模板已有' : fs.existsSync(rivSrc) ? (fs.copyFileSync(rivSrc, rivDst), '模板已从 rivs/ 复制') : `缺模板 ${riv}（rivs/ 里也没有，要从 R2 rive-ai-templates 下载）`;
  console.log(id.slice(0, 8), project.name, `| 任务 ${Object.keys(jobs).length}/${jobIds.length}`, `| 图片 ${urls.length}，新下载 ${(bytes / 1e6).toFixed(1)} MB`, '|', rivNote);
}
