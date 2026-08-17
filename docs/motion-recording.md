# 运动录制与可编辑补间（设计原则）

来源：Framer Studio 的运动录制理念（2026-08-17 采纳）。这些原则将指导 Cassie 的运动/
动画功能设计，与「所有 AI 修改必须编译成可撤销的 Editor Commands」同源。

## 手势录制（Record gesture）

- 选择元素 → 按 R 开始录制 → 移动指针执行动作 → 再按 R 停止 → 播放并精修关键帧
- **拖动 = 位置；滚轮 = 深度（Z）**；修饰键切换旋转 / 3D 旋转 / 不透明度 / 缩放
- 内置快捷键面板始终可见，列出各修饰键的作用

## 录制只是起点（Starting performance, not polish）

- 录制产物是**起始表演**，不是成品：真实手势充满噪声
- 交付前必须：**简化噪声路径**（去抖、抽稀）→ **重新计时**（对齐场景节奏）
- Cassie 落点：录制轨迹经「简化 + retime」后以关键帧序列进入文档；
  简化与 retime 本身是可撤销的 Editor Commands

## 可展开的可编辑性（Unroll to edit）

- 代理/助手/循环/运行时表达式产生的运动，Studio 只能显示、不能安全改写
- **Unroll to edit**：把支持改写来源的运动展开为显式补间（tweens），编辑后才能落地
- 不可展开的**计算值**标注「在代码中编辑」——不伪装可编辑
- Cassie 落点：AI 生成的 motion_path **必须 unroll 为显式关键帧命令**才允许提交；
  无法展开的来源（如运行时表达式）在 UI 中明确标注，不提供假编辑

## 意图优于实现（Intent over implementation）

- 当「想要的结果」比「怎么写」更容易说清时：**把元素上下文复制给代理**，
  并描述希望保留的结果——让代理生成实现，人负责意图
- Cassie 落点：这恰是 Harness 的设计原语——用户说「让香水瓶从第 8 秒开始变蓝，
  Logo 保持」，上下文（主体、生命周期、约束）自动随事务携带，
  代理产物必须通过 GUARD 与 VALIDATING 才能落时间线

## 与现有架构的映射

| Studio 原则 | Cassie 实现 |
| --- | --- |
| Record gesture（R 键） | 舞台手势录制（Phase 3）：位置/深度/修饰键 → 关键帧命令 |
| 简化 + retime | 录制后处理命令（去抖/抽稀/对齐锚点），可撤销 |
| Unroll to edit | AI motion 必须编译为 setClipAttrs 显式关键帧，否则标注计算值 |
| Computed value | clip.attrs 来源标记（recorded/ai/runtime），runtime 来源禁编辑 |
| Copy context to agent | EditTransaction 自动携带主体上下文与约束（已实现） |
