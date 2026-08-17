import { describe, expect, it } from "vitest";
import {
  LocalAdapter,
  applyCommand,
  buildExportPlan,
  compositeCmd,
  dryRun,
  findClip,
  moveClipCmd,
  replaceMediaCmd,
  serializeProject,
  parseProjectFile,
  setClipAttrsCmd,
  setClipRangeCmd,
  splitClipCmd,
  trimClipCmd,
} from "@cassie/editor-core";
import { makeFixtureProject } from "./helpers";

describe("editor-core · 命令系统", () => {
  it("splitClip 切分并可通过 inverse 精确还原", () => {
    const p = makeFixtureProject();
    const before = structuredClone(p);
    const r = applyCommand(p, splitClipCmd("clip_bottle", 8_000_000));
    // 头部保留原 id，尾部新 id
    const head = findClip(r.project, "clip_bottle")!;
    expect(head.clip.endUs).toBe(8_000_000);
    const tail = head.track.clips[head.track.clips.findIndex((c) => c.id === "clip_bottle") + 1]!;
    expect(tail.startUs).toBe(8_000_000);
    expect(tail.sourceInUs).toBe(4_000_000); // 素材入点顺延
    // undo
    const back = applyCommand(r.project, r.inverse).project;
    expect(back).toEqual(before);
  });

  it("trimClip 两端裁剪 + 边界夹取 + 精确还原", () => {
    const p = makeFixtureProject();
    const t1 = applyCommand(p, trimClipCmd("clip_bottle", "start", 1_000_000)).project;
    const c1 = findClip(t1, "clip_bottle")!.clip;
    expect(c1.startUs).toBe(5_000_000);
    expect(c1.sourceInUs).toBe(1_000_000);

    // 向素材边界外扩展 → 夹取到素材入点 0（start 回到 4s）
    const t2 = applyCommand(t1, trimClipCmd("clip_bottle", "start", -99_000_000)).project;
    const c2 = findClip(t2, "clip_bottle")!.clip;
    expect(c2.startUs).toBe(4_000_000);
    expect(c2.sourceInUs).toBe(0);

    // end 边缘：素材可用范围夹取（asset_bottle 共 15s）
    const t3 = applyCommand(t2, trimClipCmd("clip_bottle", "end", -99_000_000)).project;
    const c3 = findClip(t3, "clip_bottle")!.clip;
    expect(c3.endUs - c3.startUs).toBe(15_000_000);
  });

  it("moveClip 跨轨移动 + inverse 返回原轨原位", () => {
    const p = makeFixtureProject();
    const r = applyCommand(p, moveClipCmd("clip_bottle", 2_000_000, "track_video"));
    const moved = findClip(r.project, "clip_bottle")!.clip;
    expect(moved.startUs).toBe(2_000_000);
    const back = applyCommand(r.project, r.inverse).project;
    const restored = findClip(back, "clip_bottle")!.clip;
    expect(restored.startUs).toBe(4_000_000);
  });

  it("replaceMedia keepHead 夹取时长，inverse 精确还原", () => {
    const p = makeFixtureProject();
    const r = applyCommand(p, replaceMediaCmd("clip_bottle", "asset_silver"));
    const replaced = findClip(r.project, "clip_bottle")!.clip;
    expect(replaced.assetId).toBe("asset_silver");
    const back = applyCommand(r.project, r.inverse).project;
    expect(back).toEqual(p);
  });

  it("setClipAttrs 合并与替换，inverse 还原", () => {
    const p = makeFixtureProject();
    const r = applyCommand(p, setClipAttrsCmd("clip_bottle", { appearance: { color: "deep_blue" } }));
    expect(findClip(r.project, "clip_bottle")!.clip.attrs.appearance).toEqual({
      variant: "glass_violet",
      color: "deep_blue",
    });
    const back = applyCommand(r.project, r.inverse).project;
    expect(back).toEqual(p);
  });

  it("批量命令原子性：非法批不改状态", () => {
    const p = makeFixtureProject();
    const before = p.revision;
    expect(() =>
      dryRun(p, [splitClipCmd("clip_bottle", 8_000_000), splitClipCmd("clip_bottle", 99_000_000)]),
    ).toThrow();
    expect(p.revision).toBe(before);
    expect(findClip(p, "clip_bottle")!.clip.endUs).toBe(15_000_000);
  });

  it("setClipRange 负入点被拒绝", () => {
    const p = makeFixtureProject();
    expect(() => applyCommand(p, setClipRangeCmd("clip_bottle", { startUs: -1 }))).toThrow();
  });
});

describe("editor-core · Adapter 历史与序列化", () => {
  it("apply → undo → redo 全程精确", () => {
    // revision 单调递增（每次状态变更 +1），文档内容需精确还原
    const stripRev = (p: unknown) => {
      const { revision: _r, ...rest } = p as Record<string, unknown>;
      return rest;
    };
    const adapter = new LocalAdapter(makeFixtureProject());
    const before = stripRev(structuredClone(adapter.getProject()));
    adapter.applyCommands([splitClipCmd("clip_bottle", 8_000_000)]);
    const afterSplit = stripRev(structuredClone(adapter.getProject()));
    expect(afterSplit).not.toEqual(before);
    adapter.undo();
    expect(stripRev(adapter.getProject())).toEqual(before);
    adapter.redo();
    expect(stripRev(adapter.getProject())).toEqual(afterSplit);
    expect(adapter.canRedo()).toBe(false);
  });

  it("保存 → 加载 round-trip（runtime url 剥离与恢复）", () => {
    const adapter = new LocalAdapter(makeFixtureProject());
    adapter.getProject().assets.asset_bottle!.url = "blob:mock-url";
    const json = adapter.save();
    expect(json).not.toContain("blob:mock-url");
    const adapter2 = new LocalAdapter(adapter.getProject());
    adapter2.load(json);
    expect(adapter2.getProject().assets.asset_bottle!.url).toBeUndefined();
    adapter2.rehydrate((id) => (id === "asset_bottle" ? "blob:restored" : undefined));
    expect(adapter2.getProject().assets.asset_bottle!.url).toBe("blob:restored");
    // 除 url 外完全一致
    const a = structuredClone(adapter.getProject());
    delete a.assets.asset_bottle!.url;
    const b = structuredClone(adapter2.getProject());
    delete b.assets.asset_bottle!.url;
    expect(b).toEqual(a);
  });

  it("版本信封：非法 schema/version 被拒绝", () => {
    const adapter = new LocalAdapter(makeFixtureProject());
    const file = serializeProject(adapter.getProject());
    expect(() => parseProjectFile(JSON.stringify({ ...file, version: 99 }))).toThrow(/版本/);
    expect(() => parseProjectFile(JSON.stringify({ schema: "x", version: 1, project: file.project }))).toThrow(/schema/);
  });
});

describe("editor-core · 导出计划（确定性）", () => {
  it("NOCTURNE 项目编译出稳定 filter_complex", () => {
    const p = makeFixtureProject();
    const plan = buildExportPlan(p);
    expect(plan.inputs).toHaveLength(4); // night/mia/bottle/music
    expect(plan.filterComplex).toContain("trim=start=");
    expect(plan.filterComplex).toContain("drawtext=text='NOCTURNE'");
    expect(plan.filterComplex).toContain("amix=inputs=1");
    expect(plan.outputArgs).toContain("libx264");
    expect(plan.durationSec).toBe(15);
    // 同一文档两次编译 = 字节级一致
    expect(buildExportPlan(p).filterComplex).toBe(plan.filterComplex);
  });

  it("切分 + 替换后导出计划随文档变化", () => {
    const adapter = new LocalAdapter(makeFixtureProject());
    adapter.applyCommands([
      splitClipCmd("clip_bottle", 8_000_000),
      replaceMediaCmd("clip_bottle", "asset_silver"),
    ]);
    const plan = buildExportPlan(adapter.getProject());
    expect(plan.inputs).toHaveLength(5); // + silver
    expect(plan.filterComplex).toContain("duration=4.000000"); // 头部 4s
  });
});
