import type { DocumentEdit, EventWorkspace, ResolvedEvent } from "@cassie/spec";

/**
 * Cassie 运行时客户端：工程文件、编辑事务、识别、跟踪、渲染都在本机运行时完成。
 * 开发时由 vite 把 /rt/* 代理到运行时（默认 http://127.0.0.1:4320）。
 */
const BASE = "/rt";
let token = "";

export interface RuntimeProject {
  workspace: EventWorkspace;
  events: ResolvedEvent[];
}

export interface DetectedObject {
  label: string;
  box: [number, number, number, number];
  score: number;
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(BASE + path, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Cassie-Token": token },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || `运行时 ${response.status}`);
  return data as T;
}

export async function runtimeAvailable(): Promise<boolean> {
  try {
    const r = await fetch(BASE + "/api/project", { method: "GET" });
    return r.ok && (r.headers.get("content-type") ?? "").includes("json");
  } catch {
    return false;
  }
}

export async function fetchProject(): Promise<RuntimeProject> {
  const data = await call<RuntimeProject & { token: string }>("/api/project");
  token = data.token;
  return { workspace: data.workspace, events: data.events };
}

export function applyEdit(revision: number, edit: DocumentEdit) {
  return call<EventWorkspace>("/api/edit", { revision, edit });
}

export function rollback(id: string) {
  return call<EventWorkspace>("/api/rollback", { id });
}

export function detectObjects(layerId: string, frame: number, queries?: string[]) {
  return call<{ layerId: string; sourceFrame: number; objects: DetectedObject[] }>("/api/detect", { layerId, frame, queries });
}

export function claimRegion(revision: number, layerId: string, sourceFrame: number, box: number[], label: string, entityId?: string) {
  return call<EventWorkspace>("/api/region", { revision, layerId, sourceFrame, box, label, ...(entityId ? { entityId } : {}) });
}

export function uploadSubjectReference(revision: number, body: { entityId: string; name?: string; scope?: Record<string, string>; prompt: string; instruction: string; image: string }) {
  return call<EventWorkspace>("/api/subject-reference", { revision, ...body });
}

export interface AgentToolSpec {
  name: string;
  description: string;
  inputSchema: unknown;
  paid?: boolean;
}
export interface AgentToolResult {
  text: string;
  image?: { data: string; mimeType: string };
  isError?: boolean;
}

export function listAgentTools() {
  return call<{ tools: AgentToolSpec[] }>("/api/tools").then((r) => r.tools.filter(t => !["list_variants", "locate_variant", "subject_sync_quote", "subject_sync"].includes(t.name)));
}

export function callAgentTool(name: string, args: Record<string, unknown>) {
  return call<AgentToolResult>("/api/tools/call", { name, args });
}

export interface SyncQuote {
  provider: string | null;
  items: { variantId: string; subjects: string[]; seconds: number }[];
  seconds: number;
  cost: { amount: number; unit: string } | null;
}

/** What a subject sync over these variants would run and cost, before anything is spent. */
export function subjectSyncQuote(variantIds: string[]) {
  return call<SyncQuote>("/api/subject-sync/quote", { variantIds });
}

/** Starts a SAM 3 subject sync for one variant; without a configured provider it only writes the task. */
export async function subjectSync(variantId: string, onProgress: (message: string) => void): Promise<string> {
  const { id, provider } = await call<{ id: string; provider: string | null }>("/api/subject-sync", { variantId });
  for (;;) {
    const job = await call<{ status: string; message: string }>(`/api/render/${id}`);
    onProgress(job.message);
    if (job.status === "failed") throw new Error(job.message);
    if (job.status === "complete" || !provider) return job.message;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Re-locates master-tracked subjects in one variant take (free: lessons from the master, no provider). */
export async function variantLocate(variantId: string, onProgress: (message: string) => void): Promise<string> {
  const { id } = await call<{ id: string }>("/api/variant-locate", { variantId });
  for (;;) {
    await new Promise((r) => setTimeout(r, 800));
    const job = await call<{ status: string; message: string }>(`/api/render/${id}`);
    onProgress(job.message);
    if (job.status === "failed") throw new Error(job.message);
    if (job.status === "complete") return job.message;
  }
}

export async function renderJob(onProgress: (message: string) => void, variantId?: string): Promise<string> {
  const { id } = await call<{ id: string }>("/api/render", variantId ? { variantId } : {});
  for (;;) {
    await new Promise((r) => setTimeout(r, 800));
    const job = await call<{ status: string; message: string }>(`/api/render/${id}`);
    onProgress(job.message);
    if (job.status === "failed") throw new Error(job.message);
    if (job.status === "complete") return `${BASE}/output/${id}`;
  }
}

export const sceneUrl = (revision: number) => `/scene?revision=${revision}`;
export const mediaUrl = (assetId: string) => `/media/${encodeURIComponent(assetId)}`;
export const posterUrl = (assetId: string, seconds = 1) => `/poster/${encodeURIComponent(assetId)}?t=${seconds.toFixed(2)}`;

export interface DoctorCheck { id: string; label: string; ok: boolean; needed: boolean; detail: string; fix?: string; unlocks: string }
export function runtimeDoctor() {
  return call<{ checks: DoctorCheck[] }>("/api/doctor");
}

// Source-grounded understanding does not create an editing transaction.
export function fetchAnalysis(assetId: string) {
  return call<{ analysis: import('@cassie/spec').VideoAnalysis | null }>(`/api/analysis?assetId=${encodeURIComponent(assetId)}`);
}
export async function analyzeSource(assetId: string, cfg: import('./model-client').LlmConfig, progress: (message: string) => void) {
  const { id } = await call<{ id: string }>('/api/analysis', { assetId, cfg });
  return analysisJob<import('@cassie/spec').VideoAnalysis>(id, progress);
}
export async function groundSource(assetId: string, analysisId: string, query: string, cfg: import('./model-client').LlmConfig, progress: (message: string) => void) {
  const { id } = await call<{ id: string }>('/api/analysis/ground', { assetId, analysisId, query, cfg });
  return analysisJob<import('@cassie/spec').SemanticGrounding>(id, progress);
}
async function analysisJob<T>(id: string, progress: (message:string)=>void): Promise<T> {
  for (;;) {
    const job = await call<{ status: string; message: string; result?: T }>(`/api/render/${id}`);
    progress(job.message);
    if (job.status === 'failed') throw new Error(job.message);
    if (job.status === 'complete') {
      if (!job.result) throw new Error('分析完成但结果缺失');
      return job.result;
    }
    await new Promise(resolve => setTimeout(resolve, 800));
  }
}
export const evidenceFrameUrl = (assetId: string, frame: number) => `/rt/api/analysis/frame?assetId=${encodeURIComponent(assetId)}&frame=${frame}`;

/** Registers source media as an undoable library import, without changing the authored timeline. */
export async function importAnalysisVideo(file: File): Promise<{ assetId: string }> {
  if (file.size > 100_000_000) throw new Error('视频不能超过 100 MB');
  const response = await fetch(BASE+'/api/analysis/import', { method:'POST', headers:{'Content-Type':'application/octet-stream','X-Cassie-Token':token,'X-Cassie-Filename':encodeURIComponent(file.name)}, body:file });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '视频导入失败');
  return data;
}
