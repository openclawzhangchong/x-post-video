# X 帖子卡片 → 10 秒竖屏视频 · 一键生成

纯前端单文件工具：编辑一条 X（Twitter）风格的帖子卡片，一键导出为图片，并**自动生成 10 秒 9:16 竖屏视频（1080×1920 MP4）**，支持背景音乐、深浅主题、Handle 打码等，可直接发抖音 / 快手 / 视频号 / 小红书。

## 在线体验

- **https://x.jiuyeke.cn/**（Cloudflare Workers 全球节点）
- **https://ebony-huckle-nww3.here.now/**（here.now 镜像）

> 两个地址部署同一份 `index.html`，功能完全一致。

## 功能特性

### 内容编辑（专家模式全量 / 简易模式极简）

- **简易模式（新手默认）**：只露出「昵称 / 正文 / 配图」三件事 + 一个绿色大按钮，三步出片：填正文 → 点「🎬 生成视频」→ 点「⬇ 下载视频」
- **专家模式**：完整编辑面板 20+ 字段（昵称、Handle、认证徽章、简介、粉丝/关注、互动数字、发布时间、配图、翻译卡…）
- **首次打开全随机**：昵称、Handle、简介、发布时间、互动数字、粉丝数每次刷新都换新（互动数字按大档位生成：点赞 5千~6万、粉丝 3万~500万，偏序关系正确）
- **互动数字官方风格缩写**：12000 → 「1.2万」，255826 → 「25.5万」，与 X 真实展示规则一致
- **Handle 智能跟随**：简易模式改昵称自动同步 Handle（中文用原文如 `@王小明`，英文转小写去空格）
- 头像三来源：字母占位 / 本地上传 / DiceBear 在线生成（生成式头像，不采集真人照片）
- 翻译演示卡：经典手动版（点「翻译帖子」展开）/ 2026 自动版（默认译文 + 显示原文切换）
- 帖子卡就地编辑：开启开关后双击正文直接改字，Esc 取消 / Ctrl+Enter 保存
- Handle 打码：预览与导出 PNG 同步把 `@Handle` 遮成马赛克条
- 深色 / 浅色双主题，导出图与视频空白处自动填充当前主题背景色
- 随机 / 恢复示例一键切换；结构标注（区域高亮）辅助理解布局

### 视频生成（核心）

- **不用等待实时录制**：WebCodecs（H.264 + AAC）+ mp4-muxer 离线编码，10 秒视频约 1~3 秒完成；老浏览器自动降级 MediaRecorder 实时录制
- **规格**：1080×1920（9:16 竖屏）· 30fps · H.264 High Profile · AAC 128kbps 立体声 · MP4（fastStart 便于流式播放）
- **背景音乐**：上传本地音频 → 不足 10 秒自动循环补齐 → 尾部 0.8 秒自动淡出 → 音量滑块可调（停止拖动 0.8 秒后自动重新生成）
- **成品预览**：生成完成后页面内 `<video>` 直接播放试听（含音乐），下载按钮即时可用
- **格式自适应**：浏览器不支持 MP4 编码时自动落 WebM 并匹配文件后缀
- 导出 PNG（2 倍分辨率）与视频一次生成：点「生成视频」即保存 PNG 并自动完成视频编码

## 快速开始

### 方式一：直接打开（零依赖）

双击 `index.html` 即可使用（单文件，无构建、无外链依赖；`vendor/mp4-muxer.min.js` 需与文件同级放置）。

### 方式二：本地服务

```bash
npx serve .          # 或 python -m http.server 8080
# 打开 http://localhost:8080
```

## 部署

### Cloudflare Workers（推荐，可绑自定义域名）

```bash
# 凭证：环境变量 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN，
#       或 ~/.cloudflare/load-jiuyeke.sh 风格的凭证文件
node scripts/deploy-cloudflare.mjs            # 部署 Worker
node scripts/deploy-cloudflare.mjs --domain   # 同时绑定 x.jiuyeke.cn
```

原理：`index.html` 与编解码库整体内联进 ES Module Worker（约 200 KB，远低于 1 MB 上限），无需对象存储。

### here.now

```bash
# 凭证：环境变量 HERENOW_API_KEY 或 ~/.herenow/credentials
node scripts/deploy-herenow.mjs               # 新建站点（随机 slug）
node scripts/deploy-herenow.mjs my-slug       # 新建/更新指定 slug
```

## 技术要点

| 主题 | 说明 |
|---|---|
| 视频编码 | WebCodecs `VideoEncoder`（avc1.64002a/42002a/420028 依次探测）+ `AudioEncoder`（AAC，opus 兜底探测）+ mp4-muxer 封装 |
| 音频处理 | `OfflineAudioContext` 统一完成裁剪 / 循环 / 音量 / 尾部淡出，再按 f32-planar 切块喂给编码器 |
| 导出图片 | SVG foreignObject + canvas 2 倍栅格化；样式全量内联，`@media` 自动跳过；克隆 DOM 不含 `body`，所有模式态样式带 `body.*` 前缀保证「屏幕所见 = 导出所得」 |
| 双模式架构 | 简易/专家共享同一套数据与渲染管线，仅靠 `body.simple-mode` class 显隐；专家模式行为与 v1 完全一致 |
| 导出防护 | 简易模式强制 `exportRange='post'`（主页卡被隐藏时克隆量高会为 0）；布局搬运（主题组）通过 DOM move 保留监听器 |
| 响应式 | 360px 无横向溢出；窄屏互动行按 X 官方规则缩写数字；`@media` 规则不进导出 SVG |
| 隐私 | 全部计算在浏览器本地完成；头像在线生成仅请求 DiceBear 生成式服务；不上传任何用户内容 |

## MCP Server（AI agent 直接生成视频）

内置 MCP（Model Context Protocol）服务器，AI agent（ZCode / Claude Desktop / 任何 MCP 客户端）可**直接调用工具生成视频**，无需人工操作网页。编码引擎为本机 ffmpeg，产物规格与网页版一致：1080×1920 · 9:16 · H.264+AAC · faststart。

### 启动

```bash
npm install                        # 首次安装依赖（@modelcontextprotocol/sdk 等）
node mcp/server.mjs                # stdio 模式（本机 MCP 客户端接入）
node mcp/server.mjs --http 3001    # HTTP 模式（远程 agent 调用，带鉴权）
```

前置依赖：本机需安装 [ffmpeg](https://ffmpeg.org)（`winget install Gyan.FFmpeg`）。

### 工具列表

| 工具 | 说明 |
|---|---|
| `generate_video` | 生成视频。参数：`image`（必填，URL / data URL / 本地路径）、`music`（可选）、`duration`（默认 10 秒，1~60）、`theme_bg`（空白填充背景色，默认 `#eef1f4`，深色传 `#0a0e13`）、`filename`（可选） |
| `list_outputs` | 列出已生成的视频（文件/大小/时间） |
| `health` | 服务状态（版本/ffmpeg/输出目录） |

### MCP 客户端接入配置

**ZCode / 通用 stdio 客户端：**

```json
{
  "mcpServers": {
    "x-post-video": {
      "command": "node",
      "args": ["D:/game/x-post-video-repo/mcp/server.mjs"]
    }
  }
}
```

**Claude Desktop（claude_desktop_config.json）：**

```json
{
  "mcpServers": {
    "x-post-video": {
      "command": "node",
      "args": ["D:/game/x-post-video-repo/mcp/server.mjs"]
    }
  }
}
```

**HTTP 远程调用（API Key 鉴权）：**

```bash
# 健康检查（免鉴权）
curl http://localhost:3001/health

# 调用工具（必须带 key）
curl -X POST http://localhost:3001/mcp \
  -H "content-type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer 18596950010" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"generate_video","arguments":{"image":"https://example.com/post.png","duration":10}}}'
```

- API Key：默认 `18596950010`，可用环境变量 `MCP_API_KEY` 覆盖
- 鉴权方式：`Authorization: Bearer <key>` 或 `X-API-Key: <key>`；stdio 模式为本地进程不做校验
- MCP 端点：`POST /mcp`（Streamable HTTP；请求头需 `Accept: application/json, text/event-stream`）

### 端到端测试

```bash
node mcp/server.mjs --http 3001 &   # 启动
node mcp/test-client.mjs            # 5 项断言：tools/list / 本地图+音乐 / data URL / 错误处理 / list_outputs
```

产物音轨与规格已用 ffprobe 验证：`video h264 + audio aac`，含音乐版 10 秒约 0.19 MB。



```
├── index.html                  # 主文件（编辑器 + 视频生成，全部逻辑内联）
├── vendor/
│   ├── mp4-muxer.min.js        # MP4 封装库（MIT，来源 npm mp4-muxer@5.2.2）
│   └── mp4-muxer.LICENSE
├── mcp/
│   ├── server.mjs              # MCP 服务器（stdio / HTTP 双模式，API Key 鉴权）
│   └── test-client.mjs         # HTTP 端到端测试客户端
├── scripts/
│   ├── deploy-cloudflare.mjs   # Cloudflare Workers 部署脚本
│   └── deploy-herenow.mjs      # here.now 部署脚本
└── docs/evidence/              # 实测截图证据
```

## 实测验证（63 项自动化断言全通过）

覆盖：首屏随机与数字偏序、双模式切换与布局往返搬运、Handle 智能跟随（中/英文）、长文提醒、引导条记忆、主题切换、结构标注、就地编辑（Esc/Ctrl+Enter）、Handle 打码、翻译卡两种形态、头像在线生成（含失败兜底）、PNG 导出、视频快速路径生成（本地 1.1s / 线上 1.8s）、背景音乐重生成、video 预览切换、移除复位、移动端 375 视口 0 溢出、双线上站点全功能复验。

截图见 [docs/evidence/](docs/evidence/)。

## 已知限制

- Safari 旧版不支持 WebCodecs 时自动降级为 10 秒实时录制（状态栏会提前提示）
- MP4 编码依赖平台 H.264 编码器；极少数环境自动落到 WebM（文件后缀自动匹配）
- 「恢复示例」按钮回到固定样例数据（林知远），用于课堂对照 / 演示

## 许可

- 本项目代码：MIT
- [vendor/mp4-muxer.min.js](vendor/mp4-muxer.LICENSE)：MIT（Vanilagy/mp4-muxer）
