import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { EventDocument } from '@cassie/spec';
import { findClip } from '@cassie/editor-core';
import { EventError, resolveEvents } from '@cassie/harness';
import { runProcess, verifiedMedia } from './media';

export interface DetectedObject { label: string; box: [number, number, number, number]; score: number }

const script = fileURLToPath(new URL('../native/detect.py', import.meta.url));

function python(projectRoot: string) {
  for (const dir of [projectRoot, join(fileURLToPath(new URL('../../..', import.meta.url)))]) {
    const bin = join(dir, '.cassie-cache/py/bin/python');
    if (existsSync(bin)) return bin;
  }
  throw new EventError('DETECTOR_MISSING', 'Object detector environment .cassie-cache/py is not installed');
}

/** Open-vocabulary detection on the source frame a video layer shows at timeline frame `frame`. Boxes are in source pixels. */
export async function detectObjects(d: EventDocument, projectRoot: string, layerId: string, frame: number, queries?: string[]) {
  const events = resolveEvents(d);
  const layer = d.scene.layers.find(l => l.id === layerId), shot = events.find(e => e.id === layer?.eventId);
  const clip = layer?.eventId ? findClip(d.editor, d.events.find(e => e.id === layer.eventId)?.clipId ?? '')?.clip : undefined;
  if (!layer || layer.kind !== 'video' || !shot || !clip?.assetId || !d.media[clip.assetId]) throw new EventError('REGION_TARGET', 'Select a video shot to detect objects');
  const rate = d.frameRate.num / d.frameRate.den;
  const local = Math.min(Math.max(frame, shot.startFrame), shot.endFrame - 1) - shot.startFrame;
  const sourceFrame = Math.round(clip.sourceInUs * rate / 1e6) + local;
  const source = await verifiedMedia(projectRoot, d.media[clip.assetId]!);
  const out = JSON.parse(await runProcess(python(projectRoot), [script, source, String(sourceFrame), ...(queries?.length ? [queries.join(',')] : [])], { timeoutMs: 600_000 })) as { objects: DetectedObject[] };
  const crop = layer.crop;
  const objects = crop ? out.objects.filter(o => o.box[0] + o.box[2] > crop.x && o.box[0] < crop.x + crop.width && o.box[1] + o.box[3] > crop.y && o.box[1] < crop.y + crop.height) : out.objects;
  return { layerId, sourceFrame, objects };
}
