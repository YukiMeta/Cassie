import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Project } from "../../../packages/editor-core/src/project";
import { buildComposition } from "./composition";

const require = createRequire(import.meta.url);
process.env.HYPERFRAMES_FFMPEG_PATH ||= require("ffmpeg-static") as string;
process.env.HYPERFRAMES_FFPROBE_PATH ||= (require("@ffprobe-installer/ffprobe") as { path: string }).path;

export interface RenderInput {
  project: Project;
  /** assetId → 文件内容 */
  assets: Map<string, Uint8Array>;
}

export interface RenderProgress {
  progress: number;
  message: string;
}

/** 编译 composition 到临时目录并渲染成 MP4，返回输出路径（调用方负责清理 workDir）。 */
export async function renderProject(
  input: RenderInput,
  onProgress: (p: RenderProgress) => void,
  signal?: AbortSignal,
): Promise<{ outputPath: string; workDir: string }> {
  const { createRenderJob, executeRenderJob } = await import("@hyperframes/producer");
  const composition = buildComposition(input.project);
  const missing = composition.assets.filter((a) => !input.assets.has(a.assetId));
  if (missing.length) throw new Error(`缺少素材文件：${missing.map((m) => m.assetId).join(", ")}`);

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "cassie-render-"));
  const projectDir = path.join(workDir, "project");
  await fs.mkdir(path.join(projectDir, "assets"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "index.html"), composition.html);
  for (const a of composition.assets) {
    await fs.writeFile(path.join(projectDir, a.file), input.assets.get(a.assetId)!);
  }

  const outputPath = path.join(workDir, "output.mp4");
  const job = createRenderJob({ fps: input.project.settings.fps, quality: "standard", format: "mp4" });
  await executeRenderJob(
    job,
    projectDir,
    outputPath,
    (j: { progress: number }, message: string) => onProgress({ progress: Math.round(j.progress), message }),
    signal,
  );
  return { outputPath, workDir };
}
