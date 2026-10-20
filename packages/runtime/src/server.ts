import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { applyAction, planAction, applyDocumentEdit, planDocumentEdit, resolveEvents, rollbackAction, staleSubjects, variantDocument, EventError } from "@cassie/harness";
import type { EventDocument } from "@cassie/spec";
import { importSubjectReference, planSubjectSync, runSubjectSync } from "./subject-sync";
import { doctor } from "./doctor";
import { callAgentTool, clearSync, closeAgentBrowser, markSync, runningSyncs, subjectSyncQuote, toolManifest, type ToolContext } from "./agent-tools";
import { readWorkspace, updateWorkspace } from "./store";
import { compileScene, renderVideo, fontPath } from "./render";
import { extractSubjectMatte, verifyMatteEdit, exportSubjectCutout } from "./matte";
import { runProcess, verifiedMedia } from "./media";
import { existsSync } from "node:fs";
import { detectObjects } from "./detect";
import { trackRegion } from "./track";

export async function serveWorkspace(projectFile: string, port = 4317) {
  const file = resolve(projectFile);
  await readWorkspace(file);
  const token = crypto.randomUUID();
  const jobs = new Map<string, { status: "running" | "complete" | "failed"; message: string; path: string }>();
  const abort = new AbortController();
  let origin = "";
  const toolContext: ToolContext = { file, baseUrl: async () => origin };
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    try {
      if (origin && req.headers.host !== new URL(origin).host) throw new EventError("INVALID_HOST", "Local host only");
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      const path = requestUrl.pathname;
      if (req.method === "GET") {
        if (path === "/api/tools") { send(res, { tools: toolManifest() }); return; }
        if (path === "/api/doctor") { send(res, { checks: await doctor() }); return; }
        if (path === "/") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(await readFile(new URL("../../../apps/client/dist/index.html", import.meta.url))); return; }
        if (/^\/client\/[a-zA-Z0-9_.-]+$/.test(path)) { const name = path.slice(8); res.setHeader("Content-Type", name.endsWith(".css") ? "text/css" : name.endsWith(".js") ? "text/javascript" : "application/octet-stream"); res.end(await readFile(new URL("../../../apps/client/dist/" + name, import.meta.url))); return; }
        if (path === "/api/project") { const workspace = await readWorkspace(file); send(res, { workspace, events: resolveEvents(workspace.document), token }); return; }
        if (path === "/font-400.woff2" || path === "/font-600.woff2") { res.setHeader("Content-Type", "font/woff2"); res.end(await readFile(fontPath(path.includes("400") ? 400 : 600))); return; }
        if (path === "/scene") {
          const d = (await readWorkspace(file)).document, variant = requestUrl.searchParams.get("variant");
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          if (variant) { const vd = variantDocument(d, variant); res.end(compileScene(vd, sceneUrls(d, vd))); return; }
          res.end(compileScene(d, sceneUrls(d, d),requestUrl.searchParams.get("matte")??undefined)); return;
        }
        if (path.startsWith("/media/")) {
          const ref = (await readWorkspace(file)).document.media[decodeURIComponent(path.slice(7))];
          if (!ref) throw new EventError("NOT_FOUND", "Unknown media");
          await serveFile(req, res, await verifiedMedia(dirname(file), ref)); return;
        }
        if (path.startsWith("/poster/")) {
          const ref = (await readWorkspace(file)).document.media[decodeURIComponent(path.slice(8))];
          if (!ref) throw new EventError("NOT_FOUND", "Unknown media");
          const at = Math.max(0, Math.min(600, Number(requestUrl.searchParams.get("t") ?? 1) || 0));
          const out = join(dirname(file), ".cassie-cache", "posters", `${ref.sha256}-${at.toFixed(2)}.jpg`);
          if (!existsSync(out)) {
            await mkdir(dirname(out), { recursive: true });
            await runProcess("ffmpeg", ["-v", "error", "-y", "-ss", String(at), "-i", await verifiedMedia(dirname(file), ref), "-frames:v", "1", "-vf", "scale=480:480:force_original_aspect_ratio=decrease", "-q:v", "4", out], { timeoutMs: 30_000 });
          }
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          await serveFile(req, res, out); return;
        }
        if (path.startsWith("/api/render/")) {
          const job = jobs.get(path.slice(12)); if (!job) throw new EventError("NOT_FOUND", "Unknown render");
          send(res, { status: job.status, message: job.message }); return;
        }
        if (path.startsWith("/output/")) {
          const job = jobs.get(path.slice(8)); if (!job || job.status !== "complete") throw new EventError("NOT_FOUND", "Output not ready");
          res.setHeader("Content-Disposition", `attachment; filename="cassie.${job.path.endsWith('.webm')?'webm':'mp4'}"`); await serveFile(req, res, job.path); return;
        }
      }
      if (req.method !== "POST") { res.writeHead(404).end(); return; }
      if (req.headers["x-cassie-token"] !== token || (req.headers.origin && req.headers.origin !== origin) || req.headers["content-type"] !== "application/json") throw new EventError("FORBIDDEN", "Expected same-origin JSON request with session token");
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 8_000_000) throw new EventError("BODY_LIMIT", "Request exceeds 8 MB"); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (path === "/api/edit") { send(res, await updateWorkspace(file, async ws => { if(body.edit?.kind==="attach-subject-matte")await verifyMatteEdit(ws.document,dirname(file),body.edit);if (ws.document.editor.revision !== body.revision) throw new EventError("STALE_PLAN", "Project changed; refresh before editing"); return applyDocumentEdit(ws, planDocumentEdit(ws.document, body.edit)); })); return; }
      if (path === "/api/plan") { send(res, { plan: planAction((await readWorkspace(file)).document, body) }); return; }
      if (path === "/api/apply") { send(res, await updateWorkspace(file, ws => applyAction(ws, body.plan))); return; }
      if (path === "/api/rollback") { send(res, await updateWorkspace(file, ws => rollbackAction(ws, body.id))); return; }
      if (path === "/api/matte" || path === "/api/cutout") {
        if([...jobs.values()].some(j=>j.status==="running"))throw new EventError("JOB_BUSY","A media job is already running");
        const base=await readWorkspace(file);
        if(base.document.editor.revision!==body.revision||typeof body.eventId!=="string")throw new EventError("STALE_PLAN","Refresh before extracting the subject");
        const id=crypto.randomUUID(),job={status:"running" as "running"|"complete"|"failed",message:"Preparing subject",path:join(dirname(file),"cutouts",`${id}.webm`)};jobs.set(id,job);
        void (async()=>{
          if(path==="/api/matte"){
            const edit=await extractSubjectMatte(base.document,dirname(file),body.eventId,m=>{job.message=m});
            await updateWorkspace(file,async ws=>{if(ws.document.editor.revision!==base.document.editor.revision)throw new EventError("STALE_PLAN","Project changed during segmentation");await verifyMatteEdit(ws.document,dirname(file),edit);return applyDocumentEdit(ws,planDocumentEdit(ws.document,edit))});
          }
          job.message="编码透明人物片段…";
          await exportSubjectCutout((await readWorkspace(file)).document,dirname(file),body.eventId,job.path);
          job.status="complete";job.message="人物抠像完成；原动作保留，等待动作编辑模型。";
        })().catch(e=>{job.status="failed";job.message=e.message});send(res,{id},202);return;
      }
      if (path === "/api/detect") { send(res, await detectObjects((await readWorkspace(file)).document, dirname(file), String(body.layerId), Number(body.frame), Array.isArray(body.queries) ? body.queries.map(String) : undefined)); return; }
      if (path === "/api/region") {
        const base = await readWorkspace(file);
        if (base.document.editor.revision !== body.revision) throw new EventError("STALE_PLAN", "Refresh before selecting an object");
        const label = String(body.label || "object").slice(0, 40), slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "object";
        const box = (body.box as number[]).map(Number) as [number, number, number, number];
        const edit = await trackRegion(base.document, dirname(file), { layerId: String(body.layerId), regionId: `${slug}-${Date.now().toString(36)}`, entityId: String(body.entityId || `obj-${slug}`), name: label, keys: [{ sourceFrame: Number(body.sourceFrame), box }] });
        send(res, await updateWorkspace(file, async ws => { if (ws.document.editor.revision !== base.document.editor.revision) throw new EventError("STALE_PLAN", "Project changed during tracking"); return applyDocumentEdit(ws, planDocumentEdit(ws.document, edit)); })); return;
      }
      if (path === "/api/subject-reference") {
        const base = await readWorkspace(file);
        if (base.document.editor.revision !== body.revision) throw new EventError("STALE_PLAN", "Refresh before changing the subject");
        const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.image ?? ""));
        if (!m) throw new EventError("INVALID_REFERENCE", "Upload a png, jpg or webp reference image");
        const scratch = join(dirname(file), ".cassie-upload", `${crypto.randomUUID()}.${m[1] === "jpeg" ? "jpg" : m[1]}`);
        await mkdir(dirname(scratch), { recursive: true }); await writeFile(scratch, Buffer.from(m[2]!, "base64"));
        try {
          const edit = await importSubjectReference(dirname(file), scratch, String(body.entityId), String(body.prompt ?? ""), String(body.instruction ?? ""), body.name ? String(body.name) : undefined, body.scope && typeof body.scope === "object" ? Object.fromEntries(Object.entries(body.scope).map(([k, v]) => [k, String(v)])) : undefined);
          send(res, await updateWorkspace(file, ws => { if (ws.document.editor.revision !== base.document.editor.revision) throw new EventError("STALE_PLAN", "Project changed; retry"); return applyDocumentEdit(ws, planDocumentEdit(ws.document, edit)); }));
        } finally { await rm(scratch, { force: true }); }
        return;
      }
      if (path === "/api/subject-sync/quote") {
        const d = (await readWorkspace(file)).document;
        send(res, await subjectSyncQuote(d, (Array.isArray(body.variantIds) ? body.variantIds : []).map(String).filter((id: string) => d.variants?.items[id])));
        return;
      }
      if (path === "/api/tools/call") {
        const result = await callAgentTool(toolContext, String(body.name ?? ""), body.args && typeof body.args === "object" ? body.args : {});
        send(res, result);
        return;
      }
      if (path === "/api/subject-sync") {
        if ([...jobs.values()].some(j => j.status === "running")) throw new EventError("JOB_BUSY", "A media job is already running");
        const base = await readWorkspace(file), variantId = String(body.variantId);
        if (process.env.CASSIE_SUBJECT_PROVIDER && (await runningSyncs(file, [variantId])).length) throw new EventError("JOB_BUSY", "这条变体的付费主体同步已在进行，等它完成，不会重复扣费");
        const id = crypto.randomUUID(), job = { status: "running" as "running" | "complete" | "failed", message: "整理同步任务…", path: join(dirname(file), "sync", id) }; jobs.set(id, job);
        const request = await planSubjectSync(base.document, dirname(file), variantId, job.path);
        const providerFile = process.env.CASSIE_SUBJECT_PROVIDER;
        if (!providerFile) { job.status = "complete"; job.message = `已生成同步任务，尚未配置主体同步服务（CASSIE_SUBJECT_PROVIDER）：${job.path}`; send(res, { id, request, provider: null }, 202); return; }
        await markSync(file, variantId);
        void (async () => {
          job.message = "SAM 3 分割并按参考图替换主体…";
          const edit = await runSubjectSync(base.document, dirname(file), request, JSON.parse(await readFile(providerFile, "utf8")));
          await updateWorkspace(file, ws => applyDocumentEdit(ws, planDocumentEdit(ws.document, edit)));
          job.status = "complete"; job.message = "主体已同步，新成片待审";
        })().catch(e => { job.status = "failed"; job.message = e.message; }).finally(() => clearSync(file, variantId));
        send(res, { id, request, provider: providerFile }, 202); return;
      }
      if (path === "/api/render") {
        if ([...jobs.values()].some(j => j.status === "running")) throw new EventError("RENDER_BUSY", "A render is already running");
        const master = (await readWorkspace(file)).document;
        const d = typeof body.variantId === "string" ? variantDocument(master, body.variantId) : master;
        const id = crypto.randomUUID(); const job = { status: "running" as "running" | "complete" | "failed", message: "Preparing", path: join(dirname(file), "renders", `${id}.mp4`) }; jobs.set(id, job);
        void renderVideo(d, dirname(file), job.path, message => { job.message = message; }, abort.signal).then(() => { job.status = "complete"; job.message = `Revision ${d.editor.revision}`; }).catch(e => { job.status = "failed"; job.message = String(e.message); });
        send(res, { id }, 202); return;
      }
      res.writeHead(404).end();
    } catch (e) { const error = e as Error; send(res, { error: e instanceof EventError ? e.code : "REQUEST_FAILED", message: error.message }, e instanceof EventError && e.code === "FORBIDDEN" ? 403 : 400); }
  });
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(port, "127.0.0.1", yes); });
  const address = server.address(); origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : port}`;
  return { server, url: origin, close: () => { abort.abort(); void closeAgentBrowser(); server.closeAllConnections(); server.close(); } };
}
/** Derived documents rename assets; serve each through the master media entry with the same bytes. */
function sceneUrls(master: EventDocument, d: EventDocument): Record<string, string> {
  return Object.fromEntries(Object.entries(d.media).map(([id, ref]) => {
    const source = master.media[id]?.sha256 === ref.sha256 ? id : Object.keys(master.media).find(k => master.media[k]!.sha256 === ref.sha256 && master.editor.assets[k]?.kind !== "image")!;
    return [id, `/media/${encodeURIComponent(source)}`];
  }));
}
function send(res: ServerResponse, data: unknown, code = 200) { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(data)); }
async function serveFile(req: IncomingMessage, res: ServerResponse, file: string) {
  const bytes = await readFile(file);
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  const type: Record<string, string> = { webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
  res.setHeader("Content-Type", type[file.split(".").pop()!.toLowerCase()] ?? "video/mp4");
  res.setHeader("Accept-Ranges", "bytes");
  if (req.headers.range && !range) { res.writeHead(416, { "Content-Range": `bytes */${bytes.length}` }).end(); return; }
  if (range) {
    const start = Number(range[1]); const end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    if (start > end || start >= bytes.length) { res.writeHead(416, { "Content-Range": `bytes */${bytes.length}` }).end(); return; }
    res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${bytes.length}`, "Content-Length": end - start + 1 }); res.end(bytes.subarray(start, end + 1));
  } else { res.setHeader("Content-Length", bytes.length); res.end(bytes); }
}
