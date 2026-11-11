// MCP HTTP 模式端到端测试客户端
// 用法：先启动 HTTP server（node mcp/server.mjs --http 3001），再 node mcp/test-client.mjs
import fs from 'node:fs';

const BASE = 'http://localhost:3001/mcp';
const KEY = process.env.MCP_API_KEY || '18596950010';
const HEADERS = {
  'content-type': 'application/json',
  'Accept': 'application/json, text/event-stream',
  'Authorization': 'Bearer ' + KEY
};

async function rpc(id, method, params) {
  const res = await fetch(BASE, {
    method: 'POST', headers: HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  });
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) {
    const text = await res.text();
    const line = text.split('\n').find(l => l.startsWith('data:'));
    return JSON.parse(line.slice(5));
  }
  return res.json();
}

const results = [];
const t = (name, ok, detail) => results.push((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));

// 1) tools/list
const list = await rpc(1, 'tools/list');
t('tools/list', list.result && list.result.tools.length === 3,
  list.result ? list.result.tools.map(x => x.name).join(',') : JSON.stringify(list).slice(0, 120));

// 2) 本地图片 + 本地音乐
const call1 = await rpc(2, 'tools/call', {
  name: 'generate_video',
  arguments: { image: 'D:/game/test-output/mcp-test-image.png', music: 'D:/game/test-output/test-tone-3s.wav', duration: 10, theme_bg: '#0a0e13', filename: 'mcp-e2e-local' }
});
const r1 = JSON.parse(call1.result.content[0].text);
t('本地图+音乐生成', !call1.result.isError && r1.file.endsWith('.mp4'), JSON.stringify(r1).slice(0, 200));

// 3) data URL 图片
const dataUrl = 'data:image/png;base64,' + fs.readFileSync('D:/game/test-output/mcp-test-image.png').toString('base64');
const call2 = await rpc(3, 'tools/call', {
  name: 'generate_video',
  arguments: { image: dataUrl, duration: 3, filename: 'mcp-e2e-dataurl' }
});
const r2 = JSON.parse(call2.result.content[0].text);
t('data URL 图片生成', !call2.result.isError && r2.size_mb > 0, JSON.stringify(r2).slice(0, 200));

// 4) 错误输入优雅处理
const call3 = await rpc(4, 'tools/call', { name: 'generate_video', arguments: { image: 'D:/not-exist-image.png' } });
t('错误输入优雅处理', call3.result.isError === true, call3.result.content[0].text.slice(0, 80));

// 5) list_outputs
const outs = await rpc(5, 'tools/call', { name: 'list_outputs', arguments: {} });
const outList = JSON.parse(outs.result.content[0].text);
t('list_outputs', Array.isArray(outList) && outList.length >= 2, outList.length + ' 个文件');

console.log(results.join('\n'));
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
