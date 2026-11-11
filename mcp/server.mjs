#!/usr/bin/env node
/**
 * X 帖子视频 MCP Server
 * ============================================================
 * 让 AI agent 直接调用生成 10 秒竖屏视频（1080×1920 H.264+AAC MP4）。
 * 编码走本机 ffmpeg（与网页版 WebCodecs 产物规格一致）：
 *   - 图片 contain 缩放居中，空白处用主题背景色填充
 *   - 背景音乐不足时长自动循环，尾部 0.8s 淡出，AAC 128k
 *
 * 传输模式：
 *   1) stdio（默认）   —— Claude Desktop / ZCode 等 MCP 客户端标准接入
 *   2) HTTP (--http 端口) —— 远程 agent 调用；所有请求需鉴权：
 *        Authorization: Bearer <API_KEY>  或  X-API-Key: <API_KEY>
 *      API Key 来源：环境变量 MCP_API_KEY，默认 18596950010
 *
 * 工具（tools）：
 *   generate_video  生成视频（image 必填；music/duration/theme_bg 可选）
 *   list_outputs    列出已生成的视频文件
 *   health          服务状态
 *
 * 用法：
 *   node mcp/server.mjs               # stdio 模式
 *   node mcp/server.mjs --http 3001   # HTTP 模式（含鉴权）
 * ============================================================ */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import express from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

const API_KEY = process.env.MCP_API_KEY || '18596950010';
const PORT = Number(process.argv[process.argv.indexOf('--http') + 1] || 0) || (process.argv.includes('--http') ? 3001 : 0);
const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const OUTPUT_DIR = path.join(ROOT, 'outputs');
const SPEC = { width: 1080, height: 1920, fps: 30 };
const DEFAULT_BG = '#eef1f4';
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

/* ---------- 工具：输入解析 ---------- */

/** image/music 参数 → 本地文件路径（支持 data URL / http(s) URL / 本地路径） */
async function resolveInput(v, kind) {
  if (typeof v === 'string' && v.startsWith('data:')) {
    const m = v.match(/^data:([^;]+);base64,(.*)$/s);
    if (!m) throw new Error('data URL 格式无效');
    const tmp = path.join(os.tmpdir(), `mcp-${kind}-${randomUUID()}${extOf(m[1])}`);
    fs.writeFileSync(tmp, Buffer.from(m[2], 'base64'));
    return tmp;
  }
  if (/^https?:\/\//i.test(v)) {
    const res = await fetch(v);
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    const tmp = path.join(os.tmpdir(), `mcp-${kind}-${randomUUID()}${extOf(res.headers.get('content-type') || '')}`);
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    return tmp;
  }
  const p = path.resolve(v.replace(/^~(?=$|[/\\])/, os.homedir()));
  if (!fs.existsSync(p)) throw new Error(`文件不存在: ${p}`);
  return p;
}
function extOf(mime) {
  if (!mime) return kind2ext('bin');
  if (mime.includes('png')) return '.png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('gif')) return '.gif';
  if (mime.includes('mp3') || mime.includes('mpeg')) return '.mp3';
  if (mime.includes('wav')) return '.wav';
  if (mime.includes('ogg')) return '.ogg';
  if (mime.includes('m4a') || mime.includes('mp4')) return '.m4a';
  if (mime.includes('flac')) return '.flac';
  return kind2ext('bin');
}
function kind2ext(k) { return k === 'bin' ? '.bin' : '.bin'; }

/** ffmpeg 可执行文件定位：PATH / 常见 winget 安装位置 */
function findFfmpeg() {
  for (const c of ['ffmpeg', 'ffmpeg.exe']) {
    try {
      const r = spawn(c, ['-version'], { stdio: 'ignore' });
      if (r.pid) { r.kill(); return c; }
    } catch (e) {}
  }
  const guesses = [
    path.join(os.homedir(), 'AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe')
  ];
  for (const g of guesses) if (fs.existsSync(g)) return g;
  throw new Error('未找到 ffmpeg，请安装：winget install Gyan.FFmpeg');
}

/* ---------- 工具：generate_video ---------- */

const GenerateVideoSchema = z.object({
  image: z.string().describe('图片来源：http(s) URL、data: URL 或本地文件路径'),
  music: z.string().optional().describe('背景音乐来源（同上），可选。不足时长自动循环，尾部 0.8s 淡出'),
  duration: z.number().min(1).max(60).default(10).describe('视频时长（秒），默认 10'),
  theme_bg: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#eef1f4').describe('空白处填充背景色（hex），默认浅色 #eef1f4，深色可传 #0a0e13'),
  filename: z.string().optional().describe('输出文件名（不含扩展名），默认按时间戳生成')
});

async function generateVideo(args) {
  const input = GenerateVideoSchema.parse(args);
  const ffmpeg = findFfmpeg();
  const imgPath = await resolveInput(input.image, 'img');
  const musicPath = input.music ? await resolveInput(input.music, 'music') : null;

  const stamp = new Date();
  const p2 = (n) => (n < 10 ? '0' : '') + n;
  const name = (input.filename || `x-post-video-${stamp.getFullYear()}${p2(stamp.getMonth() + 1)}${p2(stamp.getDate())}-${p2(stamp.getHours())}${p2(stamp.getMinutes())}${p2(stamp.getSeconds())}`).replace(/[\\/:*?"<>|]/g, '_');
  const out = path.join(OUTPUT_DIR, name + '.mp4');

  const bg = input.theme_bg.replace('#', '0x');
  const fadeStart = Math.max(0, input.duration - 0.8);
  const filters = [
    `scale=${SPEC.width}:${SPEC.height}:force_original_aspect_ratio=decrease`,
    `pad=${SPEC.width}:${SPEC.height}:(ow-iw)/2:(oh-ih)/2:color=${bg}`,
    'setsar=1', 'format=yuv420p'
  ].join(',');

  const ffArgs = ['-y', '-loop', '1', '-t', String(input.duration), '-i', imgPath];
  if (musicPath) ffArgs.push('-stream_loop', '-1', '-i', musicPath);
  ffArgs.push(
    '-filter_complex', `[0:v]${filters}[v]`,
    '-map', '[v]'
  );
  if (musicPath) {
    ffArgs.push('-map', '1:a', '-af', `afade=t=out:st=${fadeStart.toFixed(2)}:d=0.8`);
  } else {
    ffArgs.push('-an');
  }
  ffArgs.push(
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-r', String(SPEC.fps),
    '-c:a', 'aac', '-b:a', '128k',
    '-shortest', '-movflags', '+faststart',
    out
  );

  const started = Date.now();
  await run(ffmpeg, ffArgs);
  const ms = Date.now() - started;

  if (!fs.existsSync(out) || fs.statSync(out).size < 1000) throw new Error('ffmpeg 未产出有效文件');
  const size = fs.statSync(out).size;
  // 清理临时文件
  if (imgPath.startsWith(os.tmpdir())) try { fs.unlinkSync(imgPath); } catch (e) {}
  if (musicPath && musicPath.startsWith(os.tmpdir())) try { fs.unlinkSync(musicPath); } catch (e) {}

  return {
    file: out,
    size_mb: +(size / 1024 / 1024).toFixed(2),
    duration_s: input.duration,
    spec: `${SPEC.width}x${SPEC.height} H.264+AAC ${SPEC.fps}fps faststart`,
    has_music: !!musicPath,
    encode_ms: ms
  };
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; if (err.length > 8000) err = err.slice(-4000); });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}\n${err.split('\n').slice(-6).join('\n')}`)));
  });
}

/* ---------- MCP Server 组装 ---------- */

const TOOLS = [
  {
    name: 'generate_video',
    description: '生成 10 秒 9:16 竖屏视频（1080×1920 MP4，H.264+AAC）：图片 contain 缩放居中、空白处背景色填充；可选背景音乐（自动循环补齐、尾部淡出）。返回输出文件路径。',
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: '图片来源：http(s) URL、data: URL 或本地文件路径（必填）' },
        music: { type: 'string', description: '背景音乐来源（URL/data URL/本地路径，可选）' },
        duration: { type: 'number', description: '时长秒数，默认 10（1~60）' },
        theme_bg: { type: 'string', description: '空白填充背景色 hex，默认 #eef1f4；深色主题传 #0a0e13' },
        filename: { type: 'string', description: '输出文件名（不含扩展名，可选）' }
      },
      required: ['image']
    }
  },
  {
    name: 'list_outputs',
    description: '列出已生成的视频文件（文件名/大小/修改时间）',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'health',
    description: '服务状态（版本/ffmpeg/输出目录）',
    inputSchema: { type: 'object', properties: {} }
  }
];

const server = new Server(
  { name: 'x-post-video', version: '2.2.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    let result;
    if (name === 'generate_video') result = await generateVideo(args || {});
    else if (name === 'list_outputs') {
      result = fs.readdirSync(OUTPUT_DIR)
        .filter(f => f.endsWith('.mp4'))
        .map(f => {
          const st = fs.statSync(path.join(OUTPUT_DIR, f));
          return { file: f, size_mb: +(st.size / 1024 / 1024).toFixed(2), modified: st.mtime.toISOString() };
        })
        .sort((a, b) => b.modified.localeCompare(a.modified));
    }
    else if (name === 'health') {
      result = {
        server: 'x-post-video', version: '2.2.0',
        ffmpeg: (() => { try { findFfmpeg(); return 'ok'; } catch (e) { return e.message; } })(),
        output_dir: OUTPUT_DIR,
        auth_mode: PORT ? `HTTP (API Key required)` : 'stdio (local)'
      };
    }
    else return { content: [{ type: 'text', text: `未知工具: ${name}` }], isError: true };

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `生成失败：${e.message}` }], isError: true };
  }
});

/* ---------- 启动 ---------- */

if (PORT) {
  const app = express();
  app.use(express.json({ limit: '80mb' }));

  // API Key 鉴权：health 之外的请求一律校验
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    const key = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'];
    if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized：请带 Authorization: Bearer <API_KEY> 或 X-API-Key 头' });
    next();
  });
  app.get('/health', (req, res) => res.json({ ok: true, server: 'x-post-video', version: '2.2.0' }));

  // Streamable HTTP：无状态模式（每请求独立会话），便于各类 agent 远程调用
  app.post('/mcp', async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.listen(PORT, () => {
    console.log(`[x-post-video MCP] HTTP 模式：http://localhost:${PORT}/mcp（鉴权已开启）`);
    console.log(`[x-post-video MCP] 健康检查：http://localhost:${PORT}/health（免鉴权）`);
  });
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[x-post-video MCP] stdio 模式已启动（输出目录 ${OUTPUT_DIR}）`);
}
