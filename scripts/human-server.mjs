// 人工标注网页的本地服务：静态文件来自 results/human，POST /save 把标注写到 results/human/labels.json
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { labPath } from './lab.mjs';
const ROOT = labPath('results/human');
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };
http.createServer((req, res) => {
  // 人眼判断规则问卷（results/human/rules/index.html）：答案存 results/human/rules/answers.json，每次保存另留一份带时间的副本
  if (req.method === 'POST' && req.url === '/save-rules') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const text = JSON.stringify(JSON.parse(body), null, 2), dir = path.join(ROOT, 'rules');
      fs.writeFileSync(path.join(dir, 'answers.json'), text);
      fs.writeFileSync(path.join(dir, `answers-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), text);
      res.end('ok');
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/save') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { fs.writeFileSync(path.join(ROOT, 'labels.json'), JSON.stringify(JSON.parse(body), null, 2)); res.end('ok'); });
    return;
  }
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(ROOT) || p.endsWith('key.json') || !fs.existsSync(p)) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', TYPES[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
}).listen(5260, () => console.log('http://localhost:5260/'));
