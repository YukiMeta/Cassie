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
  return call<{ tools: AgentToolSpec[] }>("/api/tools").then((r) => r.tools);
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
