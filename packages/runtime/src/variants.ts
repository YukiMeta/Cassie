import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DocumentEdit, EventDocument, EventWorkspace, MediaReference, Variant, VariantAxis, VariantSet, VariantTake } from "@cassie/spec";
import type { MediaAsset } from "@cassie/editor-core";
import { applyDocumentEdit, aspectRatio, canonical, EventError, planDocumentEdit, variantAspect } from "@cassie/harness";
import { runProcess, sha256 } from "./media";

/**
 * A take is a finished deliverable, so it keeps its own canvas, duration and frame timing.
 * Unlike source shots it is never normalized into the master's frame domain.
 */
export async function importTake(root: string, file: string): Promise<{ asset: MediaAsset; media: MediaReference; take: Omit<VariantTake, "provider"> }> {
  const info = JSON.parse(await runProcess("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file]));
  const width = Number(info.streams?.[0]?.width), height = Number(info.streams?.[0]?.height), seconds = Number(info.format?.duration);
  if (!(width > 0 && height > 0 && seconds > 0)) throw new EventError("INVALID_TAKE", `Unreadable take: ${file}`);
  const hash = await sha256(file), path = `media/${hash}.mp4`, assetId = `take-${hash.slice(0, 12)}`;
  await mkdir(join(root, "media"), { recursive: true });
  const target = join(root, path);
  if (resolve(file) !== resolve(target)) await copyFile(file, target);
  if (await sha256(target) !== hash) throw new EventError("MEDIA_CHANGED", "Take changed during import");
  const durationUs = Math.round(seconds * 1e6);
  return {
    asset: { id: assetId, kind: "video", name: file.split("/").pop()!, durationUs, width, height },
    media: { path, sha256: hash },
    take: { assetId, sha256: hash, width, height, durationUs },
  };
}

/** `take-{market}-{aspect}-{location}.mp4` → axis ids in order and a matcher for file names. */
export function takePattern(pattern: string): { axes: string[]; match: (name: string) => Record<string, string> | null } {
  const axes: string[] = [];
  const source = pattern.split(/(\{[a-z][a-z0-9-]*\})/).map(part => {
    const m = part.match(/^\{([a-z][a-z0-9-]*)\}$/);
    if (!m) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (axes.includes(m[1]!)) throw new EventError("INVALID_PATTERN", `Axis ${m[1]} appears twice`);
    axes.push(m[1]!);
    return "([a-z0-9]+)";
  }).join("");
  if (!axes.length) throw new EventError("INVALID_PATTERN", "Pattern needs at least one {axis}");
  const re = new RegExp(`^${source}$`, "i");
  return { axes, match: name => { const m = re.exec(name); return m ? Object.fromEntries(axes.map((a, i) => [a, m[i + 1]!.toLowerCase()])) : null; } };
}

export const variantId = (axes: VariantAxis[], coords: Record<string, string>) => axes.map(a => coords[a.id]).join("-");

export interface VariantImportOptions {
  pattern: string;
  provider: string;
  brief?: string;
  keep?: string[];
  /** Human labels and generator attributes per axis value, e.g. `{ market: { jp: { label: "Japan", attrs: { language: "日本語" } } } }`. */
  labels?: Record<string, Record<string, { label?: string; attrs?: Record<string, string> }>>;
  axisLabels?: Record<string, string>;
}

/**
 * Turns a folder of finished takes into variant-set edits: axes come from the file names, every file
 * becomes one variant with its take attached and pending review. Re-running only adds what is new.
 */
export async function planVariantImport(document: EventDocument, root: string, dir: string, options: VariantImportOptions, progress = (_: string) => {}): Promise<DocumentEdit[]> {
  const master = document.variants?.masterAssetId ?? Object.values(document.editor.assets).find(a => a.kind === "video" && document.media[a.id])?.id;
  if (!master) throw new EventError("NO_MASTER", "Import the original video before its variants");
  const { axes: axisIds, match } = takePattern(options.pattern);
  const files = (await readdir(dir)).sort().flatMap(name => { const coords = match(name); return coords ? [{ name, coords }] : []; });
  if (!files.length) throw new EventError("NO_TAKES", `No file in ${dir} matches ${options.pattern}`);

  const existing = document.variants;
  if (existing && canonicalAxes(existing.axes) !== axisIds.join(",")) throw new EventError("AXIS_MISMATCH", `This project's variants use axes ${canonicalAxes(existing.axes)}`);
  const axes: VariantAxis[] = axisIds.map(id => {
    const before = existing?.axes.find(a => a.id === id);
    const values = [...(before?.values ?? [])];
    for (const value of new Set(files.map(f => f.coords[id]!))) {
      if (values.some(v => v.id === value)) continue;
      const meta = options.labels?.[id]?.[value];
      const attrs = { ...(aspectRatio(value) ? { aspect: value } : {}), ...meta?.attrs };
      values.push({ id: value, label: meta?.label ?? value.toUpperCase(), ...(Object.keys(attrs).length ? { attrs } : {}) });
    }
    return { id, label: before?.label ?? options.axisLabels?.[id] ?? id, values };
  });
  const set: Omit<VariantSet, "items"> = { masterAssetId: master, keep: options.keep ?? existing?.keep ?? [], brief: options.brief ?? existing?.brief ?? "", axes };
  const edits: DocumentEdit[] = [];
  if (!existing || canonical({ ...existing, items: undefined }) !== canonical(set)) edits.push({ kind: "set-variant-set", set });

  const items = existing?.items ?? {};
  const fresh: Variant[] = files.map(f => ({ id: variantId(axes, f.coords), coords: f.coords, review: "pending" as const })).filter(v => !items[v.id]);
  if (fresh.length) edits.push({ kind: "add-variants", items: fresh });

  for (const [i, f] of files.entries()) {
    const id = variantId(axes, f.coords);
    progress(`${i + 1}/${files.length} ${f.name}`);
    const { asset, media, take } = await importTake(root, join(dir, f.name));
    if (items[id]?.take?.sha256 === take.sha256) continue;
    edits.push({ kind: "attach-variant-take", variantId: id, take: { ...take, provider: options.provider }, asset, media });
  }
  return edits;
}

const canonicalAxes = (axes: VariantAxis[]) => axes.map(a => a.id).join(",");

/** Applies edits in order as separate transactions, so each one can be rolled back on its own. */
export function applyEdits(workspace: EventWorkspace, edits: DocumentEdit[]): EventWorkspace {
  return edits.reduce((ws, edit) => applyDocumentEdit(ws, planDocumentEdit(ws.document, edit)), workspace);
}

/**
 * One flat row per variant, in the shape a HyperFrames batch render takes: axis values, their
 * attributes, the merged brief and the take path. `output` follows the naming template.
 */
export function variantRows(document: EventDocument, output = "{id}.mp4") {
  const set = document.variants;
  if (!set) throw new EventError("NO_VARIANTS", "Project has no variants");
  return Object.values(set.items).map(v => {
    const row: Record<string, string> = { id: v.id };
    for (const axis of set.axes) {
      const value = axis.values.find(x => x.id === v.coords[axis.id])!;
      row[axis.id] = value.id;
      row[`${axis.id}Label`] = value.label;
      for (const [k, x] of Object.entries(value.attrs ?? {})) row[k] = x;
    }
    const aspect = variantAspect(set, v.coords);
    if (aspect) row.aspect = aspect;
    row.brief = [set.brief, v.brief].filter(Boolean).join("\n");
    row.review = v.review;
    if (v.take) row.take = document.media[v.take.assetId]!.path;
    row.output = output.replace(/\{([A-Za-z0-9_.-]+)\}/g, (_, k: string) => {
      if (row[k] === undefined) throw new EventError("INVALID_TEMPLATE", `Unknown placeholder {${k}}`);
      return row[k]!;
    });
    return row;
  });
}
