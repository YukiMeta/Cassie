# ADR-002: 服务端渲染后端基于 HyperFrames

日期：2026-10-05
状态：已接受

## 背景

ADR-001 记录了 v1 的已知限制：浏览器预览（video element 合成）与 ffmpeg.wasm 导出不是帧级一致，且 drawtext 的字体与排版能力有限。工业场景需要确定性、可复现、可横向扩展的渲染。

[HyperFrames](https://github.com/heygen-com/hyperframes)（HeyGen，Apache-2.0）把 HTML composition 逐帧 seek 后用 headless Chrome 截取、FFmpeg 编码，同输入同输出，并提供 Node 端的 `@hyperframes/producer`、AWS Lambda / Cloud Run 分布式渲染。

## 决策

1. **只使用渲染内核**：`@hyperframes/producer`（依赖 core / engine / parsers / lint / studio-server），由 `servers/render` 调用。**不使用** `@hyperframes/studio`、`sdk-playground`、示例模板与 skills。
2. **Cassie 编译自己的 composition**：`servers/render/src/composition.ts` 把 Project 文档编译成 HTML，合成规则与 `buildExportPlan` 一致。动画运行时只允许原生 CSS / Web Animations；编译器在输出含 `gsap` 时直接报错，并有单测守护。
3. **前端不出现渲染引擎品牌**：前端只认识"渲染服务"（`/render` + `/jobs` 契约），`tests/frontend-branding.test.ts` 扫描 `apps/web` 源码、静态资源和构建产物。服务端代码与文档可以正常引用 HyperFrames。
4. **本地导出保留**：未启用渲染服务时仍走 ffmpeg.wasm，功能不回退。

## 许可证分析（非法律意见，商用前请法务复核）

| 组件 | 许可证 | 处理 |
| --- | --- | --- |
| HyperFrames（producer / core / engine / parsers / lint / studio-server） | Apache-2.0 | 允许修改、闭源、商用；分发时附许可证与 NOTICE（见 `THIRD_PARTY_NOTICES.md`）；不使用其商标命名产品 |
| GSAP | GSAP Standard License（非 OSI）：禁止用于与 Webflow 可视化动画构建能力竞争的无代码工具 | **不引入**。producer 只在 composition 自己引用 GSAP 时才加载它；Cassie 的 composition 禁止引用。已确认 `servers/render/node_modules` 中不含 `gsap` |
| Puppeteer / Chrome Headless Shell | Apache-2.0 / BSD 等 | 服务端使用，无额外义务 |
| ffmpeg-static | GPL 构建（含 x264） | 仅在服务端进程内调用、不随前端分发。若将渲染服务打包分发给客户自部署，需履行 GPL 义务或换用 LGPL 构建 |
| @ffprobe-installer/ffprobe | LGPL / GPL 构建 | 同上 |

## 后果

- 预览与成片的一致性问题由服务端渲染解决；浏览器本地导出降级为离线兜底。
- 新增运行时依赖：Chrome Headless Shell 与 FFmpeg，需要在部署镜像中固定版本以保证确定性。
- 已知坑：producer 的入口探测会在进程入口路径以 `/src/server.ts` 结尾时自动启动它自带的 HTTP 服务，因此 Cassie 服务入口命名为 `src/main.ts`。
- 后续：语义层的运动（Manim 式 Transform）编译为 Web Animations 关键帧；分布式渲染接 `@hyperframes/producer/distributed`。
