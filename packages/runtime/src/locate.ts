import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventError } from "@cassie/harness";
import { runProcess } from "./media";

/**
 * Locate is the step before SAM / the native tracker: find one box for a named subject in a still.
 * The tracker then follows that box. A locator can miss; the harness retries with stored lessons
 * (zoom, visible part, occlusion) without changing any model weights — the Harness² pattern.
 */
export type Box = [number, number, number, number];
export type LessonId = "full" | "zoom_in_2x" | "visible_part" | "occluded";
export interface LocateHit {
  box: Box;
  score: number;
  present: boolean;
  lesson: LessonId;
  backend: string;
}
export interface Locator {
  name: string;
  ask(image: string, prompt: string): Promise<{ box: Box; score: number; present: boolean } | null>;
}

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const ORDER: LessonId[] = ["full", "zoom_in_2x", "visible_part", "occluded"];

const promptFor = (prompt: string, lesson: LessonId) =>
  lesson === "visible_part" ? `${prompt}, or the visible part of it` :
  lesson === "occluded" ? `${prompt}, including if partly hidden` : prompt;

/** Map a box found inside a centre 2× crop back onto the original frame. */
export function unzoom2x(box: Box, width: number, height: number): Box {
  const x0 = Math.round(width / 4), y0 = Math.round(height / 4);
  return [box[0] + x0, box[1] + y0, box[2], box[3]];
}

export async function imageSize(file: string): Promise<{ width: number; height: number }> {
  const t = await runProcess("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { timeoutMs: 15_000 });
  const [width, height] = t.trim().split(",").map(Number);
  if (!width || !height) throw new EventError("LOCATE", `Cannot read size of ${file}`);
  return { width, height };
}

async function cropCenter2x(image: string, dest: string) {
  const { width, height } = await imageSize(image);
  const w = Math.max(2, Math.round(width / 2)), h = Math.max(2, Math.round(height / 2));
  await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", image, "-vf", `crop=${w}:${h}:${Math.round(width / 4)}:${Math.round(height / 4)}`, dest], { timeoutMs: 30_000 });
  return { width, height };
}

export async function applyLesson(locator: Locator, image: string, prompt: string, lesson: LessonId, scratch: string): Promise<LocateHit | null> {
  let view = image, size: { width: number; height: number } | null = null;
  if (lesson === "zoom_in_2x") {
    view = join(scratch, `zoom-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
    try { size = await cropCenter2x(image, view); } catch { return null; }
  }
  const raw = await locator.ask(view, promptFor(prompt, lesson));
  if (!raw?.present) return null;
  const box = size ? unzoom2x(raw.box, size.width, size.height) : raw.box;
  return { box, score: raw.score, present: true, lesson, backend: locator.name };
}

/**
 * Propose–Probe–Compose on one frame. Known lessons go first; remaining views are tried only if
 * nothing clears `threshold`. The winning lesson is what later shots and variant rematches reuse.
 */
export async function locateOnFrame(
  locator: Locator, image: string, prompt: string, scratch: string,
  known: LessonId[] = [], threshold = 0.35,
): Promise<LocateHit | null> {
  const tried = new Set<LessonId>();
  let best: LocateHit | null = null;
  for (const lesson of [...known.filter(l => ORDER.includes(l)), ...ORDER]) {
    if (tried.has(lesson)) continue;
    tried.add(lesson);
    const hit = await applyLesson(locator, image, prompt, lesson, scratch);
    if (hit && hit.score >= (best?.score ?? 0)) best = hit;
    if (best && best.score >= threshold && (known.includes(best.lesson) || tried.size >= 2)) break;
  }
  return best && best.score >= threshold ? best : null;
}

export function lessonsFile(projectFile: string) {
  return join(dirname(projectFile), ".cassie-cache", "locate-lessons.json");
}

export async function loadLessons(projectFile: string, entityId: string): Promise<LessonId[]> {
  const empty: Record<string, { lessons: LessonId[] }> = {};
  const all = await readFile(lessonsFile(projectFile), "utf8").then(t => JSON.parse(t) as Record<string, { lessons: LessonId[] }>, () => empty);
  return all[entityId]?.lessons ?? [];
}

export async function rememberLesson(projectFile: string, entityId: string, prompt: string, lesson: LessonId) {
  const file = lessonsFile(projectFile);
  await mkdir(dirname(file), { recursive: true });
  const empty: Record<string, { prompt: string; lessons: LessonId[] }> = {};
  const all = await readFile(file, "utf8").then(t => JSON.parse(t) as Record<string, { prompt: string; lessons: LessonId[] }>, () => empty);
  const prev = all[entityId]?.lessons ?? [];
  all[entityId] = { prompt, lessons: [lesson, ...prev.filter(l => l !== lesson)].slice(0, 4) };
  await writeFile(file, JSON.stringify(all, null, 2));
}

export function jevKey() {
  return process.env.CASSIE_JEV_KEY || process.env.TYPESAFE_API_KEY || "";
}

export async function jevLocator(): Promise<Locator | null> {
  const key = jevKey();
  if (!key) return null;
  const url = (process.env.CASSIE_JEV_URL ?? "https://api.typesafe.ai/v1/systemone").replace(/\/$/, "");
  const model = process.env.CASSIE_JEV_MODEL ?? "jev-1.14.0";
  return {
    name: `jev/${model}`,
    async ask(image, prompt) {
      const data = (await readFile(image)).toString("base64");
      const r = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "TypeSafe-Danger-Zone-Images": "true" },
        body: JSON.stringify({
          model,
          state: { photo: "frame" },
          assets: { frame: { type: "image", format: image.endsWith(".png") ? "png" : "jpeg", data_base64: data } },
          questions: {
            present: { type: "noul", instructions: `Is ${prompt} visible in \`photo\`?` },
            where: { type: "box", instructions: `the ${prompt} in \`photo\`` },
          },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) throw new EventError("LOCATE", `Jev ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const body = await r.json() as { answers?: { present?: { noul?: boolean; confidence?: number }; where?: { box?: { top: number; bottom: number; left: number; right: number }; confidence?: number } } };
      const present = body.answers?.present?.noul === true;
      const edges = body.answers?.where?.box;
      if (!present || !edges) return { box: [0, 0, 0, 0], score: body.answers?.present?.confidence ?? 0, present: false };
      const { width, height } = await imageSize(image);
      const box: Box = [
        Math.round(edges.left * width), Math.round(edges.top * height),
        Math.max(1, Math.round((edges.right - edges.left) * width)), Math.max(1, Math.round((edges.bottom - edges.top) * height)),
      ];
      return { box, score: body.answers?.where?.confidence ?? body.answers?.present?.confidence ?? 0, present: true };
    },
  };
}

export async function owlLocator(): Promise<Locator | null> {
  const python = process.env.CASSIE_DETECT_PYTHON ?? [join(repo, ".cassie-cache/detect-venv/bin/python")].find(existsSync);
  const script = join(repo, "tools/detect/owlv2.py");
  if (!python || !existsSync(script)) return null;
  return {
    name: "owlv2",
    async ask(image, prompt) {
      const request = image + ".owl.json";
      await writeFile(request, JSON.stringify({ prompt, frames: [image], threshold: 0.15 }));
      const out = JSON.parse(await runProcess(python, [script, request], { timeoutMs: 180_000 })) as { detections: { box: Box; score: number }[][] };
      const best = out.detections[0]?.[0];
      return best ? { box: best.box, score: best.score, present: true } : { box: [0, 0, 0, 0], score: 0, present: false };
    },
  };
}

export async function defaultLocator(): Promise<Locator | null> {
  return (await jevLocator()) ?? (await owlLocator());
}
