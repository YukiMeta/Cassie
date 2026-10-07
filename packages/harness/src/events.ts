import { assertProjectValid, dryRun, findClip, type EditorCommand } from "@cassie/editor-core";
import type { ActionEdit, ActionPlan, EventDocument, EventWorkspace, GenerationReceipt, GenerationTask, ResolvedEvent } from "@cassie/spec";

export class EventError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "EventError"; }
}
function requireThat(test: unknown, code: string, message: string): asserts test {
  if (!test) throw new EventError(code, message);
}
function integer(n: number, minimum = 0) { return Number.isSafeInteger(n) && n >= minimum; }
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
export function frameToUs(document: EventDocument, frame: number): number {
  return Math.round(frame * 1e6 * document.frameRate.den / document.frameRate.num);
}
export function resolveFrameCount(d: EventDocument, events = resolveEvents(d)): number {
  const owned = new Set(d.events.map(e => e.clipId).filter(Boolean));
  const unbound = d.editor.tracks.flatMap(t => t.clips).filter(c => !owned.has(c.id));
  return Math.max(1, ...events.filter(e => e.active).map(e => e.endFrame), ...unbound.map(c => Math.ceil(c.endUs * d.frameRate.num / (1e6 * d.frameRate.den))));
}

/** Validate authored facts before evaluating their graph. JSON is untrusted at every public boundary. */
export function validateDocument(d: EventDocument): void {
  requireThat(d && d.editor && d.semantic && d.frameRate && d.actions && Array.isArray(d.events) && d.scene && Array.isArray(d.scene.layers) && d.media, "INVALID_DOCUMENT", "Incomplete event document");
  assertProjectValid(d.editor);
  requireThat(integer(d.editor.revision), "INVALID_REVISION", "Revision must be a non-negative integer");
  requireThat(integer(d.frameRate.num, 1) && integer(d.frameRate.den, 1), "INVALID_FPS", "Frame rate must be a positive rational");
  requireThat(d.semantic.editorProjectId === d.editor.id, "PROJECT_MISMATCH", "Semantic and editor project identities differ");
  requireThat(Math.abs(d.editor.settings.fps - d.frameRate.num / d.frameRate.den) < 1e-9, "FPS_MISMATCH", "Editor and event clocks differ");
  requireThat(integer(d.editor.settings.width, 1) && integer(d.editor.settings.height, 1), "INVALID_CANVAS", "Canvas dimensions must be positive integers");
  const ids = new Set<string>();
  const clipIds = new Set<string>();
  for (const [id, def] of Object.entries(d.actions)) {
    requireThat(def && ["keyframes", "video-edit"].includes(def.execution) && def.states && Object.keys(def.states).length, "INVALID_ACTION", `Invalid action definition: ${id}`);
    for (const state of Object.values(def.states)) {
      requireThat(state && typeof state.label === "string" && integer(state.durationFrames, 1), "INVALID_DURATION", `Invalid action duration: ${id}`);
      for (const [channel, keys] of Object.entries(state.motion ?? {})) {
        requireThat(["x", "y", "rotation", "armAngle", "forearmAngle", "scale", "opacity"].includes(channel), "UNSUPPORTED_CHANNEL", channel);
        requireThat(Array.isArray(keys) && keys.length >= 2 && keys[0]?.at === 0 && keys.at(-1)?.at === 1, "INVALID_KEYFRAMES", `Keyframes must span 0..1: ${id}/${channel}`);
        let last = -1;
        for (const key of keys) {
          requireThat(Number.isFinite(key.at) && key.at >= 0 && key.at <= 1 && key.at > last && Number.isFinite(key.value), "INVALID_KEYFRAMES", `Unordered/non-finite keyframe: ${id}/${channel}`);
          last = key.at;
        }
      }
    }
  }
  for (const event of d.events) {
    requireThat(event && typeof event.id === "string" && event.id.length && !ids.has(event.id), "DUPLICATE_EVENT", `Invalid or duplicate event: ${event?.id}`);
    ids.add(event.id);
    requireThat(d.semantic.entities[event.entityId], "MISSING_ENTITY", `Unknown entity: ${event.entityId}`);
    requireThat(["action", "reveal", "caption", "camera", "sound", "marker"].includes(event.kind), "INVALID_KIND", event.id);
    requireThat(typeof event.label === "string" && (event.text === undefined || typeof event.text === "string"), "INVALID_TEXT", event.id);
    requireThat(integer(event.durationFrames, 1), "INVALID_DURATION", event.id);
    requireThat(event.durationOverrideFrames === undefined || integer(event.durationOverrideFrames, 1), "INVALID_DURATION", event.id);
    requireThat(event.start && typeof event.start === "object", "INVALID_START", event.id);
    if ("frame" in event.start) {
      requireThat(integer(event.start.frame), "INVALID_START", event.id);
    } else {
      requireThat(typeof event.start.eventId === "string" && ["start", "end"].includes(event.start.edge) && Number.isSafeInteger(event.start.offsetFrames), "INVALID_START", event.id);
    }
    requireThat((event.kind === "action") === Boolean(event.action), "INVALID_ACTION", `Action state required only on action events: ${event.id}`);
    if (event.action) requireThat(d.actions[event.action.definitionId]?.states[event.action.state], "UNKNOWN_STATE", `Unknown action/state: ${event.id}`);
    if (event.when) requireThat(typeof event.when.eventId === "string" && typeof event.when.state === "string", "INVALID_CONDITION", event.id);
    if (event.clipId) {
      requireThat(!clipIds.has(event.clipId) && findClip(d.editor, event.clipId), "INVALID_BINDING", `Clip must exist and have one event owner: ${event.clipId}`);
      clipIds.add(event.clipId);
      requireThat(d.semantic.entities[event.entityId]!.binds.some(b => b.targetType === "clip" && b.targetId === event.clipId), "INVALID_BINDING", `Event clip is not bound to its entity: ${event.id}`);
    }
  }
  const layerIds = new Set<string>();
  for (const layer of d.scene.layers) {
    requireThat(typeof layer.id === "string" && !layerIds.has(layer.id), "DUPLICATE_LAYER", layer.id);
    layerIds.add(layer.id);
    requireThat(d.semantic.entities[layer.entityId] && ["person", "card", "text", "video"].includes(layer.kind), "INVALID_LAYER", layer.id);
    requireThat(!layer.eventId || ids.has(layer.eventId), "MISSING_EVENT", layer.id);
    requireThat([layer.x, layer.y, layer.width, layer.height].every(Number.isFinite) && layer.width > 0 && layer.height > 0, "INVALID_GEOMETRY", layer.id);
    requireThat(layer.rotation === undefined || Number.isFinite(layer.rotation), "INVALID_GEOMETRY", layer.id);
    requireThat(/^#[0-9a-f]{6}$/i.test(layer.color), "INVALID_COLOR", layer.id);
    requireThat(layer.tint === undefined || (layer.kind === "video" && layer.tint >= 0 && layer.tint <= 1), "INVALID_TINT", layer.id);
    if (layer.crop) {
      const asset = d.editor.assets[layer.assetId ?? ""], c = layer.crop;
      requireThat(layer.kind === "video" && asset?.width && asset.height && [c.x, c.y, c.width, c.height].every(Number.isFinite) && c.x >= 0 && c.y >= 0 && c.width > 0 && c.height > 0 && c.x + c.width <= asset.width && c.y + c.height <= asset.height, "INVALID_CROP", layer.id);
    }
    if (layer.kind === "video") requireThat(layer.assetId && d.media[layer.assetId] && d.editor.assets[layer.assetId]?.kind === "video", "MISSING_MEDIA", layer.id);
  }
  for (const [eventId, matte] of Object.entries(d.subjectMattes ?? {})) {
    const event=d.events.find(e=>e.id===eventId), asset=d.editor.assets[matte.maskAssetId];
    requireThat(event && matte.eventId===eventId && matte.entityId===event.entityId && d.media[matte.sourceAssetId]?.sha256===matte.sourceSha256, "INVALID_MATTE", "Matte identity/source provenance differs from its event");
    requireThat(asset?.kind==="video" && d.media[matte.maskAssetId] && integer(matte.sourceStartFrame) && integer(matte.frames,1) && matte.width===d.editor.settings.width && matte.height===d.editor.settings.height && canonical(matte.frameRate)===canonical(d.frameRate), "INVALID_MATTE", "Matte needs matching canvas and frame domain");
    requireThat(asset.durationUs===frameToUs(d,matte.frames) && asset.width===matte.width && asset.height===matte.height && typeof matte.backend==="string" && ["draft","reviewed"].includes(matte.quality), "INVALID_MATTE", "Matte metadata differs from its asset");
  }
  for (const [id, r] of Object.entries(d.regions ?? {})) {
    const layer = d.scene.layers.find(l => l.id === r.layerId), event = d.events.find(e => e.id === r.eventId);
    requireThat(r.id === id && event && event.entityId === r.entityId && layer?.kind === "video" && layer.assetId === r.sourceAssetId && d.media[r.sourceAssetId]?.sha256 === r.sourceSha256, "INVALID_REGION", `Region identity/source differs from its layer: ${id}`);
    requireThat(integer(r.sourceStartFrame) && Array.isArray(r.boxes) && r.boxes.length > 0 && Array.isArray(r.confidence) && r.confidence.length === r.boxes.length && r.boxes.every(b => Array.isArray(b) && (b.length === 0 || (b.length === 4 && b.every(Number.isFinite) && b[2]! > 0 && b[3]! > 0))), "INVALID_REGION", `Region boxes must be one finite box per source frame: ${id}`);
    requireThat(Array.isArray(r.keys) && r.keys.length > 0 && r.keys.every(k => integer(k.sourceFrame) && k.sourceFrame >= r.sourceStartFrame && k.sourceFrame < r.sourceStartFrame + r.boxes.length && k.box.length === 4 && k.box.every(Number.isFinite)), "INVALID_REGION", `Region keys must lie inside its tracked window: ${id}`);
    requireThat(!r.replacement || (d.editor.assets[r.replacement.assetId]?.kind === "video" && d.media[r.replacement.assetId]?.sha256 === r.replacement.sha256 && r.replacement.pad >= 0 && r.replacement.pad <= 400), "INVALID_REGION", `Region replacement media: ${id}`);
    requireThat(r.look && /^#[0-9a-f]{6}$/i.test(r.look.color) && r.look.tint >= 0 && r.look.tint <= 1 && r.look.feather >= 0 && r.look.feather <= 200, "INVALID_REGION", `Region look: ${id}`);
  }
  requireThat(/^#[0-9a-f]{6}$/i.test(d.scene.background), "INVALID_COLOR", "Scene background");
  for (const [id, ref] of Object.entries(d.media)) {
    requireThat(d.editor.assets[id] && ref && typeof ref.path === "string" && ref.path.length && !ref.path.startsWith("/") && !ref.path.includes("\\") && !ref.path.split("/").includes("..") && !/^[a-z]+:/i.test(ref.path) && /^[a-f0-9]{64}$/.test(ref.sha256), "INVALID_MEDIA", `Invalid portable media reference: ${id}`);
  }
}

export function resolveEvents(d: EventDocument): ResolvedEvent[] {
  validateDocument(d);
  const nodes = new Map(d.events.map(e => [e.id, e]));
  const done = new Map<string, ResolvedEvent>();
  const visiting = new Set<string>();
  function visit(id: string): ResolvedEvent {
    if (done.has(id)) return done.get(id)!;
    requireThat(!visiting.has(id), "EVENT_CYCLE", `Event dependency cycle at ${id}`);
    const e = nodes.get(id);
    requireThat(e, "MISSING_EVENT", `Unknown event dependency: ${id}`);
    visiting.add(id);
    let startFrame: number;
    let active = true;
    let disabledReason: string | undefined;
    if ("frame" in e.start) startFrame = e.start.frame;
    else {
      const parent = visit(e.start.eventId);
      startFrame = (e.start.edge === "start" ? parent.startFrame : parent.endFrame) + e.start.offsetFrames;
      if (!parent.active) { active = false; disabledReason = `Dependency ${parent.id} is disabled`; }
    }
    if (e.when) {
      const condition = visit(e.when.eventId);
      const source = nodes.get(e.when.eventId)!;
      requireThat(source.action && d.actions[source.action.definitionId]?.states[e.when.state], "INVALID_CONDITION", `Condition must name an existing action state: ${e.id}`);
      if (!condition.active || condition.state !== e.when.state) { active = false; disabledReason = `${e.when.eventId} != ${e.when.state}`; }
    }
    const state = e.action ? d.actions[e.action.definitionId]!.states[e.action.state]! : undefined;
    const endFrame = startFrame + (e.durationOverrideFrames ?? state?.durationFrames ?? e.durationFrames);
    requireThat(integer(startFrame) && integer(endFrame, 1), "INVALID_RANGE", `Invalid projected range: ${id} (${startFrame}..${endFrame})`);
    const result: ResolvedEvent = { id, entityId: e.entityId, kind: e.kind, startFrame, endFrame, active,
      ...(e.action ? { state: e.action.state } : {}), ...(e.text !== undefined ? { text: e.text } : {}), ...(disabledReason ? { disabledReason } : {}) };
    done.set(id, result); visiting.delete(id); return result;
  }
  return d.events.map(e => visit(e.id));
}

function changeActionState(next: EventDocument, edit: ActionEdit) {
  requireThat(edit && edit.kind === "set-action-state" && typeof edit.state === "string" && edit.state.length>0,"INVALID_EDIT","Expected set-action-state edit");
  const event=next.events.find(e=>e.id===edit.eventId);
  requireThat(event?.action,"NOT_ACTION",`Not an action event: ${edit.eventId}`);
  requireThat(event.action.state!==edit.state,"NO_CHANGE","Choose a new action state");
  const definition=next.actions[event.action.definitionId]!;
  if(edit.instruction!==undefined || edit.durationFrames!==undefined) {
    requireThat(definition.execution==="video-edit","INVALID_EDIT","Custom instructions are for video-edit actions");
    const prior=definition.states[edit.state];
    const label=edit.instruction??prior?.label, durationFrames=edit.durationFrames??prior?.durationFrames??definition.states[event.action.state]!.durationFrames;
    requireThat(typeof label==="string"&&label.trim().length>0&&label.length<=6000&&integer(durationFrames,1),"INVALID_EDIT","Action instruction and positive frame duration are required");
    definition.states[edit.state]={label:label.trim(),durationFrames};
    if(edit.durationFrames!==undefined)delete event.durationOverrideFrames;
  }
  requireThat(definition.states[edit.state],"UNKNOWN_STATE",edit.state);
  event.action.state=edit.state;
  return event;
}

export function planAction(d: EventDocument, edit: ActionEdit): ActionPlan {
  const before = resolveEvents(d);
  const next = structuredClone(d);
  const event = changeActionState(next, edit);
  const after = resolveEvents(next);
  const changes = before.flatMap((old, i) => canonical(old) === canonical(after[i]) ? [] : [{ eventId: old.id, before: old, after: after[i]!, cause: old.id === edit.eventId ? "action-state" : `dependency:${edit.eventId}` }]);
  const writes = new Set(changes.map(c => c.after.entityId));
  for (const id of writes) {
    const entity = d.semantic.entities[id]!;
    requireThat(!entity.locked, "ENTITY_LOCKED", `Locked entity would change: ${entity.name}`);
    for (const c of d.semantic.constraints) {
      if (c.kind === "lock" && [entity.id, entity.name, entity.reference].includes(c.what)) throw new EventError("ENTITY_LOCKED", `Constraint ${c.id} blocks ${entity.name}`);
    }
  }
  for (const change of changes) {
    const bound = d.events.find(e => e.id === change.eventId)!;
    if (bound.clipId) {
      requireThat(!findClip(d.editor, bound.clipId)!.track.locked, "TRACK_LOCKED", bound.clipId);
      for (const c of d.semantic.constraints) {
        if (c.what === bound.clipId && c.kind === "lock") throw new EventError("CLIP_LOCKED", bound.clipId);
        if (c.what === bound.clipId && c.kind === "anchor" && c.anchorUs !== undefined)
          requireThat(change.after.active && frameToUs(d, change.after.startFrame) <= c.anchorUs && c.anchorUs < frameToUs(d, change.after.endFrame), "ANCHOR_VIOLATION", c.id);
      }
    }
  }
  const tasks: GenerationTask[] = [];
  const definition = next.actions[event.action!.definitionId]!;
  if (definition.execution === "video-edit") {
    const clip = event.clipId ? findClip(d.editor, event.clipId)?.clip : undefined;
    requireThat(clip?.assetId && d.media[clip.assetId], "MISSING_MEDIA", "Video action needs an event-owned clip and a hashed local source");
    requireThat(d.scene.layers.some(l => l.kind === "video" && l.eventId === event.id && l.assetId === clip.assetId), "MISSING_VISUAL_BINDING", "Video edit must be bound to the visible shot layer");
    const timing = after.find(e => e.id === event.id)!;
    requireThat(timing.active, "INACTIVE_ACTION", "Cannot generate an inactive action");
    const matte=d.subjectMattes?.[event.id];
    let selection: GenerationTask["selection"];
    if(matte && matte.sourceAssetId===clip.assetId) {
      const sourceStart=Math.round(clip.sourceInUs*d.frameRate.num/(1e6*d.frameRate.den));
      const sourceFrames=before.find(e=>e.id===event.id)!.endFrame-before.find(e=>e.id===event.id)!.startFrame;
      requireThat(sourceStart>=matte.sourceStartFrame && sourceStart+sourceFrames<=matte.sourceStartFrame+matte.frames,"MATTE_RANGE","Re-extract the matte for this trimmed/extended source window");
      selection={matte:structuredClone(matte),mask:structuredClone(d.media[matte.maskAssetId]!)};
    }
    tasks.push({ id: `video:${event.id}`, capability: "video-edit", eventId: event.id, entityId: event.entityId,
      sourceAssetId: clip.assetId, source: structuredClone(d.media[clip.assetId]!), sourceInUs: clip.sourceInUs,
      sourceDurationUs: clip.endUs - clip.startUs, outputFrames: timing.endFrame - timing.startFrame,
      frameRate: { ...d.frameRate }, requestedState: edit.state, instruction: definition.states[edit.state]!.label,
      preserveEntityIds: Object.keys(d.semantic.entities).filter(id => id !== event.entityId), scope: "shot", ...(selection?{selection}:{}) });
  } else {
    requireThat(d.scene.layers.some(l => l.eventId === event.id && l.kind !== "video") && Object.keys(definition.states[edit.state]!.motion ?? {}).length > 0, "MISSING_VISUAL_BINDING", "Keyframe action requires explicit motion and a procedural visual layer");
  }
  // The plan stores declarative intent; apply recomputes it and rejects edited/tampered effects.
  return { id: crypto.randomUUID(), status: tasks.length ? "awaiting-media" : "ready", baseRevision: d.editor.revision,
    base: structuredClone(d), edit: structuredClone(edit), changes, tasks };
}

export function applyAction(workspace: EventWorkspace, plan: ActionPlan, receipts: GenerationReceipt[] = []): EventWorkspace {
  validateWorkspace(workspace);
  requireThat(plan && canonical(workspace.document) === canonical(plan.base) && workspace.document.editor.revision === plan.baseRevision, "STALE_PLAN", "Project changed after planning; re-plan the edit");
  requireThat(!workspace.transactions.some(tx => tx.id === plan.id), "DUPLICATE_TRANSACTION", plan.id);
  const rebuilt = planAction(workspace.document, plan.edit);
  requireThat(canonical(rebuilt.changes) === canonical(plan.changes) && canonical(rebuilt.tasks) === canonical(plan.tasks) && rebuilt.status === plan.status, "PLAN_MISMATCH", "Plan contents do not match the compiled edit");
  requireThat(receipts.length === plan.tasks.length && new Set(receipts.map(r => r.taskId)).size === receipts.length, "MEDIA_REQUIRED", "Every video edit requires one validated, reviewed media receipt");
  const next = structuredClone(workspace);
  const d = next.document;
  changeActionState(d, plan.edit);
  const resolved = resolveEvents(d);
  const commands: EditorCommand[] = [];
  for (const task of plan.tasks) {
    const receipt = receipts.find(r => r.taskId === task.id);
    requireThat(receipt && receipt.review?.accepted === true && receipt.review.note.trim() && receipt.provider?.trim(), "MEDIA_REQUIRED", "Generated video needs explicit quality review and provenance");
    requireThat(receipt.frames === task.outputFrames && canonical(receipt.frameRate) === canonical(task.frameRate) && receipt.width === d.editor.settings.width && receipt.height === d.editor.settings.height, "MEDIA_MISMATCH", "Generated video frame domain/canvas differs from the plan");
    requireThat(!d.editor.assets[receipt.assetId], "ASSET_EXISTS", receipt.assetId);
    const event = d.events.find(e => e.id === task.eventId)!;
    commands.push({ kind: "setAsset", assetId: receipt.assetId, asset: { id: receipt.assetId, kind: "video", name: receipt.media.path.split("/").at(-1)!, durationUs: frameToUs(d, receipt.frames), width: receipt.width, height: receipt.height } });
    commands.push({ kind: "setClipAsset", clipId: event.clipId!, assetId: receipt.assetId });
    commands.push({ kind: "setClipRange", clipId: event.clipId!, sourceInUs: 0 });
    d.media[receipt.assetId] = structuredClone(receipt.media);
    for (const layer of d.scene.layers) if (layer.eventId === task.eventId && layer.assetId === task.sourceAssetId) layer.assetId = receipt.assetId;
  }
  for (const result of resolved) {
    if (!plan.changes.some(c => c.eventId === result.id)) continue;
    const event = d.events.find(e => e.id === result.id)!;
    if (event.clipId) {
      commands.push({ kind: "setClipRange", clipId: event.clipId, startUs: frameToUs(d, result.startFrame), endUs: frameToUs(d, result.endFrame) });
      commands.push({ kind: "setClipAttrs", clipId: event.clipId, attrs: { eventId: event.id, eventActive: result.active, ...(result.text !== undefined ? { text: result.text } : {}), ...(event.action ? { actionState: event.action.state, motion: d.actions[event.action.definitionId]!.states[event.action.state]!.motion ?? {} } : {}) } });
    }
    d.semantic.entities[event.entityId]!.attributes[`event:${event.id}`] = { active: result.active, startFrame: result.startFrame, endFrame: result.endFrame, ...(result.state ? { state: result.state } : {}) };
  }
  // One composite command validates the final state, permitting atomic asset/range replacement.
  d.editor = dryRun(d.editor, [{ kind: "composite", commands }]);
  d.editor.revision = plan.baseRevision + 1;
  d.editor.settings.durationUs = frameToUs(d, resolveFrameCount(d, resolved));
  for (const entity of Object.values(d.semantic.entities)) {
    if (!plan.changes.some(c => c.after.entityId === entity.id)) continue;
    const active = resolved.filter(e => e.entityId === entity.id && e.active);
    if (active.length) entity.lifecycle = { enterUs: frameToUs(d, Math.min(...active.map(e => e.startFrame))), exitUs: frameToUs(d, Math.max(...active.map(e => e.endFrame))) };
  }
  validateDocument(d);
  next.transactions.push({ id: plan.id, status: "committed", plan: structuredClone(plan), before: structuredClone(workspace.document), after: structuredClone(d), receipts: structuredClone(receipts), journal: [
    { type: "action.requested", revision: plan.baseRevision, detail: `${plan.edit.eventId} -> ${plan.edit.state}` },
    ...plan.changes.map(c => ({ type: "event.recomputed", revision: d.editor.revision, detail: c.eventId })),
    ...receipts.map(r => ({ type: "media.accepted", revision: d.editor.revision, detail: `${r.taskId}:${r.media.sha256}` })),
    { type: "transaction.committed", revision: d.editor.revision, detail: plan.id },
  ] });
  return next;
}

/** Revert only the latest applied content, retaining monotonic revision and audit history. */
export function rollbackAction(workspace: EventWorkspace, transactionId: string): EventWorkspace {
  validateWorkspace(workspace);
  const tx = workspace.transactions.find(t => t.id === transactionId);
  requireThat(tx?.status === "committed", "NOT_COMMITTED", "Transaction is absent or already rolled back");
  const current = { ...workspace.document, editor: { ...workspace.document.editor, revision: tx.after.editor.revision } };
  requireThat(canonical(current) === canonical(tx.after), "ROLLBACK_CONFLICT", "Later content exists; roll it back first");
  const next = structuredClone(workspace);
  next.document = structuredClone(tx.before);
  next.document.editor.revision = workspace.document.editor.revision + 1;
  const record = next.transactions.find(t => t.id === transactionId)!;
  record.status = "rolled-back";
  record.journal.push({ type: "transaction.rolled-back", revision: next.document.editor.revision, detail: transactionId });
  return next;
}

export function validateWorkspace(workspace: EventWorkspace): void {
  requireThat(workspace?.schema === "cassie/events@1" && Array.isArray(workspace.transactions), "INVALID_SCHEMA", "Expected cassie/events@1 workspace");
  resolveEvents(workspace.document);
  const ids = new Set<string>();
  for (const tx of workspace.transactions) {
    requireThat(tx && typeof tx.id === "string" && !ids.has(tx.id) && ["committed", "rolled-back"].includes(tx.status) && Array.isArray(tx.journal), "INVALID_HISTORY", "Invalid transaction history");
    ids.add(tx.id); validateDocument(tx.before); validateDocument(tx.after);
  }
}
export function parseWorkspace(json: string): EventWorkspace {
  const parsed = JSON.parse(json) as EventWorkspace;
  validateWorkspace(parsed); return parsed;
}
