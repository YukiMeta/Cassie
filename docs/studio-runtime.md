# Cassie Studio：语义事件与可视编辑

这条开发分支保留 `editor-core` 与 `harness`，增加可持久化的事件图、CLI、本地 HTTP 服务，以及实际使用 `@hyperframes/studio` 的客户端。原 `apps/web` 保留作为旧界面与回归基线。

## 启动

需要 Node.js 22+、npm、PATH 中的 ffmpeg/ffprobe。首次 Hyperframes 渲染可能需要 Chromium 下载。

```sh
npm ci
npm run build:client
npm run cassie -- init ./work/project.json
npm run cassie -- serve ./work/project.json --port 4317
```

打开 http://127.0.0.1:4317。`init` 是程序化人物动作工程测试，不是真人视频编辑验收。

## 编辑行为

- 时间轴使用 Hyperframes `Timeline`。拖动事件修改开始帧；两端裁剪修改时长；吸附、缩放与播放头由 Studio 提供。
- 相对事件移动只改 `offsetFrames`，保留 `eventId` 与 `edge`。后续事件、字幕、相机和语义生命周期递归重算。
- 单纯移动动作保留状态自带时长；裁剪动作创建显式 `durationOverrideFrames`，以后切换状态仍尊重用户裁剪。
- 画布使用 Hyperframes `DomEditOverlay`。图层选择与时间轴/设计属性联动，支持拖动、尺寸、旋转，以及属性栏颜色/文字编辑。
- 每次手势经过共享 `planDocumentEdit → applyDocumentEdit`，使用同一文件锁、版本校验、语义/轨道锁与审计记录；撤销恢复精确快照，版本号单调增加。
- 动作页先预演事件差异，再提交。需要视频模型的动作不能作为纯属性修改直接提交。
- 预览与 MP4 共用 `compileScene`。Hyperframes Producer 逐帧渲染；FFmpeg 处理媒体。

当前限定单事件/单图层手势。跨轨拖动不改变语义类型；多选批量修改、事件拆分、关键帧编辑器、音频监听与自动主体分割尚未实现。时间轴上的轨道隐藏属于 Studio 本地视图设置，不应视作导出内容修改。程序化合成器目前提供有限图层与动作通道，不等于支持任意 Hyperframes HTML 工程的往返编辑。

## Agent / CLI

在仓库根目录执行；输出为 JSON，错误为 JSON + 非零退出码。

```sh
npm run cassie -- help
npm run cassie -- inspect ./work/project.json
npm run cassie -- edit ./work/project.json --edit ./work/edit.json
npm run cassie -- rollback ./work/project.json --transaction TRANSACTION_ID
npm run cassie -- render ./work/project.json --out ./work/final.mp4
```

`edit.json` 示例：

```json
{"kind":"set-event-timing","eventId":"product-reveal","startFrame":96,"durationFrames":75}
```

或：

```json
{"kind":"set-layer","layerId":"actor","patch":{"x":210,"y":120,"rotation":10}}
```

动作修改使用 `plan --edit ... --out ...` 与 `apply --plan ...`。SDK 对应 `@cassie/harness` 导出的 `planAction/applyAction` 和 `planDocumentEdit/applyDocumentEdit`，UI 与 CLI 均调用这些函数。

## 真视频接入边界

`normalize input.mp4 --out cfr.mp4 --fps 24` 显式规范化变帧率输入。`import cfr.mp4 --out project.json --entity Alex --instruction '抬起右手'` 创建手工标注的镜头级视频编辑项目，不会自动识别人或改写像素。

`generate plan.json --provider provider.json --out run.json` 调用用户配置的进程（无 shell），stdin 为 `cassie/video-edit-request@1`，含源文件、帧域、动作与保留主体；stdout 返回 `{ "outputPath": "/absolute/candidate.mp4" }`。配置包含 `name/command/args/capabilities:["video-edit"]/projectRoot`；带人物遮罩的任务还需声明 `subject-mask` 能力。

候选通过帧率、尺寸、帧数与哈希校验后仍是 `awaiting-review`。`accept` 记录真实审核意见，生成 receipt，之后才能 `apply --receipt ...`。不能用模拟候选或程序化人物证明真人动作修改成功。

## 人物遮罩与实片案例

`import` 可用 `--cuts 44,97,241 --action-shot 0` 建立人工确认的镜头及原声事件。`matte project.json --event person-action` 在 macOS 上逐帧人物分割；`cutout ... --out foreground.webm` 导出保留原动作的透明片段。遮罩作为可撤销事务绑定事件、源哈希和帧域。

客户端新增“抠像”页和自然语言目标动作描述。`set-action-state` 可提供 `instruction` 和 `durationFrames`，自定义视频编辑状态；仅预演不会修改项目。`bundle plan.json --project project.json --out model-input` 裁出输入镜头、同步遮罩与请求，供模型接入。抠像并不生成新姿态，也不自动修复人物后面的背景。

详见 [Bali 实片验证与剩余边界](bali-case.md)。

## 成片导入与局部主体索引

`import-film film.json --out project.json` 把 Demo 成片描述导入为事件图：每个镜头是独立源片段，文案卡是文字事件，变帧率素材自动规整为 24fps 副本。封面与片尾包装记录在 `film` 实体上，暂不重建。

`track project.json --track track.json` 对镜头中的局部主体（如产品）逐帧求最小外接框。`track.json` 给出 `layerId/regionId/entityId/name` 与若干源帧关键框；两关键框之间前后双向跟踪并按距离融合，外侧延伸至硬切或框内画面不再匹配。框按源帧存储，镜头在时间轴上移动或裁剪时区域随之移动；区域事件可在时间轴裁剪以限定生效范围。多个镜头的区域可共用一个实体，`occurrences project.json --entity product` 列出全片出现处。

`set-region-look` 修改区域颜色/强度/羽化，作用于整段生命周期，与其他编辑一样可撤销。当前只是外接框级着色，不是精细遮罩，也不替换物体；精细遮罩、开放词汇检测与模型重绘是后续步骤。

## 验证与发布状态

```sh
npm test
npm run typecheck
npm run build:client
npm run build
npm run test:integration
```

当前包括事件依赖/条件、循环、锁、陈旧计划、篡改、时间轴写回、画布持久化、逐次撤销、HTTP 鉴权和落盘验证。已用客户端实际操作检查时间轴拖动与端点裁剪、画布拖动及连续撤销。

尚未发布 npm 包或安装器。商用发布前需完成真实模型与真实素材的验收、客户端打包、依赖许可证与安全审计、跨平台 FFmpeg/Chromium 分发。Hyperframes 锁定 0.8.128；未复制 Hypit 代码。本机 FFmpeg 是 GPL 构建，不能据此宣称闭源分发方案已经完成。当前客户端直接引用 Studio 公开组件，浏览器包仍较大，需要进一步按功能拆分。
