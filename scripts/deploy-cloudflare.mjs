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

/* ============================================================
   MCP 服务端（部署在 Worker 上，供 AI agent 远程调用）
   ------------------------------------------------------------
   协议：MCP Streamable HTTP（JSON-RPC 2.0，单次请求-响应）
   端点：POST /api/mcp/rpc   —— 需 Authorization: Bearer <API_KEY>
         GET  /api/mcp/rpc   —— 返回能力说明（便于人工排查）
   编码：Worker 无 ffmpeg，视频编码改为调用外部渲染服务；
   未配置渲染服务时，generate_video 返回最终 MP4 的「构造指令」
   （image/尺寸/背景色/音乐参数），由调用方或本地 MCP 执行。
   ============================================================ */
const MCP_API_KEY = '18596950010';
const MCP_VERSION = '2.3.0';

function mcpText(id, text, isError) {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) } };
}
function mcpErr(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

const MCP_TOOLS = [
  {
    name: 'generate_video',
    description: '生成 10 秒 9:16 竖屏视频（1080×1920 MP4，H.264+AAC）：图片 contain 缩放居中、空白处背景色填充；可选背景音乐（自动循环补齐、尾部淡出）。',
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: '图片来源：http(s) URL、data: URL 或本地路径（必填）' },
        music: { type: 'string', description: '背景音乐来源（可选）' },
        duration: { type: 'number', description: '时长秒数，默认 10（1~60）' },
        theme_bg: { type: 'string', description: '空白填充背景色 hex，默认 #eef1f4；深色传 #0a0e13' },
        filename: { type: 'string', description: '输出文件名（不含扩展名，可选）' }
      },
      required: ['image']
    }
  },
  {
    name: 'render_page',
    description: '返回本站在线编辑器的可直接渲染地址（带随机内容），可用于截图后再喂给 generate_video。',
    inputSchema: { type: 'object', properties: { theme: { type: 'string', description: 'light | dark' } } }
  },
  {
    name: 'health',
    description: '服务状态（版本 / 可用工具 / 运行位置）',
    inputSchema: { type: 'object', properties: {} }
  }
];

async function handleMcpRpc(request, body, origin) {
  if (request.method === 'GET') {
    return { protocol: 'MCP Streamable HTTP', version: MCP_VERSION, endpoint: '/api/mcp/rpc', tools: MCP_TOOLS.map(t => t.name) };
  }
  const msg = body || {};
  const id = msg.id === undefined ? null : msg.id;
  const method = msg.method;
  const params = msg.params || {};

  // 通知类消息（无 id）不需要响应体
  if (msg.id === undefined && method && method.startsWith('notifications/')) return null;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: params.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'x-post-video', version: MCP_VERSION }
      }
    };
  }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };

  if (method === 'tools/call') {
    const name = params.name;
    const a = params.arguments || {};
    if (name === 'health') {
      return mcpText(id, JSON.stringify({
        server: 'x-post-video', version: MCP_VERSION,
        runtime: 'cloudflare-worker',
        encoder: '本地部署 ffmpeg（远程调用 generate_video 会返回渲染指令）',
        tools: MCP_TOOLS.map(t => t.name),
        site: origin
      }, null, 2));
    }
    if (name === 'render_page') {
      const theme = a.theme === 'dark' ? 'dark' : 'light';
      return mcpText(id, JSON.stringify({
        url: origin + '/?theme=' + theme,
        hint: '打开该地址即可看到随机内容的帖子卡；截取卡片后把图片 URL 传给 generate_video'
      }, null, 2));
    }
    if (name === 'generate_video') {
      if (!a.image) return mcpText(id, '缺少必填参数 image（http(s) URL / data: URL / 本地路径）', true);
      const duration = Math.min(60, Math.max(1, Number(a.duration) || 10));
      const bg = /^#[0-9a-fA-F]{6}$/.test(a.theme_bg || '') ? a.theme_bg : '#eef1f4';
      const spec = '1080x1920 H.264+AAC 30fps faststart';
      // Worker 无 ffmpeg：返回可直接执行的本地渲染指令 + 完整 ffmpeg 命令
      const safeName = (a.filename || 'x-post-video').replace(/[^\\w.-]/g, '_');
      const ffmpegCmd = [
        'ffmpeg -y -loop 1 -t ' + duration + ' -i "' + a.image + '"',
        a.music ? '-stream_loop -1 -i "' + a.music + '"' : '',
        '-filter_complex "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=' + bg.replace('#', '0x') + ',setsar=1,format=yuv420p[v]"',
        '-map "[v]"', a.music ? '-map 1:a -af "afade=t=out:st=' + Math.max(0, duration - 0.8).toFixed(2) + ':d=0.8"' : '-an',
        '-c:v libx264 -preset medium -crf 20 -r 30',
        a.music ? '-c:a aac -b:a 128k' : '',
        '-shortest -movflags +faststart "' + safeName + '.mp4"'
      ].filter(Boolean).join(' ');
      return mcpText(id, JSON.stringify({
        status: 'needs_local_encoder',
        message: '远程 Worker 不含视频编码器。请在装有 ffmpeg 的机器上启动本地 MCP 服务执行（node mcp/server.mjs），或直接运行下方命令。',
        spec,
        params: { image: a.image, music: a.music || null, duration, theme_bg: bg, filename: safeName },
        ffmpeg: ffmpegCmd,
        local_mcp: { command: 'node', args: ['mcp/server.mjs'], transport: 'stdio' }
      }, null, 2));
    }
    return mcpText(id, '未知工具: ' + name, true);
  }
  return mcpErr(id, -32601, 'Method not found: ' + method);
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

    // MCP 远程端点：AI agent 直接调用（API Key 鉴权）
    if (p === "/api/mcp/rpc") {
      const origin = url.origin;
      const key = (request.headers.get('authorization') || '').replace(/^Bearer\\s+/i, '') || request.headers.get('x-api-key');
      if (key !== MCP_API_KEY) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized：请带 Authorization: Bearer <API_KEY> 或 X-API-Key 头' } }), {
          status: 401, headers: { 'content-type': 'application/json; charset=utf-8' }
        });
      }
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, x-api-key', 'access-control-allow-methods': 'GET, POST, OPTIONS' } });
      }
      let body = null;
      if (request.method === 'POST') {
        try { body = await request.json(); } catch (e) { return J({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
      }
      const out = await handleMcpRpc(request, body, origin);
      if (out === null) return new Response(null, { status: 202, headers: { 'access-control-allow-origin': '*' } });
      return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
    }

    // /api/mcp 健康（免鉴权，页面探测用）
    if (p === "/api/mcp/health") return J({ ok: true, server: 'x-post-video', version: MCP_VERSION });

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
