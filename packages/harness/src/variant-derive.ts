import type { EventDocument, SubjectReference, Variant } from "@cassie/spec";
import { EventError, frameToUs, resolveEvents, resolveFrameCount, validateDocument } from "./events";

/** Variant value, then the first axis value that names the variable in its attrs, then the default. */
export function variableValues(d: EventDocument, variantId?: string): Record<string, string> {
  const v = variantId ? d.variants?.items[variantId] : undefined;
  const out: Record<string, string> = {};
  for (const def of Object.values(d.variables ?? {})) {
    const fromAxis = v && d.variants!.axes.map(a => a.values.find(x => x.id === v.coords[a.id])?.attrs?.[def.id]).find(x => x !== undefined);
    out[def.id] = v?.values?.[def.id] ?? fromAxis ?? def.default;
  }
  return out;
}

/** Writes variable values into the layers and caption events that bind them. */
export function resolveVariables(d: EventDocument, values = variableValues(d)): EventDocument {
  if (!d.scene.layers.some(l => l.bind)) return d;
  const next = structuredClone(d);
  for (const layer of next.scene.layers) {
    if (layer.bind?.color && values[layer.bind.color]) layer.color = values[layer.bind.color]!;
    if (layer.bind?.text && values[layer.bind.text] !== undefined) {
      layer.text = values[layer.bind.text];
      const e = next.events.find(e => e.id === layer.eventId);
      if (e) e.text = layer.text;
    }
  }
  return next;
}

/** Per subject, the most specific reference whose scope matches this variant's coordinates. */
export function subjectRefsFor(d: EventDocument, v: Variant): Record<string, SubjectReference> {
  const out: Record<string, SubjectReference> = {};
  for (const r of Object.values(d.subjectRefs ?? {})) {
    const scope = Object.entries(r.scope ?? {});
    if (!scope.every(([axis, value]) => v.coords[axis] === value)) continue;
    const held = out[r.entityId];
    if (!held || scope.length > Object.keys(held.scope ?? {}).length) out[r.entityId] = r;
  }
  return out;
}

/** Subjects whose applicable reference changed after this variant's take was made. */
export function staleSubjects(d: EventDocument, v: Variant): string[] {
  if (!v.take) return [];
  return Object.values(subjectRefsFor(d, v)).filter(r => v.take!.basis?.[r.entityId] !== r.sha256).map(r => r.entityId);
}

/**
 * The document one variant renders: its take as the picture, with the master's text and card layers
 * (resolved with this variant's values) placed on the take's own canvas. Derived on every read, so a
 * master edit reaches every variant without touching it. Without a take it is the master itself.
 */
export function variantDocument(d: EventDocument, variantId: string): EventDocument {
  const v = d.variants?.items[variantId];
  if (!v) throw new EventError("MISSING_VARIANT", variantId);
  // Resolved layers become fixed text: re-compiling must not fall back to the master's defaults.
  const master = structuredClone(resolveVariables(d, variableValues(d, variantId)));
  for (const layer of master.scene.layers) delete layer.bind;
  delete master.variables;
  delete master.variants;
  delete master.subjectRefs;
  if (!v.take) return { ...master, editor: { ...master.editor, name: `${d.editor.name} · ${variantId}` } };

  const t = v.take, fps = d.frameRate.num / d.frameRate.den;
  const W = t.width, H = t.height, mw = d.editor.settings.width, mh = d.editor.settings.height;
  const frames = Math.max(1, Math.floor(t.durationUs * fps / 1e6));
  // Type scales with the shorter side, so a caption keeps its reading size on 9:16 as on 16:9.
  const s = Math.min(W, H) / Math.min(mw, mh);
  const id = `${d.editor.id}~${variantId}`;
  const out: EventDocument = {
    editor: { id, name: `${d.editor.name} · ${variantId}`, revision: d.editor.revision, settings: { fps: d.editor.settings.fps, width: W, height: H, durationUs: frameToUs(d, frames) },
      assets: { [t.assetId]: structuredClone(d.editor.assets[t.assetId]!) },
      tracks: [{ id: "video", kind: "video", name: "变体成片", locked: false, clips: [{ id: "variant-clip", assetId: t.assetId, startUs: 0, endUs: frameToUs(d, frames), sourceInUs: 0, attrs: { eventId: "variant-base" } }] }] },
    semantic: { id: `${d.semantic.id}~${variantId}`, editorProjectId: id, entities: {
      "variant-take": { id: "variant-take", name: `变体 ${variantId}`, kind: "scene", lifecycle: { enterUs: 0, exitUs: frameToUs(d, frames) }, attributes: {}, binds: [{ targetType: "clip", targetId: "variant-clip", role: "primary" }], locked: false },
    }, relations: [], constraints: [] },
    frameRate: { ...d.frameRate }, actions: {}, media: { [t.assetId]: structuredClone(d.media[t.assetId]!) },
    events: [{ id: "variant-base", entityId: "variant-take", kind: "reveal", label: "变体成片", start: { frame: 0 }, durationFrames: frames, clipId: "variant-clip" }],
    scene: { background: "#000000", layers: [{ id: "variant-base", entityId: "variant-take", kind: "video", eventId: "variant-base", assetId: t.assetId, x: 0, y: 0, width: W, height: H, color: "#ffffff" }] },
  };
  out.editor.tracks.push({ id: "audio", kind: "audio", name: "变体声音", locked: false, clips: [{ id: "variant-audio", assetId: `${t.assetId}-audio`, startUs: 0, endUs: frameToUs(d, frames), sourceInUs: 0, attrs: { eventId: "variant-sound" } }] });
  out.editor.assets[`${t.assetId}-audio`] = { id: `${t.assetId}-audio`, kind: "audio", name: "变体声音", durationUs: t.durationUs };
  out.media[`${t.assetId}-audio`] = structuredClone(d.media[t.assetId]!);
  out.semantic.entities["variant-audio"] = { id: "variant-audio", name: "变体声音", kind: "audio", lifecycle: { enterUs: 0, exitUs: frameToUs(d, frames) }, attributes: {}, binds: [{ targetType: "clip", targetId: "variant-audio", role: "primary" }], locked: false };
  out.events.push({ id: "variant-sound", entityId: "variant-audio", kind: "sound", label: "变体声音", start: { frame: 0 }, durationFrames: frames, clipId: "variant-audio" });

  const resolved = resolveEvents(master), masterFrames = resolveFrameCount(master, resolved);
  for (const layer of master.scene.layers) {
    if (layer.kind !== "text" && layer.kind !== "card") continue;
    const found = resolved.find(x => x.id === layer.eventId), authored = master.events.find(x => x.id === layer.eventId);
    if (!found || !authored || !found.active) continue;
    const shift = master.semantic.entities[layer.entityId]?.attributes.anchor === "end" ? frames - masterFrames : 0;
    const e = { ...found, startFrame: Math.max(0, found.startFrame + shift), endFrame: found.endFrame + shift };
    if (e.startFrame >= frames || e.endFrame <= e.startFrame) continue;
    const w = Math.min(layer.width * s, W * 0.9), h = layer.height * s;
    const cx = (layer.x + layer.width / 2) / mw * W, cy = (layer.y + layer.height / 2) / mh * H;
    const entity = master.semantic.entities[layer.entityId]!;
    out.semantic.entities[layer.entityId] = { ...structuredClone(entity), binds: [] };
    out.events.push({ id: e.id, entityId: layer.entityId, kind: authored.kind === "action" ? "reveal" : authored.kind, label: authored.label, start: { frame: e.startFrame }, durationFrames: Math.min(e.endFrame, frames) - e.startFrame, ...(e.text !== undefined ? { text: e.text } : {}) });
    out.scene.layers.push({ ...structuredClone(layer), x: Math.round(Math.max(0, Math.min(W - w, cx - w / 2))), y: Math.round(Math.max(0, Math.min(H - h, cy - h / 2))), width: Math.round(w), height: Math.round(h) });
  }
  // Master-tracked subjects re-located in this take (locate_variant). Regions whose take no longer
  // matches are stale and stay out of the derived canvas until the variant is located again.
  for (const [rid, region] of Object.entries(v.regions ?? {})) {
    if (region.sourceAssetId !== t.assetId || region.sourceSha256 !== t.sha256) continue;
    const present = region.boxes.flatMap((b, i) => b.length ? [i] : []);
    if (!present.length) continue;
    const owner = master.semantic.entities[region.entityId];
    if (owner && owner.kind !== "subject") continue;
    const entity = owner
      ? { ...structuredClone(owner), binds: [], attributes: { ...structuredClone(owner.attributes), regions: [rid] } }
      : { id: region.entityId, name: region.entityId, kind: "subject" as const, lifecycle: { enterUs: 0, exitUs: frameToUs(d, frames) }, attributes: { regions: [rid] }, binds: [], locked: false };
    out.semantic.entities[region.entityId] = entity;
    out.events.push({ id: region.eventId, entityId: region.entityId, kind: "reveal", label: `${entity.name} · 变体`, start: { frame: present[0]! }, durationFrames: present.at(-1)! - present[0]! + 1 });
    out.regions = { ...(out.regions ?? {}), [rid]: structuredClone(region) };
  }
  validateDocument(out);
  return out;
}
