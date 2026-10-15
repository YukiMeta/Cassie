import { dryRun, findClip, type EditorCommand } from "@cassie/editor-core";
import type { DocumentEdit, DocumentEditPlan, EventDocument, EventWorkspace } from "@cassie/spec";
import { canonical, EventError, frameToUs, recordTransaction, resolveEvents, resolveFrameCount, validateWorkspace } from "./events";

/** Gesture writeback preserves event references. Only the local offset/duration is edited. */
export function planDocumentEdit(document: EventDocument, edit: DocumentEdit): DocumentEditPlan {
  const before = resolveEvents(document);
  const next = structuredClone(document);
  const writes = new Set<string>();
  const commands: EditorCommand[] = [];
  if (edit.kind === "attach-subject-matte") {
    const event=next.events.find(e=>e.id===edit.eventId);
    if(!event || !event.clipId || findClip(next.editor,event.clipId)?.clip.assetId!==edit.matte.sourceAssetId || edit.matte.eventId!==event.id || edit.matte.entityId!==event.entityId || edit.asset.id!==edit.matte.maskAssetId || next.editor.assets[edit.asset.id]) throw new EventError("INVALID_MATTE","Matte must identify its event and a new asset");
    next.editor.assets[edit.asset.id]=structuredClone(edit.asset);
    next.media[edit.asset.id]=structuredClone(edit.media);
    next.subjectMattes={...next.subjectMattes,[event.id]:structuredClone(edit.matte)};
    next.semantic.entities[event.entityId]!.attributes[`matte:${event.id}`]={maskAssetId:edit.matte.maskAssetId,quality:edit.matte.quality,backend:edit.matte.backend};
    writes.add(event.entityId);
  } else if (edit.kind === "track-region") {
    const r = edit.region, layer = next.scene.layers.find(l => l.id === r?.layerId);
    const shot = layer?.eventId ? next.events.find(e => e.id === layer.eventId) : undefined;
    const clip = shot?.clipId ? findClip(next.editor, shot.clipId)?.clip : undefined;
    if (!r || typeof r.id !== "string" || !/^[a-z0-9-]+$/.test(r.id) || !layer || layer.kind !== "video" || !shot || !clip || clip.assetId !== r.sourceAssetId) throw new EventError("INVALID_REGION", "A region must belong to a video layer bound to its source clip");
    if (r.entityId === layer.entityId) throw new EventError("INVALID_REGION", "A region is a part of its shot, not the shot itself");
    const present = r.boxes.flatMap((b, i) => b.length ? [i] : []);
    if (!present.length) throw new EventError("INVALID_REGION", "Tracking found no frames");
    const existing = next.regions?.[r.id];
    if (existing && (existing.entityId !== r.entityId || existing.eventId !== r.eventId || existing.layerId !== r.layerId)) throw new EventError("INVALID_REGION", "Re-tracking must keep the region identity");
    const clipStart = Math.round(clip.sourceInUs * next.frameRate.num / (1e6 * next.frameRate.den));
    const offset = r.sourceStartFrame + present[0]! - clipStart, frames = present.at(-1)! - present[0]! + 1;
    // One entity may own regions in many shots: the same product seen across the film.
    const entity = next.semantic.entities[r.entityId];
    if (entity && (entity.kind !== "subject" || !entity.attributes.regions)) throw new EventError("INVALID_REGION", "Region entity must be a tracked subject");
    if (!entity) next.semantic.entities[r.entityId] = { id: r.entityId, name: edit.name || r.entityId, kind: "subject", lifecycle: { enterUs: 0, exitUs: 0 }, attributes: { regions: [] }, binds: [], locked: false };
    const owner = next.semantic.entities[r.entityId]!;
    if (edit.name) owner.name = edit.name;
    const owned = owner.attributes.regions as string[];
    if (!owned.includes(r.id)) owned.push(r.id);
    if (!existing) {
      if (next.events.some(e => e.id === r.eventId)) throw new EventError("INVALID_REGION", "Region event id already used");
      next.events.push({ id: r.eventId, entityId: r.entityId, kind: "reveal", label: `${owner.name} · ${next.semantic.entities[layer.entityId]!.name}`, start: { eventId: shot.id, edge: "start", offsetFrames: offset }, durationFrames: frames });
    } else {
      const e = next.events.find(e => e.id === r.eventId)!;
      e.start = { eventId: shot.id, edge: "start", offsetFrames: offset }; e.durationFrames = frames;
    }
    next.regions = { ...next.regions, [r.id]: structuredClone(r) };
    writes.add(r.entityId);
  } else if (edit.kind === "set-region-replacement") {
    const r = next.regions?.[edit.regionId];
    if (!r) throw new EventError("MISSING_REGION", edit.regionId);
    if (edit.replacement === null) delete r.replacement;
    else {
      const rep = edit.replacement;
      if (!rep || !edit.asset || !edit.media || edit.asset.id !== rep.assetId || edit.media.sha256 !== rep.sha256 || edit.asset.kind !== "video" || !(rep.pad >= 0 && rep.pad <= 400) || !rep.provider?.trim() || !rep.review?.trim()) throw new EventError("INVALID_REPLACEMENT", "Replacement needs its new video asset, a provider and an explicit review note");
      if (next.editor.assets[rep.assetId] && next.media[rep.assetId]?.sha256 !== rep.sha256) throw new EventError("INVALID_REPLACEMENT", "Asset id already used by different media");
      next.editor.assets[rep.assetId] = structuredClone(edit.asset);
      next.media[rep.assetId] = structuredClone(edit.media);
      r.replacement = structuredClone(rep);
    }
    writes.add(r.entityId);
  } else if (edit.kind === "set-region-look") {
    const r = next.regions?.[edit.regionId];
    if (!r) throw new EventError("MISSING_REGION", edit.regionId);
    const allowed = new Set(["color", "tint", "feather"]);
    if (!edit.patch || !Object.keys(edit.patch).length || Object.keys(edit.patch).some(k => !allowed.has(k))) throw new EventError("INVALID_PATCH", "Only color/tint/feather are editable on a region");
    Object.assign(r.look, edit.patch);
    writes.add(r.entityId);
  } else if (edit.kind === "set-event-timing") {
    if (!Number.isSafeInteger(edit.startFrame) || edit.startFrame < 0 || !Number.isSafeInteger(edit.durationFrames) || edit.durationFrames < 1) throw new EventError("INVALID_TIMING", "Timing must use non-negative start and positive duration in whole frames");
    const e = next.events.find(e => e.id === edit.eventId), old = before.find(e => e.id === edit.eventId);
    if (!e || !old) throw new EventError("MISSING_EVENT", edit.eventId);
    if (!old.active) throw new EventError("INACTIVE_EVENT", "Change the condition's action state before editing an inactive event");
    const delta = edit.startFrame - old.startFrame;
    if ("frame" in e.start) e.start.frame += delta; else e.start.offsetFrames += delta;
    if (edit.durationFrames !== old.endFrame - old.startFrame) {
      if (e.action) e.durationOverrideFrames = edit.durationFrames; else e.durationFrames = edit.durationFrames;
    }
    // A left-edge media trim advances the source in-point; a move keeps it fixed.
    if (e.clipId && edit.durationFrames !== old.endFrame - old.startFrame && edit.startFrame + edit.durationFrames === old.endFrame) {
      const clip = findClip(next.editor, e.clipId)!.clip;
      if (clip.assetId && next.editor.assets[clip.assetId]!.kind !== "image") commands.push({ kind: "setClipRange", clipId: clip.id, sourceInUs: clip.sourceInUs + frameToUs(next, delta) });
    }
    writes.add(e.entityId);
  } else if (edit.kind === "set-layer") {
    const layer = next.scene.layers.find(l => l.id === edit.layerId);
    if (!layer) throw new EventError("MISSING_LAYER", edit.layerId);
    const allowed = new Set(["x", "y", "width", "height", "rotation", "color", "text", "tint"]);
    if (!edit.patch || !Object.keys(edit.patch).length || Object.keys(edit.patch).some(k => !allowed.has(k))) throw new EventError("INVALID_PATCH", "Only exposed geometry/style/text fields are editable");
    if (edit.patch.tint !== undefined && (layer.kind !== "video" || !(edit.patch.tint >= 0 && edit.patch.tint <= 1))) throw new EventError("INVALID_TINT", "Tint is a 0..1 grade on video layers");
    if (edit.patch.text !== undefined && typeof edit.patch.text !== "string") throw new EventError("INVALID_TEXT", layer.id);
    Object.assign(layer, edit.patch);
    if (edit.patch.text !== undefined && layer.eventId) {
      const e = next.events.find(e => e.id === layer.eventId)!;
      e.text = edit.patch.text;
    }
    writes.add(layer.entityId);
    next.semantic.entities[layer.entityId]!.attributes[`layer:${layer.id}`] = { x: layer.x, y: layer.y, width: layer.width, height: layer.height, rotation: layer.rotation ?? 0 };
  } else if (edit.kind === "set-variant-set") {
    const s = edit.set;
    if (!s || typeof s !== "object") throw new EventError("INVALID_VARIANTS", "Missing variant set");
    next.variants = { masterAssetId: s.masterAssetId, keep: structuredClone(s.keep), brief: s.brief, axes: structuredClone(s.axes), items: next.variants?.items ?? {} };
  } else if (edit.kind === "add-variants") {
    if (!next.variants) throw new EventError("NO_VARIANTS", "Define the variant set before adding variants");
    if (!Array.isArray(edit.items) || !edit.items.length) throw new EventError("INVALID_VARIANT", "No variants to add");
    for (const item of edit.items) {
      if (next.variants.items[item.id]) throw new EventError("DUPLICATE_VARIANT", item.id);
      if (item.take) throw new EventError("INVALID_VARIANT", "Attach takes with attach-variant-take so their media is recorded");
      next.variants.items[item.id] = { id: item.id, coords: structuredClone(item.coords), review: "pending", ...(item.brief ? { brief: item.brief } : {}) };
    }
  } else if (edit.kind === "remove-variants") {
    if (!next.variants || !Array.isArray(edit.ids) || !edit.ids.length || edit.ids.some(id => !next.variants!.items[id])) throw new EventError("MISSING_VARIANT", "Unknown variant");
    for (const id of edit.ids) delete next.variants.items[id];
  } else if (edit.kind === "attach-variant-take") {
    const v = next.variants?.items[edit.variantId], t = edit.take;
    if (!v) throw new EventError("MISSING_VARIANT", edit.variantId);
    if (!t || !edit.asset || !edit.media || edit.asset.id !== t.assetId || edit.asset.kind !== "video" || edit.media.sha256 !== t.sha256 || !t.provider?.trim()) throw new EventError("INVALID_TAKE", "A take needs its video asset, media and provider");
    if (next.editor.assets[t.assetId] && next.media[t.assetId]?.sha256 !== t.sha256) throw new EventError("INVALID_TAKE", "Asset id already used by different media");
    next.editor.assets[t.assetId] = structuredClone(edit.asset);
    next.media[t.assetId] = structuredClone(edit.media);
    v.take = structuredClone(t);
    v.review = "pending";
    delete v.note;
  } else if (edit.kind === "review-variant") {
    const v = next.variants?.items[edit.variantId];
    if (!v) throw new EventError("MISSING_VARIANT", edit.variantId);
    if (!["pending", "approved", "rejected"].includes(edit.review)) throw new EventError("INVALID_REVIEW", String(edit.review));
    if (edit.review === "rejected" && !edit.note?.trim()) throw new EventError("INVALID_REVIEW", "Say what is wrong so the next take can fix it");
    v.review = edit.review;
    if (edit.note?.trim()) v.note = edit.note.trim(); else delete v.note;
    if (edit.brief !== undefined) { if (edit.brief.trim()) v.brief = edit.brief.trim(); else delete v.brief; }
  } else throw new EventError("INVALID_EDIT", "Unsupported document edit");
  const after = resolveEvents(next);
  const changes = before.flatMap((b, i) => canonical(b) === canonical(after[i]) ? [] : [{ eventId: b.id, before: b, after: after[i]!, cause: edit.kind }]);
  for (const c of changes) {
    writes.add(c.after.entityId);
    const e = next.events.find(e => e.id === c.eventId)!;
    if (e.clipId) {
      commands.push({ kind: "setClipRange", clipId: e.clipId, startUs: frameToUs(next, c.after.startFrame), endUs: frameToUs(next, c.after.endFrame) });
      if (c.after.text !== undefined) commands.push({ kind: "setClipAttrs", clipId: e.clipId, attrs: { text: c.after.text } });
    }
    next.semantic.entities[e.entityId]!.attributes[`event:${e.id}`] = { active: c.after.active, startFrame: c.after.startFrame, endFrame: c.after.endFrame, ...(c.after.state ? { state: c.after.state } : {}) };
  }
  for (const id of writes) {
    const entity = next.semantic.entities[id]!;
    if (entity.locked || next.semantic.constraints.some(c => c.kind === "lock" && [entity.id, entity.name, entity.reference].includes(c.what))) throw new EventError("ENTITY_LOCKED", entity.name);
    for (const bind of entity.binds.filter(b => b.targetType === "clip")) {
      const entry = findClip(next.editor, bind.targetId);
      if (entry?.track.locked || next.semantic.constraints.some(c => c.kind === "lock" && c.what === bind.targetId)) throw new EventError("TRACK_LOCKED", bind.targetId);
    }
    const active = after.filter(e => e.active && e.entityId === id);
    if (active.length) entity.lifecycle = { enterUs: frameToUs(next, Math.min(...active.map(e => e.startFrame))), exitUs: frameToUs(next, Math.max(...active.map(e => e.endFrame))) };
  }
  next.editor = dryRun(next.editor, [{ kind: "composite", commands }]);
  for (const constraint of next.semantic.constraints.filter(c => c.kind === "anchor" && c.anchorUs !== undefined)) {
    const changed = changes.find(c => next.events.find(e => e.id === c.eventId)?.clipId === constraint.what);
    if (changed && (!changed.after.active || frameToUs(next, changed.after.startFrame) > constraint.anchorUs! || frameToUs(next, changed.after.endFrame) <= constraint.anchorUs!)) throw new EventError("ANCHOR_VIOLATION", constraint.id);
  }
  next.editor.settings.durationUs = frameToUs(next, resolveFrameCount(next, after));
  if (canonical(next) === canonical(document)) throw new EventError("NO_CHANGE", "No editable value changed");
  resolveEvents(next);
  return { id: crypto.randomUUID(), status: "ready", baseRevision: document.editor.revision, base: structuredClone(document), edit: structuredClone(edit), changes, next };
}

function editDetail(edit: DocumentEdit): string {
  switch (edit.kind) {
    case "set-layer": return edit.layerId;
    case "track-region": return edit.region.id;
    case "set-region-look": case "set-region-replacement": return edit.regionId;
    case "set-variant-set": return edit.set.masterAssetId;
    case "add-variants": return edit.items.map(v => v.id).join(",");
    case "remove-variants": return edit.ids.join(",");
    case "attach-variant-take": return `${edit.variantId}:${edit.take.sha256}`;
    case "review-variant": return `${edit.variantId}:${edit.review}`;
    default: return edit.eventId;
  }
}

export function applyDocumentEdit(workspace: EventWorkspace, plan: DocumentEditPlan): EventWorkspace {
  validateWorkspace(workspace);
  if (canonical(workspace.document) !== canonical(plan.base) || workspace.document.editor.revision !== plan.baseRevision) throw new EventError("STALE_PLAN", "Project changed after planning; retry the gesture");
  const fresh = planDocumentEdit(workspace.document, plan.edit);
  if (canonical(fresh.next) !== canonical(plan.next) || canonical(fresh.changes) !== canonical(plan.changes)) throw new EventError("PLAN_MISMATCH", "Document edit differs from compiled plan");
  const result = structuredClone(workspace);
  result.document = fresh.next;
  result.document.editor.revision += 1;
  const revision = result.document.editor.revision;
  return recordTransaction(result, workspace.document, { id: plan.id, edit: plan.edit, baseRevision: plan.baseRevision, changes: plan.changes, receipts: [] }, [
    { type: plan.edit.kind, revision, detail: editDetail(plan.edit) },
    ...plan.changes.map(c => ({ type: "event.recomputed", revision, detail: c.eventId })),
    { type: "transaction.committed", revision, detail: plan.id },
  ]);
}
