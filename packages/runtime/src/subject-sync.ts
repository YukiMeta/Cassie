import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { DocumentEdit, EventDocument, MediaReference } from "@cassie/spec";
import type { MediaAsset } from "@cassie/editor-core";
import { EventError, staleSubjects, subjectRefsFor } from "@cassie/harness";
import { runProcess, sha256, verifiedMedia } from "./media";
import { importTake } from "./variants";

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

/** Copies a reference image into the project and returns the edit that makes it the subject's target look. */
export async function importSubjectReference(root: string, image: string, entityId: string, prompt: string, instruction: string, name?: string, scope?: Record<string, string>): Promise<Extract<DocumentEdit, { kind: "set-subject-reference" }>> {
  const ext = extname(image).toLowerCase();
  if (!IMAGE_TYPES[ext]) throw new EventError("INVALID_REFERENCE", "Reference must be png, jpg or webp");
  const info = JSON.parse(await runProcess("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", image]));
  const width = Number(info.streams?.[0]?.width), height = Number(info.streams?.[0]?.height);
  if (!(width > 0 && height > 0)) throw new EventError("INVALID_REFERENCE", "Unreadable image");
  const hash = await sha256(image), path = `media/${hash}${ext}`, assetId = `ref-${hash.slice(0, 12)}`;
  await mkdir(join(root, "media"), { recursive: true });
  if (resolve(image) !== resolve(join(root, path))) await copyFile(image, join(root, path));
  const asset: MediaAsset = { id: assetId, kind: "image", name: image.split("/").pop()!, durationUs: 0, width, height };
  const media: MediaReference = { path, sha256: hash };
  return { kind: "set-subject-reference", entityId, ...(name ? { name } : {}), reference: { entityId, ...(scope && Object.keys(scope).length ? { scope } : {}), assetId, sha256: hash, prompt, instruction }, asset, media };
}

/**
 * What a segment-and-replace provider needs to bring one take in line with the master's subject
 * references: the take, every stale subject's reference image and SAM 3 concept prompt. Pixels outside
 * the segmented subject must come back unchanged.
 */
export async function planSubjectSync(d: EventDocument, root: string, variantId: string, outDir: string) {
  const v = d.variants?.items[variantId];
  if (!v?.take) throw new EventError("MISSING_TAKE", `Variant ${variantId} has no take to sync`);
  const stale = staleSubjects(d, v);
  if (!stale.length) throw new EventError("NO_CHANGE", "This take already matches every subject reference");
  await mkdir(outDir, { recursive: true });
  const take = join(outDir, "take.mp4");
  await copyFile(await verifiedMedia(root, d.media[v.take.assetId]!), take);
  const subjects = [], refs = subjectRefsFor(d, v);
  for (const entityId of stale) {
    const r = refs[entityId]!, ref = d.media[r.assetId]!;
    const file = join(outDir, `reference-${entityId}${extname(ref.path)}`);
    await copyFile(await verifiedMedia(root, ref), file);
    subjects.push({ entityId, name: d.semantic.entities[entityId]!.name, prompt: r.prompt, instruction: r.instruction, referencePath: file, referenceSha256: r.sha256 });
  }
  const request = { schema: "cassie/subject-sync@1", variantId, takePath: take, take: { width: v.take.width, height: v.take.height, durationUs: v.take.durationUs }, subjects, preserve: "Every pixel outside the segmented subjects stays identical to the take." };
  await writeFile(join(outDir, "request.json"), JSON.stringify(request, null, 2));
  return request;
}

export interface SubjectProvider { name: string; command: string; args: string[]; capabilities: string[] }

/** Runs the provider on a planned request and returns the edit that attaches its output as the new take. */
export async function runSubjectSync(d: EventDocument, root: string, request: Awaited<ReturnType<typeof planSubjectSync>>, provider: SubjectProvider) {
  if (!provider?.name || typeof provider.command !== "string" || !Array.isArray(provider.args) || !provider.capabilities?.includes("subject-sync")) throw new EventError("PROVIDER_CAPABILITY", "Provider must declare subject-sync, command and args");
  const reply = JSON.parse(await runProcess(provider.command, provider.args, { stdin: JSON.stringify(request), timeoutMs: 1_800_000 }));
  if (typeof reply.outputPath !== "string") throw new EventError("PROVIDER_RESULT", "Provider must return JSON with outputPath");
  return attachSyncedTake(d, root, request.variantId, resolve(reply.outputPath), provider.name, request.subjects.map(s => s.entityId));
}

/** A synced take is a new take: its basis records the references it was made with, and review starts over. */
export async function attachSyncedTake(d: EventDocument, root: string, variantId: string, candidate: string, provider: string, entityIds: string[]): Promise<DocumentEdit> {
  const v = d.variants?.items[variantId];
  if (!v?.take) throw new EventError("MISSING_TAKE", variantId);
  const { asset, media, take } = await importTake(root, candidate);
  if (Math.abs(take.width / take.height - v.take.width / v.take.height) > 0.01) throw new EventError("VARIANT_ASPECT", "Synced take changed the canvas aspect");
  const basis = { ...v.take.basis }, refs = subjectRefsFor(d, v);
  for (const id of entityIds) {
    const r = refs[id];
    if (!r) throw new EventError("MISSING_REFERENCE", id);
    basis[id] = r.sha256;
  }
  return { kind: "attach-variant-take", variantId, take: { ...take, provider, basis }, asset, media };
}
