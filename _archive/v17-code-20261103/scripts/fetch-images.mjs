// 把选中项目用到的图片（主图、组件结果、头发/嘴巴步骤图、模板贴图）下载到 data/img，生成 URL → 本地文件的对照表
import fs from 'node:fs';
import crypto from 'node:crypto';

const projects = JSON.parse(fs.readFileSync('data/projects.json', 'utf8'));
const jobs = JSON.parse(fs.readFileSync('data/jobs.json', 'utf8'));
const urls = new Set();
for (const p of Object.values(projects)) {
  urls.add(p.main_image);
  const d = JSON.parse(p.draft_state_json);
  for (const x of Object.values(d.assetDrafts || {})) {
    if (x.templateRef) urls.add(x.templateRef);
    const j = x.jobId && jobs[x.jobId];
    if (!j) continue;
    if (j.result_image_url) urls.add(j.result_image_url);
    for (const s of JSON.parse(j.steps_json || '[]')) if (/final$/.test(s.name)) urls.add(s.url);
  }
}
const map = fs.existsSync('data/img/map.json') ? JSON.parse(fs.readFileSync('data/img/map.json', 'utf8')) : {};
let bytes = 0;
for (const url of urls) {
  if (map[url]) continue;
  const res = await fetch(url);
  if (!res.ok) { console.warn('fail', res.status, url); continue; }
  const buf = Buffer.from(await res.arrayBuffer());
  const name = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16) + '.' + (url.split('?')[0].split('.').pop() || 'png');
  fs.writeFileSync(`data/img/${name}`, buf);
  map[url] = name;
  bytes += buf.length;
}
fs.writeFileSync('data/img/map.json', JSON.stringify(map, null, 2));
console.log('urls', urls.size, 'downloaded MB', (bytes / 1e6).toFixed(1));
