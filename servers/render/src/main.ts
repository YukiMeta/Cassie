import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { Project } from "../../../packages/editor-core/src/project";
import { renderProject } from "./render";

/**
 * Cassie 渲染服务。
 * POST /render       multipart：project（JSON）+ asset:<assetId>（文件）→ { jobId }
 * GET  /jobs/:id      → { status, progress, message, error? }
 * GET  /jobs/:id/output → video/mp4
 * GET  /health        → { ok: true, engine: "cassie-render" }
 * 同一时间只渲染一个任务，其余排队。
 */
interface Job {
  id: string;
  status: "queued" | "rendering" | "done" | "failed";
  progress: number;
  message: string;
  error?: string;
  outputPath?: string;
  workDir?: string;
  finishedAt?: number;
}

const PORT = Number(process.env.PORT ?? 8797);
const TOKEN = process.env.CASSIE_RENDER_TOKEN ?? "";
const KEEP_MS = 30 * 60_000;
const jobs = new Map<string, Job>();
let queue: Promise<void> = Promise.resolve();

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readForm(req: IncomingMessage): Promise<FormData> {
  const request = new Request("http://local/render", {
    method: "POST",
    headers: req.headers as Record<string, string>,
    body: Readable.toWeb(req) as ReadableStream,
    duplex: "half",
  } as RequestInit);
  return request.formData();
}

async function handleRender(req: IncomingMessage, res: ServerResponse) {
  const form = await readForm(req);
  const raw = form.get("project");
  if (typeof raw !== "string") return send(res, 400, { error: "缺少 project 字段" });
  const project = JSON.parse(raw) as Project;
  const assets = new Map<string, Uint8Array>();
  for (const [key, value] of form.entries()) {
    if (key.startsWith("asset:") && typeof value !== "string") {
      assets.set(key.slice(6), new Uint8Array(await value.arrayBuffer()));
    }
  }
  const job: Job = { id: randomUUID(), status: "queued", progress: 0, message: "排队中" };
  jobs.set(job.id, job);
  queue = queue.then(async () => {
    job.status = "rendering";
    job.message = "准备渲染";
    try {
      const out = await renderProject({ project, assets }, (p) => {
        job.progress = p.progress;
        job.message = p.message;
      });
      Object.assign(job, { status: "done", progress: 100, message: "完成", ...out });
    } catch (err) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      job.finishedAt = Date.now();
    }
  });
  send(res, 202, { jobId: job.id });
}

async function cleanup() {
  const now = Date.now();
  for (const job of jobs.values()) {
    if (job.finishedAt && now - job.finishedAt > KEEP_MS) {
      if (job.workDir) await fs.rm(job.workDir, { recursive: true, force: true }).catch(() => {});
      jobs.delete(job.id);
    }
  }
}
setInterval(() => void cleanup(), 60_000).unref();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://local");
    if (url.pathname === "/health") return send(res, 200, { ok: true, engine: "cassie-render" });
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: "未授权" });

    if (req.method === "POST" && url.pathname === "/render") return await handleRender(req, res);

    const m = /^\/jobs\/([\w-]+)(\/output)?$/.exec(url.pathname);
    if (req.method === "GET" && m) {
      const job = jobs.get(m[1]!);
      if (!job) return send(res, 404, { error: "任务不存在" });
      if (!m[2]) {
        const { id, status, progress, message, error } = job;
        return send(res, 200, { id, status, progress, message, error });
      }
      if (job.status !== "done" || !job.outputPath) return send(res, 409, { error: "任务未完成" });
      const data = await fs.readFile(job.outputPath);
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": data.length });
      return res.end(data);
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, () => console.log(`Cassie render server · http://localhost:${PORT}`));
