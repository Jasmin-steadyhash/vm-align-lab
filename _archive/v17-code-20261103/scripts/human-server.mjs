// 人工标注网页的本地服务：静态文件来自 results/human，POST /save 把标注写到 results/human/labels.json
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { labPath } from './lab.mjs';
const ROOT = labPath('results/human');
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };
http.createServer((req, res) => {
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
