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
    const sam3 = await sam3Service();
    if (sam3) {
      const edits: Extract<DocumentEdit, { kind: 'track-region' }>[] = [], results: ConceptShotResult[] = [];
      for (const p of plan) {
        progress(`SAM 3 跟踪「${request.prompt}」：镜头 ${p.n}`);
        const source = await verifiedMedia(projectRoot, d.media[p.clip.assetId!]!);
        const start = Math.round(p.clip.sourceInUs * rate / 1e6), frames = Math.round((p.clip.endUs - p.clip.startUs) * rate / 1e6);
        const out = await sam3Shot(sam3, source, request.prompt, start, frames, rate, dir);
        const first = out?.boxes.findIndex(b => b.length === 4) ?? -1;
        if (!out || first < 0) { results.push({ shot: p.n, shotEventId: p.shot.id, found: false }); continue; }
        const regionId = `${request.entityId}-${p.shot.id}`.slice(0, 60), prior = d.regions?.[regionId];
        edits.push({ kind: 'track-region', name: request.name ?? request.prompt, region: {
          id: regionId, entityId: request.entityId, eventId: prior?.eventId ?? `region-${regionId}`, layerId: p.layer.id,
          sourceAssetId: p.clip.assetId!, sourceSha256: d.media[p.clip.assetId!]!.sha256, sourceStartFrame: start,
          keys: [{ sourceFrame: start + first, box: out.boxes[first]! as [number, number, number, number] }],
          boxes: out.boxes, confidence: out.confidence, backend: 'sam3', look: prior?.look ?? { color: '#2f7cf6', tint: 0.85, feather: 6 },
        } });
        results.push({ shot: p.n, shotEventId: p.shot.id, found: true, score: out.score, sourceFrame: start + first, frames: out.boxes.filter(b => b.length === 4).length });
      }
      return { edits, shots: results, backend: 'sam3' };
    }
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
