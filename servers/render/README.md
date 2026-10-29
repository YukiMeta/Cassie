# Cassie 渲染服务

把 Cassie 项目文档渲染成 MP4：`Project` → HTML composition（`src/composition.ts`）→ [HyperFrames](https://github.com/heygen-com/hyperframes) producer 逐帧确定性渲染。许可证决策见 `docs/adr/002-render-backend.md`。

## 契约

| 端点 | 说明 |
| --- | --- |
| `GET /health` | `{"ok": true, "engine": "cassie-render"}` |
| `POST /render` | multipart：`project`（Project JSON）+ `asset:<assetId>`（素材文件）→ `202 {"jobId"}` |
| `GET /jobs/:id` | `{status: queued|rendering|done|failed, progress, message, error?}` |
| `GET /jobs/:id/output` | `video/mp4` |

设置 `CASSIE_RENDER_TOKEN` 后，除 `/health` 外都需要 `Authorization: Bearer <token>`。任务串行执行，结果保留 30 分钟。

## 运行

```sh
cd servers/render
npm install
npm start            # 默认端口 8797，PORT 可改
npm run smoke        # 另开终端：生成测试素材并走一遍完整渲染，结果在 smoke-out/
```

首次渲染需要 Chrome Headless Shell（puppeteer 缓存于 `~/.cache/puppeteer`）。如果 npm 拦截了 install scripts，执行：

```sh
npx @puppeteer/browsers install chrome-headless-shell@stable
```

FFmpeg / ffprobe 由 `ffmpeg-static` 与 `@ffprobe-installer/ffprobe` 提供（均为原生 arm64 / x64）；也可以用 `HYPERFRAMES_FFMPEG_PATH`、`HYPERFRAMES_FFPROBE_PATH` 指向自己的构建。

## 在 Cassie 中使用

顶栏 ⚙ 模型 → 打开「渲染服务」→ 填 `http://localhost:8797` → 测试连接 → 保存。之后「导出成片」会提交到渲染服务；关闭开关则回到浏览器本地导出。

## 约束

- composition 只允许原生 CSS / Web Animations，**禁止引用 GSAP**（编译器会报错）。
- 入口文件不要命名为 `src/server.ts`：producer 会按入口路径自动启动它自带的服务。
