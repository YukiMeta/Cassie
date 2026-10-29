# ≤15s 视频理解 v0.1

本次实现只观察、定位和预览，不自动执行生成式修改。源视频观察与工程事件分开存储，caption / grounding 不改时间线或撤销历史。现有撤销、MP4 导出与旧工程变体数据保留；默认画布和 Agent 隐藏变体入口。

## 使用

```sh
npm ci
npm start path/to/project.cassie.json
```

在左侧“理解”选择工程里的源视频，或“添加 ≤15s 理解素材”。新增素材通过现有 DocumentEdit 事务写入素材库，可以撤销；不会自动加入成片时间线。预览的是源片，导出仍使用既有时间线。

模型设置沿用 BYOK，必须选择支持多图输入的视觉语言模型。文本连通测试不证明视觉能力。支持现有 OpenAI-compatible Chat Completions 和 Anthropic 格式端点；不会自动替用户选择型号。分析按钮会发送至多 32 张 768 像素内的有序采样图；语义定位先读分析索引，再按候选范围发送至多 64 张图复核。不要把稀疏帧推断当作帧级标注。

输入需为可读取的 CFR 视频、不超过 15 秒，新增上传限制 100 MB、MP4。VFR 延用现有显式 normalize 流程，不静默转换时间域。音频未被分析，不声称从图像推断了声音。长素材请先裁出短片。

点击对象、事件或定位候选可查看源片、片段播放及证据图。源帧使用 `[startFrame,endFrame)`；只有时间线中存在唯一完整覆盖该源窗口的片段时，才显示“定位到时间线”。多候选和证据不足显式显示，不自动选择或执行编辑。

## 数据和接口

- `cassie/analysis@1`：源 asset/hash、源帧域与有理数帧率、模型与 prompt 版本、实际采样帧、对象、动作事件、证据引用、不确定性。观察状态始终为 `proposed`，需人核对。
- `cassie/grounding@1`：绑定 analysisId、源 hash 与原始 query，返回 `resolved/ambiguous/not_found` 及候选源窗口。观察 ID 不是工程事件 ID。
- JSON 存在工程目录 `.cassie-cache/analysis/<source-sha256>/`。每次分析和定位有独立版本，最新索引用于恢复界面。重新分析后旧 grounding 不再作为当前结果返回；源字节改变则拒绝复用。
- `GET /api/analysis?assetId=...` 读取当前分析。
- `POST /api/analysis` 提交 `{assetId,cfg}`，`POST /api/analysis/ground` 提交 `{assetId,analysisId,query,cfg}`，返回 job id；通过既有 `/api/render/<id>` job 状态接口轮询结果。
- `GET /api/analysis/frame?assetId=...&frame=N` 按源帧抽 JPEG。
- `POST /api/analysis/import` 带会话 token 上传二进制短片，返回新增素材 ID。
- `read_video_analysis` 工具让 Agent 读取已保存的观察和最近定位；模型配置与 key 不进入侧文件。

服务端拒绝越界时间、不存在的对象/事件、未实际提供给模型的证据帧、与状态矛盾的候选数量。每个源哈希一次只允许一个分析/定位任务。模型响应失败不会回退成固定 demo caption 或修改工程；上游错误正文不被透传，避免凭据进入错误记录。

## 检查

```sh
npm test
npm run typecheck
npm run build
npm run test:analysis
CASSIE_TEST_EXPORT=1 npm run test:analysis
```

`test:analysis` 使用真实 FFmpeg、HTTP、媒体哈希与落盘，视觉模型是显式 mock：检查多图传输、查询复看、证据图、超长拒绝、鉴权、陈旧分析、只读观察、素材导入撤销和普通编辑撤销。可选 export 检查已有 Hyperframes 渲染器能在这些步骤之后导出可解码 MP4。

`CASSIE_ANALYSIS_KEEP=1 npm run test:analysis` 启动本机联调页面（5176）和 mock provider，供界面检查；日志打印模拟端点，使用任意非空测试 key。不要将 fixture 的“两次转头”当成真实识别结果。

尚未完成真实模型质量评测、人工纠正、自动硬切加密采样、生成式修改以及语义编辑脚本执行。当前 `not_found` 表示索引中没有足够支持的目标，不能证明原片里不存在该动作。下一步用冻结样片和人工标注比较自动观察与人工校正后的定位成功率。
