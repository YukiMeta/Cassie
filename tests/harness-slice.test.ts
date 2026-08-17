import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalAdapter, findClip } from "@cassie/editor-core";
import { Harness, type EditTransaction } from "@cassie/harness";
import { makeFixtureProject, makeSemanticProject, normalizeForGolden } from "./helpers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(__dirname, "golden", "nocturne-slice.json");

/**
 * 垂直切片：选择香水瓶 → 修改完整生命周期 → 影响预览 → 提交 → 撤销。
 * 验收线：Cassie 发出的语义修改，确定性改变真实时间线，且保存/恢复/撤销/导出成立。
 */
function runSlice() {
  const adapter = new LocalAdapter(makeFixtureProject());
  const harness = new Harness(adapter, makeSemanticProject());
  const txLog: Record<string, unknown>[] = [];
  const record = (tx: EditTransaction) =>
    txLog.push({
      id: tx.id,
      status: tx.status,
      intent: tx.intent,
      subjectId: tx.subjectId,
      lifecycleBefore: tx.lifecycleBefore,
      lifecycleAfter: tx.lifecycleAfter,
      commands: tx.commands,
      guards: tx.guards,
    });

  // 1. 全生命期替换
  const tx1 = harness.compile("把香水瓶替换成磨砂银瓶，从第一次出现到消失都保持同一个商品", {
    selectedEntityId: "product",
  });
  expect(tx1.status).toBe("PLANNED");
  harness.commit(tx1);
  expect(tx1.status).toBe("COMMITTED");
  record(tx1);

  // 2. 撤销
  adapter.undo();
  txLog.push({ undo: true, revision: adapter.getProject().revision });

  // 3. 提前露出（重做替换 + 时间移动）
  const tx2 = harness.compile("把商品第一次出现提前2秒，音乐节奏保持不变", {
    selectedEntityId: "product",
  });
  expect(tx2.status).toBe("PLANNED");
  harness.commit(tx2);
  expect(tx2.status).toBe("COMMITTED");
  record(tx2);

  // 4. 保存 round-trip
  const json = adapter.save();
  const adapter2 = new LocalAdapter(makeFixtureProject());
  adapter2.load(json);
  expect(adapter2.getProject()).toEqual(adapter.getProject());

  return { adapter, json, txLog };
}

describe("harness · NOCTURNE 垂直切片", () => {
  it("全生命期替换：编译 → 提交 → 影响分析 → 撤销", () => {
    const adapter = new LocalAdapter(makeFixtureProject());
    const harness = new Harness(adapter, makeSemanticProject());

    const tx = harness.compile("把香水瓶替换成磨砂银瓶，从第一次出现到消失都保持同一个商品", {
      selectedEntityId: "product",
    });
    expect(tx.status).toBe("PLANNED");
    expect(tx.subjectId).toBe("product");
    expect(tx.lifecycleBefore).toEqual({ enterUs: 4_000_000, exitUs: 15_000_000 });
    expect(tx.commands).toHaveLength(1);
    expect(tx.commands[0]).toEqual({
      kind: "setClipAttrs",
      clipId: "clip_bottle",
      attrs: { appearance: { variant: "matte_silver" } },
    });
    // 影响分析：主状态 + 手持关系 + 构图 + 保护约束（各类目首次出现顺序）
    expect([...new Set(tx.impact.rows.map((r) => r.kind))]).toEqual(["主状态", "关系", "构图", "保护"]);
    expect(tx.impact.rows.find((r) => r.kind === "关系")?.copy).toContain("手持");

    harness.commit(tx);
    expect(tx.status).toBe("COMMITTED");
    expect(findClip(adapter.getProject(), "clip_bottle")!.clip.attrs.appearance).toEqual({
      variant: "matte_silver",
    });
    expect(tx.lifecycleAfter).toEqual({ enterUs: 4_000_000, exitUs: 15_000_000 });

    // 撤销：时间线回到修改前
    adapter.undo();
    expect(findClip(adapter.getProject(), "clip_bottle")!.clip.attrs.appearance).toEqual({
      variant: "glass_violet",
    });
  });

  it("提前露出：生命周期 4s→15s 变为 2s→13s，撤销还原", () => {
    const adapter = new LocalAdapter(makeFixtureProject());
    const harness = new Harness(adapter, makeSemanticProject());

    const tx = harness.compile("把商品第一次出现提前2秒，音乐节奏保持不变", {
      selectedEntityId: "product",
    });
    expect(tx.status).toBe("PLANNED");
    expect(tx.commands[0]).toEqual({
      kind: "setClipRange",
      clipId: "clip_bottle",
      startUs: 2_000_000,
      endUs: 13_000_000,
    });
    harness.commit(tx);
    const clip = findClip(adapter.getProject(), "clip_bottle")!.clip;
    expect(clip.startUs).toBe(2_000_000);
    expect(clip.endUs).toBe(13_000_000);
    expect(tx.lifecycleAfter).toEqual({ enterUs: 2_000_000, exitUs: 13_000_000 });

    adapter.undo();
    const restored = findClip(adapter.getProject(), "clip_bottle")!.clip;
    expect(restored.startUs).toBe(4_000_000);
    expect(restored.endUs).toBe(15_000_000);
  });

  it("硬锁阻断：锁定商品后 GUARDED 阶段失败，时间线不变", () => {
    const adapter = new LocalAdapter(makeFixtureProject());
    const semantic = makeSemanticProject();
    semantic.constraints.push({ id: "c_product_lock", kind: "lock", what: "product", scope: "entity" });
    const harness = new Harness(adapter, semantic);

    const before = adapter.getProject().revision;
    const tx = harness.compile("把香水瓶替换成磨砂银瓶，从第一次出现到消失都保持同一个商品", {
      selectedEntityId: "product",
    });
    expect(tx.status).toBe("FAILED");
    expect(tx.error).toContain("硬锁");
    expect(adapter.getProject().revision).toBe(before);
    expect(findClip(adapter.getProject(), "clip_bottle")!.clip.attrs.appearance?.variant).toBe("glass_violet");
  });

  it("Golden 回归：NOCTURNE 切片全流程快照", () => {
    const { json, txLog } = runSlice();
    const actual = normalizeForGolden({ projectJson: JSON.parse(json), txLog });

    if (process.env.UPDATE_GOLDEN === "1") {
      mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
      writeFileSync(GOLDEN_PATH, JSON.stringify(actual, null, 2));
      return;
    }
    expect(existsSync(GOLDEN_PATH)).toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf-8"));
    expect(actual).toEqual(golden);
  });
});
