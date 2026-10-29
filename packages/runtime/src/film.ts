import { readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { normalizeVideo } from './import';
import type { EventWorkspace } from '@cassie/spec';
import { EventError, validateWorkspace } from '@cassie/harness';
import { importVideo, probeVideo, runProcess } from './media';

interface FilmItem { card?: string; clip?: string; id?: string; dur: number; in?: number; black?: number; visor_from?: number; fade_out?: number }

/**
 * Imports a demo-film description (film.json) as an editable graph: shots stay separate source
 * clips and copy cards stay text, so a product swap edits sources instead of the flattened film.
 * Cover and outro packaging are recorded on the project entity and are not rebuilt here.
 */
export async function importFilmWorkspace(filmFile: string, target: string, progress = (m: string) => {}): Promise<EventWorkspace> {
  return buildFilmWorkspace(JSON.parse(await readFile(filmFile, 'utf8')), filmFile, target, progress);
}

/** A single video becomes a film of its shots; cuts are detected by scene change unless given. */
export async function importVideoAsFilm(video: string, target: string, options: { cuts?: number[]; threshold?: number } = {}, progress = (m: string) => {}): Promise<EventWorkspace> {
  const info = await probeVideo(resolve(video)), rate = info.frameRate.num / info.frameRate.den;
  let cuts = options.cuts;
  if (!cuts) {
    const log = await runProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', resolve(video), '-vf', `scale=320:-2,scdet=threshold=${options.threshold ?? 10},metadata=mode=print:key=lavfi.scd.time:file=-`, '-an', '-f', 'null', '-'], { timeoutMs: 300_000 });
    cuts = [...log.matchAll(/lavfi\.scd\.time=([0-9.]+)/g)].map(m => Math.round(Number(m[1]) * rate)).filter(f => f > 0 && f < info.frames);
  }
  const edges = [0, ...new Set(cuts)].sort((a, b) => a - b).concat(info.frames);
  progress(`检测到 ${edges.length - 1} 个镜头`);
  const sequence = edges.slice(0, -1).map((f, i) => ({ clip: resolve(video), id: `s${i + 1}`, in: f / rate, dur: (edges[i + 1]! - f) / rate }));
  return buildFilmWorkspace({ sequence }, resolve(video), target, progress);
}

async function buildFilmWorkspace(film: { sequence: FilmItem[]; cover?: unknown; outro?: unknown }, filmFile: string, target: string, progress: (m: string) => void): Promise<EventWorkspace> {
  if (!Array.isArray(film.sequence) || !film.sequence.length) throw new EventError('INVALID_FILM', 'film.json needs a sequence');
  const base = dirname(resolve(filmFile)), root = dirname(resolve(target));
  const first = film.sequence.find(s => s.clip), canvas = first ? await probeVideo(resolve(base, first.clip!)) : { width: 1920, height: 1080 };
  const fps = 24, width = canvas.width, height = canvas.height, toUs = (f: number) => Math.round(f * 1e6 / fps), id = crypto.randomUUID();
  const ws: EventWorkspace = { schema: 'cassie/events@1', transactions: [], document: {
    editor: { id, name: `${base.split('/').pop()} / 成片工程`, revision: 0, settings: { fps, width, height, durationUs: 0 }, assets: {}, tracks: [{ id: 'video', kind: 'video', name: '镜头', locked: false, clips: [] }] },
    semantic: { id: crypto.randomUUID(), editorProjectId: id, entities: { film: { id: 'film', name: '成片包装', kind: 'scene', lifecycle: { enterUs: 0, exitUs: 0 }, attributes: { source: filmFile, packaging: JSON.parse(JSON.stringify({ cover: film.cover ?? null, outro: film.outro ?? null })) }, binds: [], locked: true } }, relations: [], constraints: [] },
    frameRate: { num: fps, den: 1 }, media: {}, actions: {}, events: [], scene: { background: '#000000', layers: [] },
  } };
  const d = ws.document;
  let frame = 0;
  for (const [i, item] of film.sequence.entries()) {
    const frames = Math.round((item.black ?? item.dur) * fps);
    if (!Number.isSafeInteger(frames) || frames < 1) throw new EventError('INVALID_FILM', `Item ${i} has no duration`);
    const start = i === 0 ? { frame: 0 } : { eventId: d.events.at(-1)!.id, edge: 'end' as const, offsetFrames: 0 };
    if (item.clip) {
      const clipPath = item.clip, shot = item.id ?? `s${i}`;
      progress(`导入镜头 ${shot}`);
      const { media, info } = await importVideo(root, resolve(base, item.clip)).catch(async error => {
        if (!(error instanceof EventError) || error.code !== 'VARIABLE_FPS') throw error;
        progress(`${shot} 为变帧率，规整为 ${fps}fps 副本（原片不动）`);
        const scratch = join(root, '.cassie-normalize', `${shot}-${crypto.randomUUID().slice(0, 8)}.mp4`);
        await normalizeVideo(resolve(base, clipPath), scratch, fps);
        try { return await importVideo(root, scratch); } finally { await rm(scratch, { force: true }); }
      });
      if (Math.abs(info.frameRate.num / info.frameRate.den - fps) > 1e-6) throw new EventError('FILM_FPS', `${shot} is not ${fps} fps; normalize it first`);
      const inFrames = Math.round((item.in ?? 0) * fps);
      if (info.frames < inFrames + frames) throw new EventError('FILM_RANGE', `${shot} is shorter than its film duration`);
      const assetId = `src-${media.sha256.slice(0, 12)}`, clipId = `clip-${shot}`;
      d.media[assetId] = media;
      if (!d.editor.assets[assetId]) d.editor.assets[assetId] = { id: assetId, kind: 'video', name: item.clip.split('/').pop()!, durationUs: toUs(info.frames), width: info.width, height: info.height };
      d.editor.tracks[0]!.clips.push({ id: clipId, assetId, startUs: toUs(frame), endUs: toUs(frame + frames), sourceInUs: toUs(inFrames), attrs: { eventId: shot } });
      d.semantic.entities[`shot-${shot}`] = { id: `shot-${shot}`, name: `镜头 ${shot}`, kind: 'scene', lifecycle: { enterUs: toUs(frame), exitUs: toUs(frame + frames) }, attributes: { film: item.clip, ...(item.visor_from !== undefined ? { visorFromSec: item.visor_from } : {}), ...(item.fade_out !== undefined ? { fadeOutSec: item.fade_out } : {}) }, binds: [{ targetType: 'clip', targetId: clipId, role: 'primary' }], locked: false };
      d.events.push({ id: shot, entityId: `shot-${shot}`, kind: 'reveal', label: `镜头 ${shot}`, start, durationFrames: frames, clipId });
      d.scene.layers.push({ id: `layer-${shot}`, entityId: `shot-${shot}`, kind: 'video', eventId: shot, assetId, x: 0, y: 0, width, height, color: '#ffffff' });
    } else if (item.card !== undefined) {
      const eventId = `card-${i}`, entityId = `copy-${i}`;
      d.semantic.entities[entityId] = { id: entityId, name: `文案卡 ${i}`, kind: 'text', lifecycle: { enterUs: toUs(frame), exitUs: toUs(frame + frames) }, attributes: { copy: item.card }, binds: [], locked: false };
      d.events.push({ id: eventId, entityId, kind: 'caption', label: `文案 · ${item.card}`, start, durationFrames: frames, text: item.card });
      d.scene.layers.push({ id: `layer-card-${i}`, entityId, kind: 'text', eventId, x: Math.round(width * 0.29), y: Math.round(height * 0.46), width: Math.round(width * 0.42), height: Math.round(height * 0.067), color: '#f5f5f7', text: item.card });
    } else if (item.black !== undefined) {
      d.semantic.entities[`black-${i}`] = { id: `black-${i}`, name: '黑场', kind: 'scene', lifecycle: { enterUs: toUs(frame), exitUs: toUs(frame + frames) }, attributes: {}, binds: [], locked: false };
      d.events.push({ id: `black-${i}`, entityId: `black-${i}`, kind: 'marker', label: '黑场', start, durationFrames: frames });
    } else throw new EventError('INVALID_FILM', `Unknown sequence item ${i}`);
    frame += frames;
  }
  d.editor.settings.durationUs = toUs(frame);
  validateWorkspace(ws);
  return ws;
}
