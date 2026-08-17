# Cassie SAM 3 提取服务

Cassie 的视觉语义提取层：把视频交给 [SAM 3](https://github.com/facebookresearch/sam3)（概念提示分割 + 全片跟踪），
返回结构化候选主体（概念、轨迹时间窗、框、置信度），供浏览器端「从视频提取主体」流程确认后绑定为语义实体。

## 契约

| 端点 | 说明 |
| --- | --- |
| `GET /health` | `{"ok": true, "model": "sam3", "loaded": bool}` |
| `POST /extract` | multipart：`file`（视频）+ `prompts`（JSON 概念数组）→ `{candidates: [{concept, tracks: [{track_id, score, startUs, endUs, boxes}]}]}` |

任何实现该契约的自建端点都可以填进 Cassie 设置里的「服务地址」——服务不局限于本仓库实现。

## 安装

1. **SAM 3 本体**（按官方仓库）：

```sh
git clone https://github.com/facebookresearch/sam3
cd sam3 && pip install -e .
```

2. **权重**：在 [Hugging Face facebook/sam3](https://huggingface.co/facebook/sam3) 申请访问并下载 checkpoint
   （Meta SAM 许可：商用前请逐条核实条款）。

3. **本服务依赖**：

```sh
cd servers/sam3
pip install -r requirements.txt
```

## 启动

```sh
uvicorn server:app --host 0.0.0.0 --port 8000
# 或
PORT=8000 python server.py
```

> 首次 /extract 调用会加载模型（848M 参数，~3.4GB），需要数秒到一分钟；
> 官方建议 16GB+ 显存 GPU。CPU 推理可用但较慢。

## 在 Cassie 中使用

1. 顶栏 ⚙ 模型 → 打开「视觉提取（SAM 3）」→ 填 `http://localhost:8000` → 测试连接
2. 图层标签 → 「✦ 从视频提取主体」→ 输入概念（如 `perfume bottle, person`）→ 开始提取
3. 勾选候选、改名 → 确认绑定 → 主体进入语义图层（生命周期 = 轨迹时间窗，绑定 = 覆盖该窗的视频片段）

## 说明

- 每个概念独立 session（SAM 3 状态机要求），提取完成后 reset
- 输出只保留框与置信度（v1），mask 数据留待画布级标注功能
- 本机未实测（无权重/GPU），按官方 README 与 video predictor 示例校准；遇 API 差异以
  facebookresearch/sam3 仓库为准，欢迎修 PR
