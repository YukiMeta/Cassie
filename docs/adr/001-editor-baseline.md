# ADR-001: 编辑器底座基线选择

日期：2026-08-17
状态：已接受

## 背景

Cassie 需要一个真实可用的编辑器底座：媒体导入、播放、多轨时间线、切分、Trim、撤销、保存、导出。计划书（阶段 0）要求在 OpenCut Classic 与 OpenCut Rewrite 之间做两天技术验证后选择基线。

## 验证证据

### OpenCut Rewrite（OpenCut-app/OpenCut，84k stars）

- Rust workspace + moon，apps: web/api/desktop
- README 明确："We're not set up to take outside contributions yet while the architecture is being designed"
- apps/web 目前是 TanStack Start + 组件脚手架，**尚不能真实导入、播放、导出**
- 方向（Editor API、Rust Core、插件、MCP、Headless）与 Cassie 需求完全吻合，但**当前完成度不通过门槛**

### OpenCut Classic（opencut-app/opencut-classic，已归档 2026-05-17）

- 真实可用的编辑器：mediabunny + opencut-wasm（Rust WebGPU 合成器）+ Next.js 16
- Command 模式存在（`base-command.ts`：execute/undo/redo，batch-command）
- 项目 Schema（TProject → Scenes → Tracks）较薄，可扩展
- **但**：命令系统内嵌在 Next.js 单体应用中（auth / Postgres / Cloudflare / blog / site 大量包袱），编辑器逻辑与 UI shell 耦合，其自身 AGENTS.md 承认「business logic 迁移到 rust/ 尚未完成」
- 已归档，不再演进；上游团队明确 rewrite 将接替

## 决策

**Cassie 自建 TypeScript 编辑器内核，以 opencut-classic 为参考实现，通过 EditorAdapter 隔离全部编辑器耦合。**

1. 不 fork opencut-classic 单体（auth/DB/Cloudflare/blog 包袱违反 Cassie 极简原则，且已归档）。
2. 采纳 classic 已验证的接口设计：Command.execute/undo/redo、CompositeCommand、MediaTime（有理数时间）、Project → Tracks → Clips 文档模型。接口形状对齐 classic，使未来迁移成本最小。
3. EditorAdapter 是对编辑器内核的唯一入口：Cassie 上层（spec / harness / UI）只依赖 Adapter 接口，不依赖内核实现。
4. 长期目标：OpenCut Rewrite 的 Rust Core 成熟后（Editor API / Headless / MCP），将 Adapter 重定向到 Rust Core——届时文档模型与命令接口已对齐，替换是插件级的。

## v1 技术选择

| 关注点 | 选择 | 理由 |
| --- | --- | --- |
| 文档模型 | 版本化 JSON（Project v1），稳定 ID | 可持久化、可 diff、可回归测试 |
| 播放 | HTMLVideoElement + Canvas 合成 | v1 可靠、开发快；预览/导出确定性差距记入已知限制 |
| 导出 | ffmpeg.wasm（@ffmpeg/ffmpeg，本地 worker） | 浏览器本地、确定性、格式全；LGPL 核心，用于本地导出可接受 |
| 渲染一致性 | 导出图直接从文档模型编译（filter_complex） | 预览与导出同一事实源；帧级一致渲染器留待 Phase 5 |

## 已知限制（v1）

- 预览（video element 合成）与导出（ffmpeg）非帧级一致；由 Golden 测试锁文档模型确定性，渲染一致性由后续 renderer 包解决。
- ffmpeg.wasm 首次加载约 30MB；打包本地资源，不依赖 CDN。

## 后果

- 正向：Cassie 内核极薄、语义层即差异化；不被归档代码库拖累；Adatper 边界保证未来可换 Rust Core。
- 代价：自建内核需要自己保证命令正确性与序列化稳定性——以 Golden 回归测试兜底（本 Sprint 交付）。
