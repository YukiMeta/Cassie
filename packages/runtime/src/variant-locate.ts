import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DocumentEdit, EventDocument, RegionKey, SubjectRegion } from '@cassie/spec';
import { EventError, canonical, resolveEvents, subjectRefsFor } from '@cassie/harness';
import { runProcess, verifiedMedia } from './media';
import { sam3Service, sam3Shot } from './concept';
import { defaultLocator, loadLesson, locateOnFrame, rememberLesson, type LessonId } from './locate';
import { runTracker } from './track';
import { findClip } from '@cassie/editor-core';

/**
 * Locate subjects in a variant's take: the same locate step as trackConcept (Jev or OWLv2, with
 * Harness²-style lessons from the master's cache), then SAM 3 or the native tracker follows the
 * whole take. The result is a variant-local SubjectRegion, so selectors like `entity:phone` and
 * `check_layout` resolve on the variant's own canvas. Locations that are not found are reported,
 * never guessed.
 */
export interface VariantLocateRequest {
  variantId: string;
  /** Subject ids to relocate; omit for every subject tracked on the master. */
  entityIds?: string[];
  threshold?: number;
}
export interface VariantLocateEntity {
  entityId: string;
  name: string;
  found: boolean;
  lesson?: LessonId;
  score?: number;
  frames?: number;
  backend?: string;
  /** Region already matches; nothing to write. */
  unchanged?: boolean;
  message: string;
}
export interface VariantLocateResult {
  variantId: string;
  edits: Extract<DocumentEdit, { kind: 'track-variant-region' }>[];
  entities: VariantLocateEntity[];
  backend: string;
}

const SAMPLES = [0.5, 0.25, 0.75];

/** Entities the master tracks, in id order. */
function trackedSubjects(d: EventDocument): string[] {
  const ids = new Set<string>();
  for (const r of Object.values(d.regions ?? {})) {
    const e = d.semantic.entities[r.entityId];
    if (e?.kind === 'subject' && Array.isArray(e.attributes.regions) && e.attributes.regions.length) ids.add(r.entityId);
  }
  return [...ids];
}

/** The prompt to locate a subject in a variant: the scope-matched SAM 3 concept, else the master lesson prompt, else the name. */
async function promptFor(d: EventDocument, projectRoot: string, variantId: string, entityId: string, name: string): Promise<string> {
  const v = d.variants?.items[variantId];
  const scoped = v ? subjectRefsFor(d, v)[entityId]?.prompt : undefined;
  if (scoped?.trim()) return scoped.trim();
  const lesson = await loadLesson(join(projectRoot, 'project.cassie.json'), entityId);
  if (lesson.prompt?.trim()) return lesson.prompt.trim();
  return name;
}

/** One undoable track-variant-region edit when the subject is found in the take; skips when unchanged. */
export async function locateInVariant(d: EventDocument, projectRoot: string, request: VariantLocateRequest, progress = (_message: string) => {}): Promise<VariantLocateResult> {
  const v = d.variants?.items[request.variantId];
  if (!v) throw new EventError('MISSING_VARIANT', request.variantId);
  if (!v.take) throw new EventError('MISSING_TAKE', `Variant ${request.variantId} has no take to locate in`);
  const take = v.take;
  if (!d.media[take.assetId]) throw new EventError('MISSING_TAKE', `Variant ${request.variantId} take media is missing`);
  const want = request.entityIds?.length ? request.entityIds : trackedSubjects(d);
  if (!want.length) throw new EventError('NO_SUBJECTS', 'Track a subject on the master before locating it in a variant');

  const dir = await mkdtemp(join(tmpdir(), 'cassie-variant-locate-'));
  try {
    const locator = await defaultLocator();
    const sam3 = await sam3Service();
    if (!locator && !sam3) throw new EventError('DETECTOR', 'No locator (Jev or OWLv2) and no SAM 3 service.');
    const rate = d.frameRate.num / d.frameRate.den;
    const frames = Math.max(1, Math.floor(take.durationUs * rate / 1e6));
    const source = await verifiedMedia(projectRoot, d.media[take.assetId]!);
    const lessonFile = join(projectRoot, 'project.cassie.json');
    const edits: Extract<DocumentEdit, { kind: 'track-variant-region' }>[] = [];
    const entities: VariantLocateEntity[] = [];
    for (const entityId of want) {
      const entity = d.semantic.entities[entityId];
      if (!entity || entity.kind !== 'subject' || !Array.isArray(entity.attributes.regions) || !entity.attributes.regions.length) {
        entities.push({ entityId, name: entity?.name ?? entityId, found: false, message: `没有在母版上跟踪过 ${entityId}，先 track_subject` });
        continue;
      }
      const prompt = await promptFor(d, projectRoot, request.variantId, entityId, entity.name);
      const known = (await loadLesson(lessonFile, entityId)).lessons;
      const existing = v.regions?.[entityId];
      const master = Object.values(d.regions ?? {}).find(r => r.entityId === entityId);
      let seed: { sf: number; box: [number, number, number, number]; score: number; lesson?: LessonId; backend?: string } | undefined;
      if (locator) {
        progress(`定位「${prompt}」：${request.variantId}`);
        for (const p of SAMPLES) {
          const sf = Math.min(frames - 1, Math.floor(frames * p));
          const still = join(dir, `${entityId}-${sf}.png`);
          await runProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-vf', `select=eq(n\\,${sf})`, '-frames:v', '1', still], { timeoutMs: 120_000 });
          const hit = await locateOnFrame(locator, still, prompt, dir, known, request.threshold ?? 0.35);
          if (hit && hit.score >= (seed?.score ?? 0)) seed = { sf, box: hit.box, score: hit.score, lesson: hit.lesson, backend: hit.backend };
          if (seed && seed.score >= 0.5) break;
        }
        if (seed?.lesson && seed.lesson !== 'full') {
          await rememberLesson(lessonFile, entityId, prompt, seed.lesson as LessonId).catch(() => undefined);
        }
      }
      let region: SubjectRegion | undefined;
      if (sam3) {
        progress(`SAM 3 跟踪「${prompt}」：${request.variantId}`);
        const out = await sam3Shot(sam3, source, prompt, 0, frames, rate, dir);
        const first = out?.boxes.findIndex(b => b.length === 4) ?? -1;
        if (out && first >= 0) {
          const keyBox = (seed?.box ?? out.boxes[first]!) as [number, number, number, number];
          region = {
            id: entityId, entityId, eventId: `region-${entityId}`, layerId: 'variant-base',
            sourceAssetId: take.assetId, sourceSha256: take.sha256, sourceStartFrame: 0,
            keys: [{ sourceFrame: seed?.sf ?? first, box: keyBox }],
            boxes: out.boxes, confidence: out.confidence, backend: seed ? `${seed.backend}+sam3` : 'sam3',
            look: existing?.look ?? master?.look ?? { color: '#2f7cf6', tint: 0.85, feather: 6 },
          };
        }
      }
      if (!region && seed) {
        progress(`${request.variantId}：${seed.lesson ?? 'full'} 找到「${prompt}」(${seed.score.toFixed(2)})，逐帧跟踪…`);
        const key: RegionKey = { sourceFrame: seed.sf, box: seed.box };
        const out = await runTracker(projectRoot, source, 0, frames, { x: 0, y: 0, width: take.width, height: take.height }, [key]);
        region = {
          id: entityId, entityId, eventId: `region-${entityId}`, layerId: 'variant-base',
          sourceAssetId: take.assetId, sourceSha256: take.sha256, sourceStartFrame: 0, keys: [key],
          boxes: out.boxes, confidence: out.confidence, backend: `${seed.backend}+${out.backend}`,
          look: existing?.look ?? master?.look ?? { color: '#2f7cf6', tint: 0.85, feather: 6 },
        };
        if (region.boxes.flatMap(b => b.length ? [1] : []).length === 0) region = undefined;
      }
      if (!region) {
        entities.push({ entityId, name: entity.name, found: false, message: `在 ${request.variantId} 里没有找到「${prompt}」，没有猜` });
        continue;
      }
      const framesFound = region.boxes.filter(b => b.length === 4).length;
      if (existing && canonical(existing) === canonical(region)) {
        entities.push({ entityId, name: entity.name, found: true, unchanged: true, score: seed?.score, frames: framesFound, backend: region.backend, message: `${request.variantId} 里的「${prompt}」已是当前位置` });
        continue;
      }
      edits.push({ kind: 'track-variant-region', variantId: request.variantId, region });
      entities.push({ entityId, name: entity.name, found: true, lesson: seed?.lesson, score: seed?.score, frames: framesFound, backend: region.backend, message: `${request.variantId} 里找到「${prompt}」并跟踪 ${framesFound} 帧` });
    }
    const backend = [...new Set(entities.map(e => e.backend).filter(Boolean))].join(',') || '';
    return { variantId: request.variantId, edits, entities, backend };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}