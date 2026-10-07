import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkspace, planAction, applyAction } from "@cassie/harness";
import { writeJson, updateWorkspace, readWorkspace } from "../packages/runtime/src/store";
import { compileScene } from "../packages/runtime/src/render";
import { sha256, verifiedMedia } from "../packages/runtime/src/media";

describe("portable runtime", () => {
  it("atomically persists the transaction and rejects a simultaneous writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "cassie-test-"));
    try {
      const file = join(root, "project.json");
      const ws = parseWorkspace(await readFile(new URL("../examples/action-flow/project.cassie.json", import.meta.url), "utf8"));
      await writeJson(file, ws);
      await writeFile(file + ".lock", "owned");
      await expect(updateWorkspace(file, x => x)).rejects.toThrow(/Another writer/);
      await rm(file + ".lock");
      const plan = planAction(ws.document, { kind: "set-action-state", eventId: "greeting", state: "point" });
      await updateWorkspace(file, x => applyAction(x, plan));
      expect((await readWorkspace(file)).document.editor.revision).toBe(1);
      await expect(updateWorkspace(file, x => applyAction(x, plan))).rejects.toThrow(/changed after planning/);
      expect((await readWorkspace(file)).transactions).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("detects changed media bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "cassie-media-"));
    try {
      const path = join(root, "asset.mp4"); await writeFile(path, "source");
      const ref = { path: "asset.mp4", sha256: await sha256(path) };
      expect(await verifiedMedia(root, ref)).toContain("asset.mp4");
      await writeFile(path, "changed");
      await expect(verifiedMedia(root, ref)).rejects.toThrow(/Media changed/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("escapes authored text and embeds the same event clock for preview/export", async () => {
    const ws = parseWorkspace(await readFile(new URL("../examples/action-flow/project.cassie.json", import.meta.url), "utf8"));
    ws.document.events[2]!.text = '</script><script>alert("x")</script>';
    const html = compileScene(ws.document);
    expect(html).not.toContain('</script><script>alert');
    expect(html).toContain('data-fps="30/1"');
    expect(html).toContain('window.cassieSeek=previewSeek');
    expect(html).toContain('hf-seek');
  });
});
