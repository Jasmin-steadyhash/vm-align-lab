// 本地 D1：建 lab 专用租户/账号，把选中的线上项目（只读拷下来的）写进去，签一个本地 JWT 存 data/token.txt。只写本地 .wrangler/
import fs from 'node:fs';
import crypto from 'node:crypto';

const TENANT = 'lab-tenant-vm-align', USER = 'lab-user-vm-align', EMAIL = 'vm-align-lab@local.test';
const devVars = fs.readFileSync('../.dev.vars', 'utf8');
const secret = devVars.match(/^SESSION_SECRET=(.*)$/m)?.[1]?.trim() || 'dev-secret-change-me';
const projects = JSON.parse(fs.readFileSync('data/projects.json', 'utf8'));
const q = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const now = new Date().toISOString();
const sql = [
  `INSERT OR IGNORE INTO tenants (id, name, slug, owner_user_id, created_at, updated_at) VALUES (${q(TENANT)}, 'vm-align-lab', 'vm-align-lab', ${q(USER)}, ${q(now)}, ${q(now)});`,
  // 密码随便填：只用签名 token 登录
  `INSERT OR IGNORE INTO users (id, tenant_id, email, password_hash, password_salt, created_at, updated_at) VALUES (${q(USER)}, ${q(TENANT)}, ${q(EMAIL)}, 'x', 'x', ${q(now)}, ${q(now)});`,
];
for (const p of Object.values(projects)) {
  sql.push(`INSERT OR REPLACE INTO projects (id, tenant_id, user_id, name, riv_template_key, draft_state_json, status, created_at, updated_at, main_image, main_image_history) VALUES (${q(p.id)}, ${q(TENANT)}, ${q(USER)}, ${q(p.name)}, ${q(p.riv_template_key)}, ${q(p.draft_state_json)}, 'draft', ${q(now)}, ${q(p.updated_at)}, ${q(p.main_image)}, ${q(p.main_image_history)});`);
}
fs.writeFileSync('data/seed.sql', sql.join('\n'));

const b64u = (b) => Buffer.from(b).toString('base64url');
const nowS = Math.floor(Date.now() / 1000);
const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const body = b64u(JSON.stringify({ sub: USER, tenantId: TENANT, email: EMAIL, iat: nowS, exp: nowS + 30 * 86400 }));
const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
fs.writeFileSync('data/token.txt', `${head}.${body}.${sig}`);
console.log('seed statements', sql.length);
