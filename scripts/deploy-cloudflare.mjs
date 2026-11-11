#!/usr/bin/env node
/**
 * 部署到 Cloudflare Workers（x.jiuyeke.cn）
 * ------------------------------------------------------------
 * 原理：把 index.html 与 vendor/mp4-muxer.min.js 内联进一个
 * ES Module Worker（JSON.stringify 安全转义），整体上传；
 * 自定义域名通过 Cloudflare Workers Custom Domains 绑定
 * （会自动接管 zone 下的 DNS 记录）。
 *
 * 凭证来源（二选一）：
 *   1. 环境变量 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN
 *   2. ~/.cloudflare/load-jiuyeke.sh（source 风格的 KEY="value" 文件）
 *
 * 用法：
 *   node scripts/deploy-cloudflare.mjs            # 部署 Worker
 *   node scripts/deploy-cloudflare.mjs --domain   # 部署并绑定 x.jiuyeke.cn
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const WORKER_NAME = 'x-post-video';
const HOSTNAME = 'x.jiuyeke.cn';

function loadCreds() {
  let acc = process.env.CLOUDFLARE_ACCOUNT_ID;
  let token = process.env.CLOUDFLARE_API_TOKEN;
  let zoneId = process.env.CF_ZONE_ID;
  const shPath = path.join(os.homedir(), '.cloudflare', 'load-jiuyeke.sh');
  if ((!acc || !token) && fs.existsSync(shPath)) {
    const sh = fs.readFileSync(shPath, 'utf8');
    const grab = (k) => (sh.match(new RegExp(k + '="([^"]+)"')) || [])[1];
    acc = acc || grab('CLOUDFLARE_ACCOUNT_ID');
    token = token || grab('CLOUDFLARE_API_TOKEN');
    zoneId = zoneId || grab('CF_ZONE_ID');
  }
  if (!acc || !token) {
    console.error('缺少凭证：请设置 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN 环境变量，或提供 ~/.cloudflare/load-jiuyeke.sh');
    process.exit(1);
  }
  return { acc, token, zoneId };
}

function buildWorker() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const muxerPath = path.join(ROOT, 'vendor', 'mp4-muxer.min.js');
  const muxer = fs.existsSync(muxerPath) ? fs.readFileSync(muxerPath, 'utf8') : '';
  return `const HTML = ${JSON.stringify(html)};
const MUXER = ${JSON.stringify(muxer)};
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (p === "/vendor/mp4-muxer.min.js") {
      return new Response(MUXER, { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=86400" } });
    }
    if (p === "/healthz") return new Response("ok");
    return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  }
};
`;
}

async function api(token, url, options = {}) {
  const res = await fetch(url, { ...options, headers: { Authorization: 'Bearer ' + token, ...(options.headers || {}) } });
  return res.json();
}

const { acc, token, zoneId } = loadCreds();
const worker = buildWorker();
console.log(`Worker 体积：${(worker.length / 1024).toFixed(1)} KB`);

// 1) 上传 Worker（multipart：metadata + 模块）
const md = { main_module: 'worker.js', compatibility_date: '2025-01-01' };
const form = new FormData();
form.append('metadata', new Blob([JSON.stringify(md)], { type: 'application/json' }));
form.append('worker.js', new Blob([worker], { type: 'application/javascript+module' }), 'worker.js');
const deploy = await api(token, `https://api.cloudflare.com/client/v4/accounts/${acc}/workers/scripts/${WORKER_NAME}`, { method: 'PUT', body: form });
if (!deploy.success) {
  console.error('部署失败：', JSON.stringify(deploy.errors));
  process.exit(1);
}
console.log(`✅ Worker 已部署：${WORKER_NAME}（modified ${deploy.result.modified_on}）`);

// 2) 可选：绑定自定义域名
if (process.argv.includes('--domain')) {
  if (!zoneId) { console.error('缺少 CF_ZONE_ID，无法绑定域名'); process.exit(1); }
  const bind = await api(token, `https://api.cloudflare.com/client/v4/accounts/${acc}/workers/domains`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ zone_id: zoneId, hostname: HOSTNAME, service: WORKER_NAME, environment: 'production' })
  });
  if (!bind.success) { console.error('域名绑定失败：', JSON.stringify(bind.errors)); process.exit(1); }
  console.log(`✅ 自定义域名已绑定：https://${HOSTNAME}/`);
}

console.log('验证：curl https://' + HOSTNAME + '/healthz');
