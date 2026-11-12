#!/usr/bin/env node
/**
 * 部署到 here.now（{slug}.here.now）
 * ------------------------------------------------------------
 * here.now 三步发布流程：
 *   1) POST   /api/v1/publish              创建/更新（返回每份文件的预签名上传地址）
 *   2) PUT    {presigned url}              上传文件字节
 *   3) POST   {finalizeUrl}                带 {"versionId"} 结算，站点上线
 *
 * API Key 来源（二选一）：
 *   1. 环境变量 HERENOW_API_KEY
 *   2. ~/.herenow/credentials 文件（单行 Key）
 * 无 Key 会创建 24 小时过期的匿名站点；有 Key 为永久站点。
 *
 * 用法：
 *   node scripts/deploy-herenow.mjs                        # 新建（随机 slug）
 *   node scripts/deploy-herenow.mjs my-slug                # 新建/更新指定 slug
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const BASE = 'https://here.now';

function loadKey() {
  if (process.env.HERENOW_API_KEY) return process.env.HERENOW_API_KEY;
  const credPath = path.join(os.homedir(), '.herenow', 'credentials');
  if (fs.existsSync(credPath)) return fs.readFileSync(credPath, 'utf8').trim();
  console.error('缺少 API Key：设置 HERENOW_API_KEY 或写入 ~/.herenow/credentials');
  process.exit(1);
}

function walk(dir, prefix = '') {
  // 只发布站点所需资源：排除 node_modules / outputs / .git / docs 等，
  // 否则这里会把本地依赖（数千文件）一起算进 Site 版本（上限 2500 文件）
  const SKIP_DIRS = new Set(['node_modules', '.git', 'outputs', 'logs', '.herenow', 'docs', 'mcp', 'scripts']);
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    const rel = prefix ? prefix + '/' + e.name : e.name;
    if (e.isDirectory()) out = out.concat(walk(full, rel));
    else if (!/^(package(-lock)?\.json|\.gitignore|LICENSE|README\.md)$/.test(e.name)) out.push({ full, rel, size: fs.statSync(full).size });
  }
  return out;
}

const KEY = loadKey();
const SLUG = process.argv[2];
const files = walk(ROOT);
console.log('发布文件：', files.map(f => `${f.rel}(${f.size}B)`).join(', '));

const headers = { authorization: 'Bearer ' + KEY, 'content-type': 'application/json', 'x-herenow-client': 'zcode' };

// 1) 创建或更新
const url = SLUG ? `${BASE}/api/v1/publish/${SLUG}` : `${BASE}/api/v1/publish`;
const method = SLUG ? 'PUT' : 'POST';
const cr = await fetch(url, {
  method, headers,
  body: JSON.stringify({ files: files.map(f => ({ path: f.rel, size: f.size })) })
});
const cj = await cr.json();
if (!cr.ok) {
  console.error('创建/更新失败：', cr.status, JSON.stringify(cj).slice(0, 500));
  process.exit(1);
}
const slug = cj.slug;
console.log(`${SLUG ? '更新' : '创建'}成功，slug: ${slug}`);

// 2) 上传文件
const up = cj.upload || cj;
for (const f of files) {
  const target = (up.uploads || []).find(u => (u.path || u.name) === f.rel);
  if (!target) { console.error('缺少上传目标：', f.rel); process.exit(1); }
  const put = await fetch(target.url, { method: 'PUT', body: fs.readFileSync(f.full) });
  if (!put.ok) { console.error('上传失败：', f.rel, put.status); process.exit(1); }
  console.log('已上传', f.rel);
}

// 3) 结算上线
const fu = up.finalizeUrl;
const fr = await fetch(fu.startsWith('http') ? fu : BASE + fu, {
  method: 'POST', headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' },
  body: JSON.stringify({ versionId: up.versionId })
});
const fj = await fr.json();
console.log('✅ 站点上线：', fj.siteUrl || cj.siteUrl, '（' + (fj.isLive ? 'live' : 'pending') + '）');
