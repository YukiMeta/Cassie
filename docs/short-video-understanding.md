# ≤15s 语义理解：Agent-first 工作流

Cassie 的事实源是本地工程、媒体和版本化观察文件。Agent 通过 CLI / MCP 完成导入、取证、描述、定位；浏览器只展示结果和证据。默认流程不依赖浏览器状态、上传表单、localStorage 或第二个模型的 API Key。

本阶段只观察、定位和预览，不自动生成新动作。观察与 authored timeline events 分开存储；分析和定位不产生剪辑事务。撤销、MP4 导出、旧工程及变体数据保留。

## 路径 A：使用 Agent 自己的视觉能力

```sh
# 从本地视频建立可编辑工程；无浏览器。
npm run cassie -- import-video /absolute/input.mp4 --out /absolute/work/project.json
# 取有序证据，返回源哈希、源帧域、JPEG 绝对路径和 manifest。
npm run cassie -- evidence /absolute/work/project.json --asset SOURCE_ID
# Agent 读取实际图像后，提交观察；不是让用户手工写 caption。
npm run cassie -- record-analysis /absolute/work/project.json --bundle BUNDLE_ID --data observations.json --model external-agent
# 复看候选动作的小窗口。
npm run cassie -- evidence /absolute/work/project.json --asset SOURCE_ID --start-frame 48 --end-frame 72 --fps 8
npm run cassie -- record-grounding /absolute/work/project.json --bundle FOCUSED_BUNDLE --analysis ANALYSIS_ID --query '第二次转头' --data binding.json
```

Agent 也可启动 `cassie mcp <project.json>`，使用完全对应的工具：

1. `project_overview` / `add_video_source`：读工程，按本地路径加入源素材。单纯加入素材库不会改变时间线，可撤销。
2. `prepare_video_evidence`：准备全源证据包，或指定源帧窗口与 fps；基础至多 32 帧，复看至多 64 帧。
3. `read_evidence_frame`：通过 MCP image content 直接读取 JPEG，不启动浏览器或预览服务器。已有本地图像工具的 Agent 可直接读 manifest 中的图片。
4. `submit_video_analysis`：提交 Agent 看到的对象、动作、时间与证据。校验源哈希、实际采样帧、实体 ID 与帧域；仍标记 proposed。
5. 定向复看后 `submit_video_grounding`：绑定当前 analysisId 和原始 query，返回 resolved / ambiguous / not_found。证据不足不能猜。
6. `read_video_analysis`：恢复观察和最近定位，跨进程继续工作；不能把观察事件 ID 当作剪辑事件 ID。

所有步骤都能在无浏览器、无模型配置的环境运行。`record-*` 的数据由 Agent 看过证据后生成；契约校验不证明 Agent 的视觉判断一定正确。

观察最小结构：`summary`、`entities[{id,name,description,visibleRanges[{startFrame,endFrame}],evidenceFrames}]`、`events[{id,entityIds,description,range,evidenceFrames,uncertainty}]`、`uncertainties[string]`。

定位结果结构：`{status,explanation,candidates:[{eventId:string|null,entityIds,range:{startFrame,endFrame},evidenceFrames,reason}]}`。

## 路径 B：可选的视觉 Provider

宿主可设置 `CASSIE_UNDERSTANDING_CONFIG=/absolute/model.local.json`，文件内容为 `{baseUrl,model,apiKey}`；或设置 `CASSIE_VISION_BASE_URL`、`CASSIE_VISION_MODEL`、`CASSIE_VISION_API_KEY`。

```sh
cassie analyze project.json --asset SOURCE_ID
cassie ground project.json --asset SOURCE_ID --analysis ANALYSIS_ID --query '第二次转头'
```

MCP 对应 `analyze_video` / `ground_video`。这是可选执行器，不是 Agent 必须先配置的前置条件。配置在宿主读取，不作为 tool 参数，也不写入证据文件。调用时有序采样图会发送给配置的服务。

支持现有 OpenAI-compatible Chat Completions / Anthropic 协议。必须使用支持多图的视觉模型，普通文本连通测试不代表视觉能力。API 返回 schema 不合法时不回退为 demo 描述。

## 文件与证据

- `cassie/analysis@1`：源 asset/hash、源帧域与有理数帧率、模型/Agent 标签、提示版本、实际采样帧、对象、事件和不确定性。
- `cassie/grounding@1`：analysisId、源 hash、query、候选窗口与证据。重新分析后旧 grounding 不再作为当前结果。
- `.cassie-cache/evidence/<bundle-id>/manifest.json` 与 JPEG：Agent 直接使用的证据包，不依赖 session URL。
- `.cassie-cache/analysis/<source-hash>/`：各次分析/定位及最新索引；原片字节改变或素材撤销后拒绝旧证据。
- 所有源窗口采用整数帧及 `[startFrame,endFrame)`，区别于剪辑时间。输入需为 ≤15 秒 CFR 视频，VFR 延用现有显式 normalize 流程。

## 界面是查看器

`npm start project.json` 仅在需要可视检查时启动。默认界面自动读取外部 Agent 写入的工程、观察和定位，显示源视频、证据帧、候选与剪辑历史。用户可以查看不同事件、播放证据或撤销工程修改；不需要按“上传→配置→分析→定位”的顺序完成任务。

原 provider 手工联调页面保留在 `?workbench=1`，不作为默认入口。变体 UI 和默认 MCP 工具入口隐藏，兼容命令仍在 `cassie help-legacy`。

## 验证

```sh
npm test
npm run typecheck
npm run build
npm run test:agent-understanding
npm run test:analysis
npm run test:integration
CASSIE_TEST_EXPORT=1 npm run test:analysis
```

`test:agent-understanding` 不启动 HTTP 服务器、不打开浏览器、不配置模型/key：通过真实 CLI 导入视频，启动 stdio MCP，取证据图片，提交 fixture 观察与定位，跨工具读取结果，添加素材并撤销，再验证 CLI 的证据/观察命令。它验证原生 Agent 工作流，不是模型质量测试。

`test:analysis` 使用真实 FFmpeg、HTTP、媒体哈希、持久化与显式 mock provider，覆盖可选适配器的数据流。可选 export 检查现有 Hyperframes 渲染器在分析和撤销后仍能导出可解码 MP4。`CASSIE_ANALYSIS_KEEP=1` 可启动本机模拟服务做界面联调。

## 当前边界

音频未参与理解；稀疏采样会遗漏快速或短暂动作。`not_found` 表示当前证据不足，不证明原片中不存在该动作。尚未完成真实模型质量基准、人工纠正、自动硬切加密采样、生成式修改和语义编辑脚本执行。下一步应使用冻结样片，测自动观察与人工校正后的定位差异。
