import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, realpath, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ActionPlan, GenerationReceipt, MediaReference } from "@cassie/spec";
import { EventError } from "@cassie/harness";

export function runProcess(command: string, args: string[], opts: { stdin?: string; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; let errors = ""; let expired = false; let oversized = false;
    const timer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, opts.timeoutMs ?? 120_000);
    child.stdout.on("data", chunk => { output += chunk; if (output.length > 8_000_000) { oversized = true; child.kill("SIGKILL"); } });
    child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-6000); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (expired || oversized || code !== 0) reject(new EventError("PROCESS_FAILED", `${command}: ${expired ? "timeout" : oversized ? "output too large" : errors || `exit ${code}`}`));
      else resolveResult(output);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.stdin);
  });
}
export async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export async function verifiedMedia(root: string, ref: MediaReference): Promise<string> {
  const base = await realpath(root);
  const path = await realpath(resolve(root, ref.path));
  if (path !== base && !path.startsWith(base + sep)) throw new EventError("MEDIA_PATH", "Media escapes the project directory");
  if (await sha256(path) !== ref.sha256) throw new EventError("MEDIA_HASH", `Media changed: ${ref.path}`);
  return path;
}
export async function probeVideo(file: string) {
  const info = JSON.parse(await runProcess("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate,nb_read_frames,duration:format=duration", "-of", "json", file]));
  const stream = info.streams?.[0];
  if (!stream) throw new EventError("NO_VIDEO", "No video stream");
  const [num, den] = String(stream.avg_frame_rate).split("/").map(Number);
  const frames = Number(stream.nb_read_frames);
  if (!num || !den || !Number.isSafeInteger(frames) || frames < 1) throw new EventError("INVALID_VIDEO", "Video needs a readable frame rate and count");
  // Variable-rate media must be explicitly normalized before it enters the frame-domain contract.
  if (stream.avg_frame_rate !== stream.r_frame_rate) throw new EventError("VARIABLE_FPS", "Normalize variable-rate video before import");
  return { width: Number(stream.width), height: Number(stream.height), frames, frameRate: { num, den }, duration: Number(stream.duration ?? info.format?.duration) };
}
export async function importVideo(root: string, source: string): Promise<{ media: MediaReference; info: Awaited<ReturnType<typeof probeVideo>> }> {
  const info = await probeVideo(source);
  const hash = await sha256(source);
  const path = `media/${hash}.mp4`;
  await mkdir(join(root, "media"), { recursive: true });
  const target = join(root, path);
  if (resolve(source) !== resolve(target)) await copyFile(source, target);
  if (await sha256(target) !== hash) throw new EventError("MEDIA_CHANGED", "Input changed during import");
  return { media: { path, sha256: hash }, info };
}
export async function createReceipt(projectFile: string, plan: ActionPlan, taskId: string, candidate: string, provider: string, reviewNote: string): Promise<GenerationReceipt> {
  const task = plan.tasks.find(t => t.id === taskId);
  if (!task || !provider.trim() || !reviewNote.trim()) throw new EventError("INVALID_RECEIPT", "Task, provider and explicit review note are required");
  await verifiedMedia(dirname(resolve(projectFile)), task.source);
  const { media, info } = await importVideo(dirname(resolve(projectFile)), resolve(candidate));
  if (info.frames !== task.outputFrames || info.frameRate.num / info.frameRate.den !== task.frameRate.num / task.frameRate.den || info.width !== plan.base.editor.settings.width || info.height !== plan.base.editor.settings.height)
    throw new EventError("MEDIA_MISMATCH", "Candidate has wrong frame count, frame rate or dimensions; no project changes were applied");
  return { taskId, assetId: `generated_${media.sha256.slice(0, 16)}_${crypto.randomUUID().slice(0, 8)}`, media, frames: info.frames, width: info.width, height: info.height, frameRate: { ...task.frameRate }, provider, review: { accepted: true, note: reviewNote } };
}
export async function verifyReceiptFiles(projectFile: string, receipts: GenerationReceipt[]): Promise<void> {
  for (const receipt of receipts) {
    const file = await verifiedMedia(dirname(resolve(projectFile)), receipt.media);
    const info = await probeVideo(file);
    if (info.frames !== receipt.frames || info.width !== receipt.width || info.height !== receipt.height || info.frameRate.num / info.frameRate.den !== receipt.frameRate.num / receipt.frameRate.den)
      throw new EventError("RECEIPT_MISMATCH", "Receipt does not match actual media bytes");
  }
}
