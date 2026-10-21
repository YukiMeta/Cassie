import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DocumentEdit, EventDocument, RegionKey } from '@cassie/spec';
import { findClip } from '@cassie/editor-core';
import { EventError, resolveEvents, shots } from '@cassie/harness';
import { runProcess, verifiedMedia } from './media';
import { defaultLocator, loadLessons, locateOnFrame, rememberLesson } from './locate';
import { trackRegion } from './track';

/**
 * Finds a subject by name (a concept prompt like "phone") and tracks it through every shot it appears in,
 * so selectors such as `entity:phone` have per-frame boxes to resolve against.
 *
 * Locate (Jev or OWLv2, with a small experience harness) finds a seed box. SAM 3 or the native
 * tracker then follows it. Lessons from a miss (zoom, visible part, occlusion) are reused on later shots.
 */
export interface ConceptRequest {
  prompt: string;
  entityId: string;
  name?: string;
  /** 1-based shot numbers; omit for every shot. */
  shots?: number[];
  threshold?: number;
}
export interface ConceptShotResult { shot: number; shotEventId: string; found: boolean; score?: number; sourceFrame?: number; frames?: number }

/** The SAM 3 extraction service (servers/sam3) if one answers; it tracks whole shots itself. */
export async function sam3Service(): Promise<string | null> {
  const url = (process.env.CASSIE_SAM3_URL ?? 'http://127.0.0.1:8000').replace(/\/$/, '');
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(800) });
    const body = await r.json() as { ok?: boolean; model?: string };
    return r.ok && body.ok ? url : null;
  } catch { return null; }
}

type Sam3Track = { track_id: string | number; score: number; startUs: number; endUs: number; boxes: { t: number; box: [number, number, number, number] }[] };

/** Cuts one shot's source window and asks SAM 3 for the concept; returns per-source-frame boxes of the best track. */
async function sam3Shot(url: string, source: string, prompt: string, start: number, frames: number, rate: number, dir: string) {
  const clip = join(dir, `sam3-${start}.mp4`);
  await runProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-vf', `select=between(n\\,${start}\\,${start + frames - 1}),setpts=N/${rate}/TB`, '-r', String(rate), '-an', '-c:v', 'libx264', '-crf', '12', clip], { timeoutMs: 300_000 });
  const form = new FormData();
  form.append('file', new Blob([await readFile(clip)], { type: 'video/mp4' }), 'shot.mp4');
  form.append('prompts', JSON.stringify(prompt.split(',').map(p => p.trim()).filter(Boolean)));
  const r = await fetch(`${url}/extract`, { method: 'POST', body: form, signal: AbortSignal.timeout(900_000) });
  if (!r.ok) throw new EventError('DETECTOR', `SAM 3 service ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const tracks = ((await r.json()) as { candidates: { tracks: Sam3Track[] }[] }).candidates.flatMap(c => c.tracks);
  const best = tracks.sort((a, b) => b.boxes.length * (b.score || 1) - a.boxes.length * (a.score || 1))[0];
  if (!best?.boxes.length) return null;
  const boxes: number[][] = Array.from({ length: frames }, () => []), confidence = Array<number>(frames).fill(0);
  for (const { t, box } of best.boxes) {
    const i = Math.round(t * rate / 1e6);
    if (i >= 0 && i < frames) { boxes[i] = [box[0], box[1], box[2] - box[0], box[3] - box[1]].map(Math.round); confidence[i] = best.score || 1; }
  }
  return { boxes, confidence, score: best.score };
}

const SAMPLES = [0.5, 0.25, 0.75];

/** One undoable track-region edit per shot where the concept was found; shots without it are reported, not guessed. */
export async function trackConcept(d: EventDocument, projectRoot: string, request: ConceptRequest, progress = (_message: string) => {}): Promise<{ edits: Extract<DocumentEdit, { kind: 'track-region' }>[]; shots: ConceptShotResult[]; backend: string }> {
  if (!/^[a-z0-9-]{1,40}$/.test(request.entityId)) throw new EventError('INVALID_ENTITY', 'Entity id must be lowercase letters, digits and dashes');
  const existing = d.semantic.entities[request.entityId];
  if (existing && (existing.kind !== 'subject' || !existing.attributes.regions)) throw new EventError('INVALID_ENTITY', `${request.entityId} already names something that is not a tracked subject`);
  const all = shots(d, resolveEvents(d)), rate = d.frameRate.num / d.frameRate.den;
  const wanted = request.shots?.length ? request.shots : all.map((_, i) => i + 1);
  const dir = await mkdtemp(join(tmpdir(), 'cassie-concept-'));
  try {
    const plan = wanted.map(n => {
      const shot = all[n - 1];
      if (!shot) throw new EventError('INVALID_SELECTOR', `No shot ${n}; the cut has ${all.length}`);
      const layer = d.scene.layers.find(l => l.eventId === shot.id && l.kind === 'video')!;
      const clip = findClip(d.editor, d.events.find(e => e.id === shot.id)!.clipId!)!.clip;
      const start = Math.round(clip.sourceInUs * rate / 1e6), length = Math.round((clip.endUs - clip.startUs) * rate / 1e6);
      return { n, shot, layer, clip, samples: [...new Set(SAMPLES.map(p => start + Math.min(length - 1, Math.floor(length * p))))] };
    });
    const locator = await defaultLocator();
    const sam3 = await sam3Service();
    if (!locator && !sam3) throw new EventError('DETECTOR', 'No locator (Jev or OWLv2) and no SAM 3 service.');
    const lessonFile = join(projectRoot, 'project.cassie.json');
    const known = await loadLessons(lessonFile, request.entityId);
    const edits: Extract<DocumentEdit, { kind: 'track-region' }>[] = [], results: ConceptShotResult[] = [];
    let backend = locator?.name ?? 'sam3';
    let remembered = [...known];
    for (const p of plan) {
      const source = await verifiedMedia(projectRoot, d.media[p.clip.assetId!]!), c = p.layer.crop;
      const start = Math.round(p.clip.sourceInUs * rate / 1e6), frames = Math.round((p.clip.endUs - p.clip.startUs) * rate / 1e6);
      let seed: { sf: number; box: [number, number, number, number]; score: number; lesson?: string; backend?: string } | undefined;
      if (locator) {
        progress(`定位「${request.prompt}」：镜头 ${p.n}`);
        for (const sf of p.samples) {
          const still = join(dir, `${p.n}-${sf}.png`);
          await runProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-vf', `select=eq(n\\,${sf})${c ? `,crop=${c.width}:${c.height}:${c.x}:${c.y}` : ''}`, '-frames:v', '1', still], { timeoutMs: 120_000 });
          const hit = await locateOnFrame(locator, still, request.prompt, dir, remembered, request.threshold ?? 0.35);
          if (hit && hit.score >= (seed?.score ?? 0)) seed = { sf, box: hit.box, score: hit.score, lesson: hit.lesson, backend: hit.backend };
          if (seed && seed.score >= 0.5) break;
        }
        if (seed?.lesson) {
          remembered = [seed.lesson as typeof remembered[number], ...remembered.filter(l => l !== seed!.lesson)];
          await rememberLesson(lessonFile, request.entityId, request.prompt, seed.lesson as typeof remembered[number]).catch(() => undefined);
        }
      }
      if (sam3) {
        progress(`SAM 3 跟踪「${request.prompt}」：镜头 ${p.n}`);
        const out = await sam3Shot(sam3, source, request.prompt, start, frames, rate, dir);
        const first = out?.boxes.findIndex(b => b.length === 4) ?? -1;
        if (out && first >= 0) {
          const regionId = `${request.entityId}-${p.shot.id}`.slice(0, 60), prior = d.regions?.[regionId];
          const keyBox = (seed?.box ?? out.boxes[first]!) as [number, number, number, number];
          edits.push({ kind: 'track-region', name: request.name ?? request.prompt, region: {
            id: regionId, entityId: request.entityId, eventId: prior?.eventId ?? `region-${regionId}`, layerId: p.layer.id,
            sourceAssetId: p.clip.assetId!, sourceSha256: d.media[p.clip.assetId!]!.sha256, sourceStartFrame: start,
            keys: [{ sourceFrame: seed?.sf ?? start + first, box: c && seed ? [keyBox[0] + (c.x ?? 0), keyBox[1] + (c.y ?? 0), keyBox[2], keyBox[3]] : keyBox }],
            boxes: out.boxes, confidence: out.confidence, backend: seed ? `${seed.backend}+sam3` : 'sam3', look: prior?.look ?? { color: '#2f7cf6', tint: 0.85, feather: 6 },
          } });
          backend = seed ? `${seed.backend}+sam3` : 'sam3';
          results.push({ shot: p.n, shotEventId: p.shot.id, found: true, score: seed?.score ?? out.score, sourceFrame: seed?.sf ?? start + first, frames: out.boxes.filter(b => b.length === 4).length });
          continue;
        }
      }
      if (!seed) { results.push({ shot: p.n, shotEventId: p.shot.id, found: false }); continue; }
      const key: RegionKey = { sourceFrame: seed.sf, box: [seed.box[0] + (c?.x ?? 0), seed.box[1] + (c?.y ?? 0), seed.box[2], seed.box[3]] };
      progress(`镜头 ${p.n}：${seed.lesson ?? 'full'} 找到「${request.prompt}」(${seed.score.toFixed(2)})，逐帧跟踪…`);
      const edit = await trackRegion(d, projectRoot, { layerId: p.layer.id, regionId: `${request.entityId}-${p.shot.id}`.slice(0, 60), entityId: request.entityId, name: request.name ?? request.prompt, keys: [key] });
      edit.region.backend = `${seed.backend}+${edit.region.backend}`;
      backend = edit.region.backend;
      edits.push(edit);
      results.push({ shot: p.n, shotEventId: p.shot.id, found: true, score: seed.score, sourceFrame: seed.sf, frames: edit.region.boxes.filter(x => x.length === 4).length });
    }
    return { edits, shots: results, backend };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
