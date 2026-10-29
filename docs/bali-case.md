# Bali 实片验证

本例使用用户提供的 `take-kr-9x16-bali.mp4`，验证真实素材进入 Cassie 的工程、人物遮罩、动作计划与渲染链路。当前没有配置视频编辑模型，因此未生成新的挥手动作，未提交动作修改事务。

## 已验证结果

- 原片：720×1280，约 13.056 秒，331 个视频帧，时间戳不规则，带 AAC 原声。
- 显式规范化副本：24 fps、314 帧、13.083333 秒；原文件未覆盖。
- 人工确认剪辑边界：44、97、241 帧，建立四个视频事件和四个原声事件。镜头 2 依赖开场动作的结束，后续镜头依次衔接；每段原声依赖相应镜头的开始。
- 本次目标：开场镜头 `person-action`，0–44 帧。女生在后续镜头的出现尚未合并为跨镜头同一身份轨迹。
- 本地 Apple Vision 生成开场 44 帧人物灰度遮罩，作为 `attach-subject-matte` 事务保存。遮罩质量标记为 `draft`，保留原动作；头发、手、肩包和遮挡需检查。此后端对单人镜头适用，不能从多个同时出现的人中选择一个。
- 客户端透明预览按源帧同步遮罩，并可导出带 alpha 的 VP9 WebM。烧录在人物区域内的字幕仍可能留在前景中；抠像不会创建无字幕人物或自动修复人物原位置的背景。
- Hyperframes Producer 从 Cassie 工程实际导出完整 MP4：720×1280、314 帧、24 fps、13.083333 秒，带原声。逐镜头的解码音频与规范化输入做相关性检查，最大对齐偏差 0.25 ms；不意味着无损音频往返。

## 动作与事件变化

`wave.edit.json` 请求右手自然挥手一次，输出仍为 44 帧。此时动作状态改变，后面的时间点保留。

`wave-extended.edit.json` 请求 72 帧。预演给出的变化：

| 事件 | 原帧域 | 计划帧域 |
| --- | --- | --- |
| 女生开场动作 | 0–44 | 0–72 |
| 镜头 2 / 对应原声 | 44–97 | 72–125 |
| 镜头 3 / 对应原声 | 97–241 | 125–269 |
| 镜头 4 / 对应原声 | 241–314 | 269–342 |

开场原声保留 44 帧，不自动拉伸；增加的 28 帧如何与口播衔接必须审核。两种计划均处于 `awaiting-media`，没有伪造候选或用原片冒充新动作。

## 可复用命令

```sh
npm run cassie -- normalize input.mp4 --out normalized.mp4 --fps 24
npm run cassie -- import normalized.mp4 --out project.cassie.json --entity '女生' --instruction '抬起右手挥手一次' --cuts 44,97,241 --action-shot 0
npm run cassie -- matte project.cassie.json --event person-action
npm run cassie -- cutout project.cassie.json --event person-action --out girl-original.webm
npm run cassie -- plan project.cassie.json --edit wave.edit.json --out wave.plan.json
npm run cassie -- bundle wave.plan.json --project project.cassie.json --out model-input
npm run cassie -- serve project.cassie.json --port 4318
```

抠像命令需要 macOS、Swift 编译器及兼容 SDK。只使用本机系统框架，源素材不上传。后端生成的是人物分割遮罩，不是动作生成模型。

## 模型交接

`model-input/task-1/` 包含裁出的 44 帧 `source.mp4`、与之逐帧对齐的 `mask.mp4` 和 `request.json`。请求包含目标动作、精确输出帧域、尺寸、保留对象、输入哈希和检查项。素材包为 `awaiting-provider`。

有支持视频动作编辑及人物遮罩的 provider 后执行：

```sh
npm run cassie -- generate wave.plan.json --provider provider.json --out generation.run.json
npm run cassie -- accept project.cassie.json --plan wave.plan.json --candidate candidate.mp4 --provider-name PROVIDER --review '实际查看动作、身份、背景、字幕及口型后的审核意见' --out receipt.json
npm run cassie -- apply project.cassie.json --plan wave.plan.json --receipt receipt.json
npm run cassie -- render project.cassie.json --out edited.mp4
```

provider 配置声明 `video-edit` 和 `subject-mask` 能力。进程收到 `cassie/video-edit-request@1`、原源文件 `sourcePath`、遮罩文件 `maskPath` 与时间窗。也可用离线素材包对接其他编辑模型。模型产物必须是完整合成镜头；透明人物单独返回尚不能直接替换原片，因为还需要背景修复与前景合成。

## 工程检查

43 项单元测试、媒体与 HTTP 集成测试、类型检查及两个客户端构建通过。集成测试中的合成源与白色遮罩只验证媒体契约；本例实际素材的人物遮罩和渲染产物单独验证，不把机械测试当作新动作的质量证明。
