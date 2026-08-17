# Cassie 语义解析管线（调研与设计）

日期：2026-08-17
状态：调研完成，待 Phase 2 实现

## 问题

「香水瓶」「人物 A · Mia」「巴黎夜景」在 NOCTURNE 演示里是**手工绑定的固定值**。
真实产品中，它们必须从视频内容里**提取**：主体是什么、出现在哪几帧、生命周期、
与其他主体的关系（手持/遮挡/受光）——全部由语义分析产生，而不是预先写死。

## 调研结论（开源社区，2026-08）

### 视觉提取层：谁把「像素」变成「主体轨迹」

| 工具 | 能力 | 规模/许可 | 适配性 |
| --- | --- | --- | --- |
| [SAM 3](https://github.com/facebookresearch/sam3)（Meta，ICLR 2026） | **概念提示分割**：文本 prompt（"perfume bottle"）→ 全视频所有实例 + 唯一跟踪 ID；Presence token 解耦「存在」与「定位」 | 848M 参数，~3.4GB；Meta SAM 许可（可商用，权重需申请，商用前核实条款） | ★★★ 与 Cassie 语义主体模型天然同构：concept → instances → tracks |
| [Grounded-SAM-2](https://github.com/IDEA-Research/Grounded-SAM-2)（IDEA-Research） | Grounding DINO + Florence-2 + SAM 2：开放词汇检测 + 视频跟踪 + 分割，输出 JSON（框/掩码/置信度） | 组合管线；近 200+ 天低维护 | ★★ 成熟但重（PyTorch+CUDA），且维护放缓 |
| [Florence-2](https://huggingface.co/onnx-community/Florence-2-large)（Microsoft） | 轻量视觉语言模型：检测/短语定位/字幕，0.2B/0.7B；官方 ONNX 版可直接进浏览器 | MIT；[transformers.js](https://github.com/huggingface/transformers.js/releases/tag/4.0.0) 运行，WebGPU/WASM | ★★★ **浏览器本地推理的唯一现实选择**：隐私（零上传）、离线、无 GPU 要求 |
| [Sa2VA](https://gitcode.com/gh_mirrors/sa/Sa2VA) | Qwen2.5-VL / Qwen3-VL + SAM2/3 的视频稠密理解：[SEG] token 把语言指称直接变成掩码 | 学术向 | ★★ 若需要「边聊边分割」的 VLM 一体化方案 |

### 语义解释层：谁把「轨迹」命名成「人物 A · Mia」

- **DeepSeek Pro**（deepseek-v4-pro）：候选轨迹 + 帧采样描述 → 实体命名、关系判定（手持/遮挡）、
  生命周期确认、异常裁决。通过用户已有的 Anthropic 兼容端点调用。
- 兜底：确定性规则（轨迹重叠度 + 时间窗 → held_by 关系等）保证离线可用。

## 管线设计

```
┌─ 视频 ────────────────────────────────────────────────┐
│  1. 视觉提取（本地）                                     │
│     SAM 3（GPU/桌面）或 Florence-2+transformers.js（浏览器）│
│     → candidates: [{track_id, mask/box, frames, score}]  │
│  2. 语义解释（DeepSeek Pro）                             │
│     候选轨迹 + 抽帧描述 → SemanticEntity 草案：            │
│     {name, reference, lifecycle, relations}             │
│  3. 写入 Video Spec（packages/spec）                     │
│     entity.binds ← track_id 对应 clip 稳定 ID            │
│  4. Harness 接管：所有修改走事务 + 命令编译                │
└─────────────────────────────────────────────────────────┘
```

### 分层落点

- **提取服务**：Web Worker 内跑（浏览器方案）或本地 sidecar（SAM 3），
  结果以 `SemanticCandidate[]` 结构化 JSON 回写——不直接改文档。
- **LLM 适配器**：`parseIntent` 的既有契约不变（输入文本/上下文 → Intent）；
  DeepSeek Pro 作为 Phase 2 的实现替换关键词解析器，Golden 回归继续兜底确定性。
- **隐私边界**：API key 只在服务端/本地代理使用，**永不进前端**；
  浏览器端 Florence-2 路径则完全零上传。

## 分期建议

1. **Phase 2（下一迭代）**：浏览器端 Florence-2（transformers.js，自托管 ONNX 权重）
   跑通「导入视频 → 自动提取 2-3 个主体候选 → 用户确认/命名 → 绑定语义实体」，
   配上 DeepSeek Pro 命名与关系判定（本地代理）。
2. **Phase 3+**：SAM 3 侧车（桌面端 Rust Core 成熟后并入 EditorAdapter 生态）做
   精确掩码级主体 + 全片跟踪；Sa2VA 方案留作「对话式分割」评估项。

## 许可注意

- SAM 3 权重：申请制 + Meta SAM 许可，商用前逐条核实（有来源称 Apache-2.0，与官方
  Hugging Face 页矛盾，以官方为准）。
- Florence-2：MIT，可商用，浏览器部署无障碍。
- transformers.js：Apache-2.0。
- DeepSeek API：按服务条款使用。

## 来源

- [facebookresearch/sam3](https://github.com/facebookresearch/sam3) / [SAM 3 论文解读](https://papernotes.org/ICLR2026/segmentation/sam_3_segment_anything_with_concepts/)
- [IDEA-Research/Grounded-SAM-2](https://github.com/IDEA-Research/Grounded-SAM-2)
- [onnx-community/Florence-2-large](https://huggingface.co/onnx-community/Florence-2-large) / [transformers.js v4.0.0](https://github.com/huggingface/transformers.js/releases/tag/4.0.0)
- [Sa2VA](https://gitcode.com/gh_mirrors/sa/Sa2VA)
- [Roboflow: Best Free CV Models 2026](https://blog.roboflow.com/best-free-computer-vision-models/)
