import type { EventDocument, ResolvedEvent } from "@cassie/spec";
import { EventError, resolveEvents, resolveFrameCount } from "./events";

/**
 * Selectors address what is on screen as entity × time × region, so a sentence like
 * "keep the CTA off the product" resolves to exact layers, frames and canvas pixels.
 *
 *   entity:bottle            every entity whose name or kind contains "bottle"
 *   entity#host [shot=2]     one entity, only inside the second shot
 *   overlay[var=cta] t=8..12 the overlay bound to `cta`, between 8s and 12s
 *   clip [shot=3] f=0..48    the third shot, timeline frames 0–47
 *   entity#product sf=120..240  tracked frames by source-frame number, stable across retime
 */
export type SelectorTarget = "entity" | "overlay" | "clip";
export type Box = [number, number, number, number];
export interface Selector {
  target: SelectorTarget;
  concept?: string;
  id?: string;
  filters: Record<string, string>;
  /** Half-open timeline frame range. */
  frames?: [number, number];
  /** Half-open source frame range; only tracked regions carry source frames. */
  sourceFrames?: [number, number];
  part: "bbox";
}
export interface SelectorMatch {
  target: SelectorTarget;
  id: string;
  name: string;
  /** Timeline frame → canvas-pixel box. Frames without geometry are absent. */
  boxes: Map<number, Box>;
}

const SELECTOR = /^(entity|overlay|clip)(?::([^\s#[~]+))?(?:#([\w-]+))?((?:\s*\[[\w-]+=[^\]]+\])*)\s*(?:(t|f|sf)=(\d+(?:\.\d+)?)(?:\.\.(\d+(?:\.\d+)?))?)?\s*(?:~(bbox))?$/;

export function parseSelector(text: string, fps: number): Selector {
  const m = SELECTOR.exec(text.trim());
  if (!m) throw new EventError("INVALID_SELECTOR", `Cannot parse selector: ${text}. Form: entity|overlay|clip[:concept][#id][ [key=value]][ t=a..b | f=a..b | sf=a..b][~bbox]`);
  const filters = Object.fromEntries([...(m[4] ?? "").matchAll(/\[([\w-]+)=([^\]]+)\]/g)].map(f => [f[1]!, f[2]!.trim()]));
  const sel: Selector = { target: m[1] as SelectorTarget, concept: m[2]?.toLowerCase(), id: m[3], filters, part: "bbox" };
  if (m[5]) {
    const a = Number(m[6]), b = m[7] === undefined ? undefined : Number(m[7]);
    const range: [number, number] = m[5] === "t" ? [Math.round(a * fps), b === undefined ? Math.round(a * fps) + 1 : Math.round(b * fps)] : [a, b ?? a + 1];
    if (!(range[1] > range[0])) throw new EventError("INVALID_SELECTOR", `Empty time range in ${text}`);
    if (m[5] === "sf") sel.sourceFrames = range; else sel.frames = range;
  }
  return sel;
}

const fpsOf = (d: EventDocument) => d.frameRate.num / d.frameRate.den;
const usToFrame = (d: EventDocument, us: number) => Math.round(us * fpsOf(d) / 1e6);

/** Video shots in timeline order; `[shot=N]` is 1-based into this list. */
export function shots(d: EventDocument, events = resolveEvents(d)) {
  const videoEvents = new Set(d.scene.layers.filter(l => l.kind === "video" && l.eventId).map(l => l.eventId));
  return events.filter(e => e.active && videoEvents.has(e.id)).sort((a, b) => a.startFrame - b.startFrame);
}

function layerBox(l: { x: number; y: number; width: number; height: number }): Box {
  return [l.x, l.y, l.width, l.height];
}

function spanBoxes(range: ResolvedEvent | undefined, box: Box, frameCount: number) {
  const boxes = new Map<number, Box>();
  const [from, to] = range ? [range.startFrame, range.endFrame] : [0, frameCount];
  for (let f = Math.max(0, from); f < Math.min(to, frameCount); f++) boxes.set(f, box);
  return boxes;
}

/** Canvas-pixel boxes of every region of an entity, keyed by timeline frame, plus each frame's source frame. */
function regionBoxes(d: EventDocument, entityId: string, events: ResolvedEvent[]) {
  const boxes = new Map<number, Box>(), source = new Map<number, number>();
  for (const r of Object.values(d.regions ?? {}).filter(r => r.entityId === entityId)) {
    const layer = d.scene.layers.find(l => l.id === r.layerId);
    const shot = events.find(e => e.id === layer?.eventId), own = events.find(e => e.id === r.eventId);
    const clip = d.editor.tracks.flatMap(t => t.clips).find(c => c.id === d.events.find(e => e.id === shot?.id)?.clipId);
    const asset = d.editor.assets[r.sourceAssetId];
    if (!layer || !shot || !own?.active || !clip) continue;
    const sw = layer.crop?.width ?? asset?.width ?? layer.width, sh = layer.crop?.height ?? asset?.height ?? layer.height;
    const sx = layer.width / sw, sy = layer.height / sh, cx = layer.crop?.x ?? 0, cy = layer.crop?.y ?? 0;
    const clipStart = usToFrame(d, clip.sourceInUs);
    for (let f = Math.max(own.startFrame, shot.startFrame); f < Math.min(own.endFrame, shot.endFrame); f++) {
      const sf = clipStart + (f - shot.startFrame), b = r.boxes[sf - r.sourceStartFrame];
      if (!b || b.length !== 4) continue;
      boxes.set(f, [layer.x + (b[0]! - cx) * sx, layer.y + (b[1]! - cy) * sy, b[2]! * sx, b[3]! * sy]);
      source.set(f, sf);
    }
  }
  return { boxes, source };
}

export function resolveSelector(d: EventDocument, selector: string | Selector): SelectorMatch[] {
  const sel = typeof selector === "string" ? parseSelector(selector, fpsOf(d)) : selector;
  const events = resolveEvents(d), frameCount = resolveFrameCount(d, events);
  const byId = new Map(events.map(e => [e.id, e]));
  const conceptHit = (...names: (string | undefined)[]) => !sel.concept || names.some(n => n?.toLowerCase().includes(sel.concept!));
  let matches: (SelectorMatch & { source?: Map<number, number> })[] = [];

  if (sel.target === "overlay") {
    for (const l of d.scene.layers.filter(l => l.kind === "text")) {
      const entity = d.semantic.entities[l.entityId];
      if (sel.id && l.id !== sel.id) continue;
      if (sel.filters.var && l.bind?.text !== sel.filters.var) continue;
      if (!conceptHit(entity?.name, l.id, l.text)) continue;
      matches.push({ target: "overlay", id: l.id, name: entity?.name ?? l.id, boxes: spanBoxes(l.eventId ? byId.get(l.eventId) : undefined, layerBox(l), frameCount) });
    }
  } else if (sel.target === "clip") {
    shots(d, events).forEach((shot, i) => {
      const layer = d.scene.layers.find(l => l.eventId === shot.id && l.kind === "video")!;
      const clipId = d.events.find(e => e.id === shot.id)?.clipId ?? shot.id;
      if (sel.id && clipId !== sel.id && shot.id !== sel.id) return;
      matches.push({ target: "clip", id: clipId, name: `镜头 ${i + 1}`, boxes: spanBoxes(shot, layerBox(layer), frameCount) });
    });
  } else {
    for (const entity of Object.values(d.semantic.entities)) {
      if (sel.id && entity.id !== sel.id) continue;
      if (sel.filters.kind && entity.kind !== sel.filters.kind) continue;
      if (!conceptHit(entity.name, entity.kind, entity.id)) continue;
      const tracked = regionBoxes(d, entity.id, events);
      let boxes = tracked.boxes;
      if (!boxes.size) {
        const layer = d.scene.layers.find(l => l.entityId === entity.id && l.kind !== "video");
        if (layer) boxes = spanBoxes(layer.eventId ? byId.get(layer.eventId) : undefined, layerBox(layer), frameCount);
      }
      if (boxes.size) matches.push({ target: "entity", id: entity.id, name: entity.name, boxes, source: tracked.source });
    }
  }

  if (sel.filters.shot) {
    const shot = shots(d, events)[Number(sel.filters.shot) - 1];
    if (!shot) throw new EventError("INVALID_SELECTOR", `No shot ${sel.filters.shot}; the cut has ${shots(d, events).length}`);
    matches = matches.map(m => ({ ...m, boxes: new Map([...m.boxes].filter(([f]) => f >= shot.startFrame && f < shot.endFrame)) }));
  }
  if (sel.frames) {
    const [a, b] = sel.frames;
    matches = matches.map(m => ({ ...m, boxes: new Map([...m.boxes].filter(([f]) => f >= a && f < b)) }));
  }
  if (sel.sourceFrames) {
    const [a, b] = sel.sourceFrames;
    matches = matches.map(m => ({ ...m, boxes: new Map([...m.boxes].filter(([f]) => { const s = m.source?.get(f); return s !== undefined && s >= a && s < b; })) }));
  }
  return matches.filter(m => m.boxes.size).map(({ source: _source, ...m }) => m);
}

/** Contiguous frame runs, for echoing a selection back to a human. */
export function frameRuns(frames: Iterable<number>): [number, number][] {
  const runs: [number, number][] = [];
  for (const f of [...frames].sort((a, b) => a - b)) {
    const last = runs.at(-1);
    if (last && last[1] === f) last[1] = f + 1; else runs.push([f, f + 1]);
  }
  return runs;
}

const overlaps = (a: Box, b: Box, pad: number) =>
  a[0] < b[0] + b[2] + pad && b[0] - pad < a[0] + a[2] && a[1] < b[1] + b[3] + pad && b[1] - pad < a[1] + a[3];

export interface LayoutCheck {
  ok: boolean;
  /** Set when nothing was compared, so `ok` cannot be read as "clear". */
  unchecked?: string;
  /** Frames where `subject` touches `avoid` (grown by `pad` px), per avoided match. */
  violations: { subject: string; avoid: string; frames: [number, number][]; count: number }[];
  /**
   * The nearest position for an overlay that clears every avoided box on every frame; `narrow` when it only
   * fits by also reducing its width, which reflows the text, so it needs a look.
   */
  suggestions: { layerId: string; patch: { x: number; y: number; width?: number }; reason: "move" | "narrow" }[];
}

/** `no_overlap(subject, avoid, pad)`: the subject must stay `pad` canvas px clear of everything `avoid` selects. */
export function checkNoOverlap(d: EventDocument, subject: string, avoid: string, pad = 0): LayoutCheck {
  const subjects = resolveSelector(d, subject), avoided = resolveSelector(d, avoid);
  const violations: LayoutCheck["violations"] = [], suggestions: LayoutCheck["suggestions"] = [];
  const canvasW = d.editor.settings.width, canvasH = d.editor.settings.height;
  if (!subjects.length) return { ok: false, unchecked: `${subject} matched nothing on screen`, violations, suggestions };
  if (!avoided.some(a => subjects.some(s => s.id !== a.id))) return { ok: false, unchecked: `${avoid} matched nothing on screen to keep clear of; track that subject first, or check by eye with preview_frame`, violations, suggestions };
  for (const s of subjects) {
    let hit = false;
    for (const a of avoided) {
      if (a.id === s.id) continue;
      const frames = [...s.boxes].filter(([f, box]) => { const o = a.boxes.get(f); return o && overlaps(box, o, pad); }).map(([f]) => f);
      if (frames.length) { hit = true; violations.push({ subject: s.id, avoid: a.id, frames: frameRuns(frames), count: frames.length }); }
    }
    if (!hit || s.target !== "overlay") continue;
    const layer = d.scene.layers.find(l => l.id === s.id)!;
    const blocked = [...s.boxes.keys()].flatMap(f => avoided.filter(a => a.id !== s.id).map(a => a.boxes.get(f)).filter((b): b is Box => !!b));
    const clear = (box: Box) => blocked.every(b => !overlaps(box, b, pad));
    const mx = Math.round(canvasW * 0.04), my = Math.round(canvasH * 0.04);
    const near = (x: number, y: number) => Math.hypot(x - layer.x, y - layer.y);
    const xs = [layer.x, mx, canvasW - mx - layer.width, ...blocked.flatMap(b => [b[0] + b[2] + pad, b[0] - pad - layer.width])].map(Math.round).filter(x => x >= 0 && x + layer.width <= canvasW);
    const ys = [layer.y, my, canvasH - my - layer.height, ...blocked.flatMap(b => [b[1] + b[3] + pad, b[1] - pad - layer.height])].map(Math.round).filter(y => y >= 0 && y + layer.height <= canvasH);
    const moves = xs.flatMap(x => ys.map(y => ({ x, y }))).filter(p => clear([p.x, p.y, layer.width, layer.height])).sort((p, q) => near(p.x, p.y) - near(q.x, q.y));
    if (moves[0]) { suggestions.push({ layerId: layer.id, patch: moves[0], reason: "move" }); continue; }
    // Nothing fits at this size: offer the widest clear column beside what must stay visible.
    const left = Math.min(...blocked.map(b => b[0])) - pad, right = Math.max(...blocked.map(b => b[0] + b[2])) + pad;
    const sides = [{ x: mx, width: Math.round(left - mx) }, { x: Math.round(right), width: Math.round(canvasW - mx - right) }].filter(c => c.width >= layer.width * 0.4).sort((a, b) => b.width - a.width);
    for (const side of sides) {
      const y = ys.find(y => clear([side.x, y, side.width, layer.height]));
      if (y !== undefined) { suggestions.push({ layerId: layer.id, patch: { x: side.x, y, width: side.width }, reason: "narrow" }); break; }
    }
  }
  return { ok: violations.length === 0, violations, suggestions };
}
