import type { DocumentEdit, EventDocument, RegionKey, SubjectRegion } from '@cassie/spec';
import { findClip } from '@cassie/editor-core';
import { EventError, resolveEvents } from '@cassie/harness';
import { runProcess, verifiedMedia } from './media';
import { nativeExecutable } from './matte';

export interface TrackRequest {
  layerId: string;
  regionId: string;
  /** Shared by every region showing the same thing, e.g. the product in each shot. */
  entityId: string;
  name?: string;
  /** Keys in source frames of the layer's asset. Merged with existing keys on re-track. */
  keys: RegionKey[];
  look?: Partial<SubjectRegion['look']>;
}

/** Runs the native tracker over `frames` frames from `start`; keys are absolute source frames. */
export async function runTracker(projectRoot: string, file: string, start: number, frames: number, clamp: { x: number; y: number; width: number; height: number }, keys: RegionKey[]): Promise<{ boxes: number[][]; confidence: number[]; backend: string; span: [number, number] }> {
  const executable = await nativeExecutable(projectRoot, 'region-track');
  return JSON.parse(await runProcess(executable, [file, String(start), String(frames), ...[clamp.x, clamp.y, clamp.width, clamp.height].map(String), ...keys.map(k => `${k.sourceFrame - start}:${k.box.join(',')}`)], { timeoutMs: 900_000 }));
}

/** Tracks a user-boxed part of one shot through the shot's source window. Produces an undoable edit. */
export async function trackRegion(d: EventDocument, projectRoot: string, request: TrackRequest, progress = (message: string) => {}): Promise<Extract<DocumentEdit, { kind: 'track-region' }>> {
  resolveEvents(d);
  const layer = d.scene.layers.find(l => l.id === request.layerId), shot = layer?.eventId ? d.events.find(e => e.id === layer.eventId) : undefined;
  const clip = shot?.clipId ? findClip(d.editor, shot.clipId)?.clip : undefined;
  if (!layer || layer.kind !== 'video' || !clip?.assetId || !d.media[clip.assetId]) throw new EventError('REGION_TARGET', 'Select a video layer bound to source media');
  const asset = d.editor.assets[clip.assetId]!;
  const existing = d.regions?.[request.regionId];
  const keys = [...(existing?.keys ?? []).filter(k => !request.keys.some(n => n.sourceFrame === k.sourceFrame)), ...request.keys].sort((a, b) => a.sourceFrame - b.sourceFrame);
  const rate = d.frameRate.num / d.frameRate.den;
  const start = Math.round(clip.sourceInUs * rate / 1e6), frames = Math.round((clip.endUs - clip.startUs) * rate / 1e6);
  const clamp = layer.crop ?? { x: 0, y: 0, width: asset.width!, height: asset.height! };
  if (!keys.length || keys.some(k => !Number.isSafeInteger(k.sourceFrame) || k.sourceFrame < start || k.sourceFrame >= start + frames || k.box.length !== 4 || !k.box.every(Number.isFinite))) throw new EventError('INVALID_KEYS', `Key frames must lie in the shot's source window ${start}..${start + frames - 1}`);
  const source = await verifiedMedia(projectRoot, d.media[clip.assetId]!);
  progress(`逐帧跟踪：${frames} 帧，${keys.length} 个关键框`);
  const out = await runTracker(projectRoot, source, start, frames, clamp, keys);
  const look = { color: '#2f7cf6', tint: 0.85, feather: 6, ...existing?.look, ...request.look };
  const region: SubjectRegion = {
    id: request.regionId, entityId: request.entityId, eventId: existing?.eventId ?? `region-${request.regionId}`, layerId: layer.id,
    sourceAssetId: clip.assetId, sourceSha256: d.media[clip.assetId]!.sha256, sourceStartFrame: start, keys,
    boxes: out.boxes, confidence: out.confidence, backend: out.backend, look,
  };
  return { kind: 'track-region', region, ...(request.name ? { name: request.name } : {}) };
}
