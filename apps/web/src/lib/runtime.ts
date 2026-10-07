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

export async function renderJob(onProgress: (message: string) => void): Promise<string> {
  const { id } = await call<{ id: string }>("/api/render", {});
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
