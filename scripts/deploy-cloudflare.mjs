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
/* 澄曜 API（api.ruseo.cn）无 CORS 头，浏览器内跨域 fetch 被拦截 ——
   这里提供同源代理：服务端取数后回传，页内 fetch 同源无 CORS 问题。
   内存缓存 60s，降低对免费上游（100 次/分钟）的调用频率。 */
const CACHE = new Map();
const TTL = 60 * 1000;
const RUSEO_TX = 'https://api.ruseo.cn/api/tx?type=1&imgtype=0';
const RUSEO_SOUP = 'https://api.ruseo.cn/api/poison_soup';

async function cached(key, fn) {
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.val;
  const val = await fn();
  CACHE.set(key, { t: Date.now(), val });
  return val;
}
async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('upstream ' + r.status);
  return r.json();
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;
    const J = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });

    if (p === "/vendor/mp4-muxer.min.js") {
      return new Response(MUXER, { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=86400" } });
    }
    if (p === "/healthz") return new Response("ok");

    // 毒鸡汤代理（JSON）：{ content: "..." }
    if (p === "/api/ruseo/poison_soup") {
      try {
        const j = await cached('soup', () => fetchJson(RUSEO_SOUP));
        const content = j && j.data && j.data.content;
        if (!content) return J({ error: "no content" }, 502);
        return J({ content });
      } catch (e) {
        return J({ error: String(e && e.message || e) }, 502);
      }
    }

    // 随机头像代理（二进制图片）：服务端调 tx 拿图片地址后取图回传
    if (p === "/api/ruseo/tx-img") {
      try {
        const imgUrl = await cached('tx-url', async () => {
          const j = await fetchJson(RUSEO_TX);
          const u = j && j.data && j.data.msg;
          if (!u) throw new Error("no img url");
          return u;
        });
        const img = await fetch(imgUrl);
        if (!img.ok) throw new Error("img " + img.status);
        return new Response(img.body, { headers: { "content-type": img.headers.get("content-type") || "image/jpeg", "cache-control": "no-store" } });
      } catch (e) {
        return J({ error: String(e && e.message || e) }, 502);
      }
    }

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
