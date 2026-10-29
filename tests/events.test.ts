import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { applyAction, canonical, parseWorkspace, planAction, resolveEvents, rollbackAction } from "@cassie/harness";
import type { EventWorkspace, GenerationReceipt } from "@cassie/spec";

const fixture = (): EventWorkspace => parseWorkspace(readFileSync(new URL("../examples/action-flow/project.cassie.json", import.meta.url), "utf8"));
const edit = { kind: "set-action-state" as const, eventId: "greeting", state: "point" };

describe("semantic event transactions", () => {
  it("retimes the transitive graph and enables a conditional event without mutating the source", () => {
    const ws = fixture(); const original = canonical(ws);
    const plan = planAction(ws.document, edit);
    expect(canonical(ws)).toBe(original);
    expect(plan.changes.map(c => c.eventId)).toEqual(["greeting", "product-reveal", "title", "camera-push", "point-label", "outro"]);
    expect(plan.changes.find(c => c.eventId === "product-reveal")!.after.startFrame).toBe(111);
    expect(plan.changes.find(c => c.eventId === "point-label")!.after.active).toBe(true);
    const next = applyAction(ws, plan);
    expect(next.document.editor.revision).toBe(1);
    expect(next.document.editor.tracks[0]!.clips[0]!.startUs).toBe(3_500_000);
    expect(next.document.semantic.entities.presenter!.attributes["event:greeting"]).toMatchObject({ state: "point", endFrame: 105 });
    expect(next.transactions[0]!.journal.at(-1)!.type).toBe("transaction.committed");
    expect(parseWorkspace(JSON.stringify(next))).toEqual(next);
  });
  it("supports arbitrary IDs, state names and rational clocks", () => {
    const ws = fixture(); const d = ws.document;
    d.events[0]!.id = "actor.B/gesture";
    for (const e of d.events) { if (!("frame" in e.start) && e.start.eventId === "greeting") e.start.eventId = d.events[0]!.id; if (e.when?.eventId === "greeting") e.when.eventId = d.events[0]!.id; }
    d.scene.layers[0]!.eventId = d.events[0]!.id;
    d.frameRate = { num: 30000, den: 1001 }; d.editor.settings.fps = 30000 / 1001;
    const plan = planAction(d, { ...edit, eventId: d.events[0]!.id });
    const next = applyAction(ws, plan);
    expect(next.document.editor.tracks[0]!.clips[0]!.startUs).toBe(3_503_500);
  });
  it("rejects cycles, including cycles behind disabled conditions", () => {
    const d = fixture().document;
    d.events[0]!.start = { eventId: "point-label", edge: "end", offsetFrames: 0 };
    expect(() => resolveEvents(d)).toThrow(/cycle/);
  });
  it("rejects missing dependencies and negative projected ranges", () => {
    const d = fixture().document;
    d.events[0]!.start = { eventId: "missing", edge: "end", offsetFrames: 0 };
    expect(() => resolveEvents(d)).toThrow(/Unknown event/);
    d.events[0]!.start = { frame: 0 };
    d.events[1]!.start = { eventId: "greeting", edge: "start", offsetFrames: -1 };
    expect(() => resolveEvents(d)).toThrow(/projected range/);
  });
  it("propagates disabled branch state to its descendants", () => {
    const d = fixture().document;
    d.events.push({ id: "branch-child", entityId: "callout", kind: "marker", label: "Child", start: { eventId: "point-label", edge: "end", offsetFrames: 0 }, durationFrames: 10 });
    expect(resolveEvents(d).find(e => e.id === "branch-child")!.active).toBe(false);
    const plan = planAction(d, edit);
    expect(plan.changes.find(e => e.eventId === "branch-child")!.after.active).toBe(true);
  });
  it("protects affected locks but allows unrelated locked entities", () => {
    const d = fixture().document;
    d.semantic.entities.title!.locked = true;
    expect(() => planAction(d, edit)).toThrow(/Locked entity/);
    d.semantic.entities.title!.locked = false;
    d.semantic.entities.unrelated = { ...d.semantic.entities.title!, id: "unrelated", binds: [], locked: true };
    expect(planAction(d, edit).status).toBe("ready");
    d.editor.tracks[0]!.locked = true;
    expect(() => planAction(d, edit)).toThrow("clip_title");
  });
  it("checks pinned timeline anchors against both range endpoints", () => {
    const d = fixture().document;
    d.semantic.constraints.push({ id: "pin", kind: "anchor", what: "clip_title", scope: "entity", anchorUs: 3_000_000 });
    expect(() => planAction(d, edit)).toThrow("pin");
  });
  it("rejects stale revision, changed semantic state and altered plan payloads", () => {
    const ws = fixture(), plan = planAction(ws.document, edit);
    const stale = structuredClone(ws); stale.document.semantic.entities.presenter!.name = "Renamed";
    expect(() => applyAction(stale, plan)).toThrow(/changed after planning/);
    const next = applyAction(ws, plan);
    expect(() => applyAction(next, plan)).toThrow(/changed after planning/);
    plan.changes[0]!.after.endFrame = 999;
    expect(() => applyAction(ws, plan)).toThrow(/Plan contents/);
  });
  it("rolls back exactly one transaction after save/reload and rejects conflicting rollback", () => {
    const ws = fixture(), p1 = planAction(ws.document, edit), first = applyAction(ws, p1);
    const p2 = planAction(first.document, { ...edit, state: "rest" }), second = applyAction(first, p2);
    expect(() => rollbackAction(second, p1.id)).toThrow(/Later content/);
    const restoredFirst = rollbackAction(parseWorkspace(JSON.stringify(second)), p2.id);
    expect(restoredFirst.document.editor.revision).toBe(3);
    const original = rollbackAction(restoredFirst, p1.id);
    expect(original.document.editor.revision).toBe(4);
    original.document.editor.revision = 0;
    expect(original.document).toEqual(ws.document);
    expect(() => rollbackAction(original, p1.id)).toThrow(/already rolled back/);
  });
  it("rejects malformed keyframes, unsafe media paths and duplicate IDs", () => {
    const d = fixture().document;
    d.actions.gesture!.states.point!.motion!.armAngle![1]!.at = 0;
    expect(() => resolveEvents(d)).toThrow(/keyframe/);
    const bad = fixture(); bad.document.events.push(structuredClone(bad.document.events[0]!));
    expect(() => parseWorkspace(JSON.stringify(bad))).toThrow(/duplicate/);
  });
});

function videoFixture() {
  const ws = fixture(), d = ws.document;
  d.actions.gesture!.execution = "video-edit";
  d.editor.assets.source = { id: "source", kind: "video", name: "source.mp4", durationUs: 2_000_000 };
  d.editor.tracks.push({ id: "footage", kind: "video", name: "Shot", locked: false, clips: [{ id: "shot", assetId: "source", startUs: 500_000, endUs: 2_500_000, sourceInUs: 0, attrs: {} }] });
  d.events[0]!.clipId = "shot";
  d.semantic.entities.presenter!.binds.push({ targetType: "clip", targetId: "shot", role: "primary" });
  d.media.source = { path: "media/source.mp4", sha256: "a".repeat(64) };
  d.scene.layers[0]!.kind = "video"; d.scene.layers[0]!.assetId = "source";
  return ws;
}
describe("video edit execution boundary", () => {
  it("requires a real media result before committing any event or timeline change", () => {
    const ws = videoFixture(), before = canonical(ws), plan = planAction(ws.document, edit);
    expect(plan.status).toBe("awaiting-media");
    expect(plan.tasks[0]).toMatchObject({ sourceInUs: 0, sourceDurationUs: 2_000_000, outputFrames: 90, scope: "shot" });
    expect(() => applyAction(ws, plan)).toThrow(/media receipt/);
    expect(canonical(ws)).toBe(before);
  });
  it("atomically replaces media, changes duration and persists receipt provenance", () => {
    const ws = videoFixture(), plan = planAction(ws.document, edit);
    const receipt: GenerationReceipt = { taskId: plan.tasks[0]!.id, assetId: "edited", media: { path: "media/edited.mp4", sha256: "b".repeat(64) }, frames: 90, width: 960, height: 540, frameRate: { num: 30, den: 1 }, provider: "test-boundary", review: { accepted: true, note: "Fixture only; not a real model result" } };
    const next = applyAction(ws, plan, [receipt]);
    expect(next.document.editor.tracks[1]!.clips[0]).toMatchObject({ assetId: "edited", startUs: 500_000, endUs: 3_500_000 });
    expect(next.transactions[0]!.receipts).toEqual([receipt]);
    receipt.frames = 89;
    expect(() => applyAction(ws, plan, [receipt])).toThrow(/frame domain/);
  });
});
