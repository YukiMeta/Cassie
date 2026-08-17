# Cassie 语义解析管线（调研与设计）

日期：2026-08-17（更新：决策 SAM 3 主线 + 全站 BYOK）
状态：设计完成，BYOK 配置层与 LLM 适配器已实现，SAM 3 服务已交付（servers/sam3/，本机未实测）

## 决策（2026-08-17）

1. **视觉提取主线 = SAM 3**：概念提示分割 + 全片跟踪，与语义主体模型同构。
2. **全站模型 BYOK**：所有用到模型的位置（意图解析 LLM、视觉提取）都开放配置接口，
   用户在设置面板自填 baseUrl / model / API key；key 只存本机 localStorage，
   请求经本机 dev 代理转发（生产部署需等价 serverless 代理）。
3. 未配置模型时全部能力走本地确定性实现，功能不回退。

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

## 管线设计（已按决策实现）

```
┌─ 视频 ─────────────────────────────────────────────────┐
│  1. 视觉提取（SAM 3，servers/sam3 本地服务）              │
│     POST /extract {视频, 概念列表}                        │
│     → candidates: [{concept, tracks: [{track_id,         │
│        score, startUs, endUs, boxes}]}]                  │
│  2. 用户确认（Cassie 图层页「✦ 从视频提取主体」）           │
│     勾选/改名 → 绑定语义实体：生命周期=轨迹时间窗，          │
│     binds=覆盖该窗的视频片段                               │
│  3. 语义解释（用户自配 LLM，默认建议 DeepSeek Pro）         │
│     意图解析：llmParseIntent（JSON 契约）                  │
│     失败自动回退确定性关键词解析器                          │
│  4. Harness 接管：所有修改走事务 + 命令编译                 │
└─────────────────────────────────────────────────────────┘
```

### 分层落点（已实现）

- **提取服务**：`servers/sam3/server.py`（FastAPI 封装 facebookresearch/sam3 视频推理），
  契约公开——任何自建端点可替代；结果以结构化 JSON 回写，不直接改文档。
- **BYOK 配置层**：`apps/web/src/lib/model-client.ts` + SettingsModal：
  - LLM 槽位：OpenAI 兼容端点（任意）+ Anthropic 格式端点（识别 /anthropic 自动切换），
    model 名自填，默认建议 DeepSeek（baseUrl `https://api.deepseek.com/v1`，model `deepseek-chat`）
  - 视觉槽位：SAM 3 服务地址 + 可选 token
  - key 只存本机 localStorage；请求经 vite dev 代理 /api/llm、/api/vision 转发（key 不出本机）；
    生产部署需等价 serverless 代理（文档化）
- **LLM 适配器**：`harness.compileFromIntent` 契约与确定性 `compile` 完全一致；
  Golden 回归继续兜底确定性；UI 顶栏显示当前解析模式（⚡ LLM / ▣ 本地解析）。

## 分期建议

1. **Phase 2（进行中）**：SAM 3 提取流程已在 UI 打通（候选确认→绑定）；下一步实测
   servers/sam3（需要权重 + GPU 机器），并按实测校准官方 API 差异。
2. **Phase 3+**：LLM 命名与关系判定（候选轨迹 → DeepSeek Pro 生成实体名/关系，写回 spec）；
   掩码级画布标注；Sa2VA 留作「对话式分割」评估项。

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
