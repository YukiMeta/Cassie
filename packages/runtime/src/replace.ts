import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { DocumentEdit, EventDocument, RegionKey, SubjectRegion } from '@cassie/spec';
import { runTracker } from './track';
import { findClip } from '@cassie/editor-core';
import { EventError, resolveEvents } from '@cassie/harness';
import { importVideo, probeVideo, runProcess, verifiedMedia } from './media';

function shotOf(d: EventDocument, regionId: string) {
  const r = d.regions?.[regionId];
  if (!r) throw new EventError('MISSING_REGION', regionId);
  const layer = d.scene.layers.find(l => l.id === r.layerId)!, shot = d.events.find(e => e.id === layer.eventId)!;
  const clip = findClip(d.editor, shot.clipId!)!.clip, rate = d.frameRate.num / d.frameRate.den;
  return { r, shot, clip, startFrame: Math.round(clip.sourceInUs * rate / 1e6), frames: Math.round((clip.endUs - clip.startUs) * rate / 1e6), rate };
}

/**
 * One generation task per occurrence of an entity. Each task carries the exact source window of
 * its shot, the tracked boxes, the target reference and the instruction; no project is mutated.
 */
export async function planReplacement(d: EventDocument, root: string, entityId: string, reference: string, instruction: string, outDir: string) {
  resolveEvents(d);
  const entity = d.semantic.entities[entityId];
  const regions = Object.values(d.regions ?? {}).filter(r => r.entityId === entityId);
  if (!entity || !regions.length) throw new EventError('NO_OCCURRENCES', `Track ${entityId} before planning a replacement`);
  if (!instruction.trim()) throw new EventError('INVALID_INSTRUCTION', 'Describe the replacement');
  await mkdir(outDir, { recursive: true });
  const ref = join(outDir, `reference${basename(reference).match(/\.[a-z0-9]+$/i)?.[0] ?? '.png'}`);
  await copyFile(resolve(reference), ref);
  const events = resolveEvents(d), tasks = [];
  for (const region of regions) {
    const { r, shot, clip, startFrame, frames, rate } = shotOf(d, region.id);
    const source = await verifiedMedia(root, d.media[clip.assetId!]!), window = join(outDir, `${r.id}-source.mp4`);
    await runProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(startFrame / rate), '-i', source, '-frames:v', String(frames), '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', '-an', window], { timeoutMs: 300_000 });
    const seen = r.boxes.filter(b => b.length === 4), x0 = Math.min(...seen.map(b => b[0]!)), y0 = Math.min(...seen.map(b => b[1]!));
    const e = events.find(e => e.id === r.eventId)!;
    tasks.push({ regionId: r.id, shot: shot.id, timeline: [e.startFrame, e.endFrame], source: window, sourceWindow: { startFrame, frames }, reference: ref,
      unionBox: [x0, y0, Math.max(...seen.map(b => b[0]! + b[2]!)) - x0, Math.max(...seen.map(b => b[1]! + b[3]!)) - y0], instruction });
  }
  const plan = { schema: 'cassie/replace-plan@1', entity: { id: entityId, name: entity.name }, revision: d.editor.revision, tasks };
  await writeFile(join(outDir, 'plan.json'), JSON.stringify(plan, null, 2));
  return plan;
}

/** Turns a reviewed candidate for one occurrence into an undoable region replacement. */
export async function replaceRegion(d: EventDocument, root: string, regionId: string, candidate: string, opts: { provider: string; review: string; instruction: string; pad?: number; keys?: RegionKey[] }): Promise<Extract<DocumentEdit, { kind: 'set-region-replacement' }>> {
  const { r, frames, rate, startFrame } = shotOf(d, regionId);
  if (!opts.provider.trim() || !opts.review.trim()) throw new EventError('INVALID_REVIEW', 'A provider and an explicit review note are required');
  const info = await probeVideo(resolve(candidate));
  // Generators round durations; more than 10% drift means the candidate is not this shot.
  if (Math.abs(info.frames / (info.frameRate.num / info.frameRate.den) - frames / rate) > 0.1 * frames / rate) throw new EventError('CANDIDATE_DOMAIN', `Candidate lasts ${(info.frames / (info.frameRate.num / info.frameRate.den)).toFixed(2)}s, shot lasts ${(frames / rate).toFixed(2)}s`);
  const { media } = await importVideo(root, resolve(candidate));
  const assetId = `rep-${media.sha256.slice(0, 12)}`;
  let align: NonNullable<NonNullable<SubjectRegion['replacement']>['align']> | undefined;
  if (opts.keys?.length) {
    // Generators reframe slightly; track the new object in the candidate and register it to the source box.
    const fps = info.frameRate.num / info.frameRate.den;
    const out = await runTracker(root, resolve(candidate), 0, info.frames, { x: 0, y: 0, width: info.width, height: info.height }, opts.keys);
    const ratios = out.boxes.flatMap((b, i) => {
      const s = r.boxes[startFrame + Math.round(i / fps * rate) - r.sourceStartFrame];
      return b.length === 4 && s?.length === 4 ? [Math.sqrt((s[2]! * s[3]!) / (b[2]! * b[3]!))] : [];
    }).sort((a, b) => a - b);
    if (!ratios.length) throw new EventError('ALIGN_FAILED', 'The new object was not tracked where the source object exists');
    align = { boxes: out.boxes, fps, width: info.width, height: info.height, scale: ratios[Math.floor(ratios.length / 2)]! };
  }
  return { kind: 'set-region-replacement', regionId, replacement: { assetId, sha256: media.sha256, pad: opts.pad ?? 24, provider: opts.provider, review: opts.review, instruction: opts.instruction, ...(align ? { align } : {}) },
    asset: { id: assetId, kind: 'video', name: basename(candidate), durationUs: Math.round(info.frames * 1e6 * info.frameRate.den / info.frameRate.num), width: info.width, height: info.height }, media };
}
