import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DocumentEdit, EventDocument, RegionKey } from '@cassie/spec';
import { findClip } from '@cassie/editor-core';
import { EventError, resolveEvents, shots } from '@cassie/harness';
import { runProcess, verifiedMedia } from './media';
import { trackRegion } from './track';

/**
 * Finds a subject by name (a concept prompt like "phone") and tracks it through every shot it appears in,
 * so selectors such as `entity:phone` have per-frame boxes to resolve against.
 *
 * The detector is a separate process speaking one JSON protocol (see tools/detect/owlv2.py), so a SAM 3
 * service can replace the bundled one through CASSIE_DETECTOR without changing Cassie.
 */
export interface Detector { name: string; command: string; args: string[] }
export interface ConceptRequest {
  prompt: string;
  entityId: string;
  name?: string;
  /** 1-based shot numbers; omit for every shot. */
  shots?: number[];
  threshold?: number;
}
export interface ConceptShotResult { shot: number; shotEventId: string; found: boolean; score?: number; sourceFrame?: number; frames?: number }

const repo = fileURLToPath(new URL('../../../', import.meta.url));

export async function detector(): Promise<Detector> {
  if (process.env.CASSIE_DETECTOR) return JSON.parse(await readFile(process.env.CASSIE_DETECTOR, 'utf8'));
  const python = process.env.CASSIE_DETECT_PYTHON ?? [join(repo, '.cassie-cache/detect-venv/bin/python')].find(existsSync);
  if (!python) throw new EventError('DETECTOR', 'No concept detector. Set CASSIE_DETECTOR to a detector config, or create .cassie-cache/detect-venv with transformers.');
  return { name: 'owlv2', command: python, args: [join(repo, 'tools/detect/owlv2.py')] };
}

type Detection = { box: [number, number, number, number]; score: number; label?: string };

async function detect(det: Detector, prompt: string, frames: string[], threshold: number, dir: string): Promise<{ backend: string; detections: Detection[][] }> {
  const request = join(dir, 'detect.json');
  await writeFile(request, JSON.stringify({ prompt, frames, threshold }));
  return JSON.parse(await runProcess(det.command, [...det.args, request], { timeoutMs: 600_000 }));
}

const SAMPLES = [0.5, 0.25, 0.75];

/** One undoable track-region edit per shot where the concept was found; shots without it are reported, not guessed. */
export async function trackConcept(d: EventDocument, projectRoot: string, request: ConceptRequest, progress = (_message: string) => {}): Promise<{ edits: Extract<DocumentEdit, { kind: 'track-region' }>[]; shots: ConceptShotResult[]; backend: string }> {
  if (!/^[a-z0-9-]{1,40}$/.test(request.entityId)) throw new EventError('INVALID_ENTITY', 'Entity id must be lowercase letters, digits and dashes');
  const existing = d.semantic.entities[request.entityId];
  if (existing && (existing.kind !== 'subject' || !existing.attributes.regions)) throw new EventError('INVALID_ENTITY', `${request.entityId} already names something that is not a tracked subject`);
  const all = shots(d, resolveEvents(d)), rate = d.frameRate.num / d.frameRate.den;
  const wanted = request.shots?.length ? request.shots : all.map((_, i) => i + 1);
  const det = await detector(), dir = await mkdtemp(join(tmpdir(), 'cassie-concept-'));
  try {
    const plan = wanted.map(n => {
      const shot = all[n - 1];
      if (!shot) throw new EventError('INVALID_SELECTOR', `No shot ${n}; the cut has ${all.length}`);
      const layer = d.scene.layers.find(l => l.eventId === shot.id && l.kind === 'video')!;
      const clip = findClip(d.editor, d.events.find(e => e.id === shot.id)!.clipId!)!.clip;
      const start = Math.round(clip.sourceInUs * rate / 1e6), length = Math.round((clip.endUs - clip.startUs) * rate / 1e6);
      return { n, shot, layer, clip, samples: [...new Set(SAMPLES.map(p => start + Math.min(length - 1, Math.floor(length * p))))] };
    });
    progress(`抽帧识别「${request.prompt}」：${plan.length} 个镜头`);
    const frames: string[] = [];
    for (const p of plan) {
      const source = await verifiedMedia(projectRoot, d.media[p.clip.assetId!]!), c = p.layer.crop;
      for (const sf of p.samples) {
        const out = join(dir, `${p.n}-${sf}.png`);
        await runProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-vf', `select=eq(n\\,${sf})${c ? `,crop=${c.width}:${c.height}:${c.x}:${c.y}` : ''}`, '-frames:v', '1', out], { timeoutMs: 120_000 });
        frames.push(out);
      }
    }
    const found = await detect(det, request.prompt, frames, request.threshold ?? 0.2, dir);
    const edits: Extract<DocumentEdit, { kind: 'track-region' }>[] = [], results: ConceptShotResult[] = [];
    let i = 0;
    for (const p of plan) {
      const hits = p.samples.map(sf => ({ sf, best: found.detections[i++]?.[0] })).filter((h): h is { sf: number; best: Detection } => !!h.best);
      const top = hits.sort((a, b) => b.best.score - a.best.score)[0];
      if (!top) { results.push({ shot: p.n, shotEventId: p.shot.id, found: false }); continue; }
      const c = p.layer.crop, b = top.best.box;
      const key: RegionKey = { sourceFrame: top.sf, box: [b[0] + (c?.x ?? 0), b[1] + (c?.y ?? 0), b[2], b[3]] };
      progress(`镜头 ${p.n}：找到「${request.prompt}」(${top.best.score.toFixed(2)})，逐帧跟踪…`);
      const edit = await trackRegion(d, projectRoot, { layerId: p.layer.id, regionId: `${request.entityId}-${p.shot.id}`.slice(0, 60), entityId: request.entityId, name: request.name ?? request.prompt, keys: [key] });
      edit.region.backend = `${found.backend}+${edit.region.backend}`;
      edits.push(edit);
      results.push({ shot: p.n, shotEventId: p.shot.id, found: true, score: top.best.score, sourceFrame: top.sf, frames: edit.region.boxes.filter(x => x.length === 4).length });
    }
    return { edits, shots: results, backend: found.backend };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
