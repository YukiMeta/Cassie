import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type { Project } from "../../../packages/editor-core/src/project";

/** 端到端冒烟：生成测试素材 → POST /render → 轮询 → 下载 MP4 → 抽帧。需先启动 npm start。 */
const require = createRequire(import.meta.url);
const ffmpeg = require("ffmpeg-static") as string;
const base = process.env.RENDER_URL ?? "http://localhost:8797";
// 经 Cassie 前端 dev 代理测试时：RENDER_URL=http://127.0.0.1:5199/api/render RENDER_UPSTREAM=http://localhost:8797
const headers: Record<string, string> = process.env.RENDER_UPSTREAM ? { "X-Render-Base": process.env.RENDER_UPSTREAM } : {};
const get = (p: string) => fetch(`${base}${p}`, { headers });
const dir = path.resolve("smoke-out");
fs.mkdirSync(dir, { recursive: true });

const gen = (args: string[]) => execFileSync(ffmpeg, ["-y", "-loglevel", "error", ...args]);
gen(["-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=6", "-pix_fmt", "yuv420p", path.join(dir, "bg.mp4")]);
gen(["-f", "lavfi", "-i", "color=c=0x7c3aed:s=640x360:r=30:d=6", "-pix_fmt", "yuv420p", path.join(dir, "overlay.mp4")]);
gen(["-f", "lavfi", "-i", "sine=f=440:d=6", path.join(dir, "tone.mp3")]);

const project: Project = {
  id: "smoke", name: "smoke", revision: 1,
  settings: { fps: 30, width: 640, height: 360, durationUs: 4_000_000 },
  assets: {
    bg: { id: "bg", kind: "video", name: "bg.mp4", durationUs: 6_000_000 },
    ov: { id: "ov", kind: "video", name: "overlay.mp4", durationUs: 6_000_000 },
    tone: { id: "tone", kind: "audio", name: "tone.mp3", durationUs: 6_000_000 },
  },
  tracks: [
    { id: "v", kind: "video", name: "画面", locked: false, clips: [
      { id: "c_bg", assetId: "bg", startUs: 0, endUs: 4_000_000, sourceInUs: 1_000_000, attrs: {} },
      { id: "c_ov", assetId: "ov", startUs: 1_000_000, endUs: 3_000_000, sourceInUs: 0, attrs: { x: 0.5, y: 0.5, opacity: 0.7 } },
    ] },
    { id: "t", kind: "text", name: "文字", locked: false, clips: [
      { id: "c_title", assetId: null, startUs: 2_000_000, endUs: 4_000_000, sourceInUs: 0, attrs: { text: "Cassie 渲染", x: 0.05, y: 0.08, fontSize: 96, color: "#facc15" } },
    ] },
    { id: "a", kind: "audio", name: "音乐", locked: false, clips: [
      { id: "c_tone", assetId: "tone", startUs: 0, endUs: 4_000_000, sourceInUs: 0, attrs: {} },
    ] },
  ],
};

const form = new FormData();
form.append("project", JSON.stringify(project));
for (const [id, file] of [["bg", "bg.mp4"], ["ov", "overlay.mp4"], ["tone", "tone.mp3"]] as const) {
  form.append(`asset:${id}`, new Blob([fs.readFileSync(path.join(dir, file))]), file);
}
const { jobId } = (await (await fetch(`${base}/render`, { method: "POST", body: form, headers })).json()) as { jobId: string };
console.log("job", jobId);
for (;;) {
  const s = (await (await get(`/jobs/${jobId}`)).json()) as { status: string; progress: number; message: string; error?: string };
  console.log(s.status, s.progress, s.message);
  if (s.status === "failed") throw new Error(s.error);
  if (s.status === "done") break;
  await new Promise((r) => setTimeout(r, 1000));
}
const out = path.join(dir, "result.mp4");
fs.writeFileSync(out, Buffer.from(await (await get(`/jobs/${jobId}/output`)).arrayBuffer()));
for (const t of ["0.5", "2.5"]) gen(["-ss", t, "-i", out, "-frames:v", "1", path.join(dir, `frame_${t}.png`)]);
console.log("ok", out);
