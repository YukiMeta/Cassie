import { buildExportPlan, usedAssets } from "@cassie/editor-core";
import type { EditorAdapter } from "@cassie/editor-core";

/**
 * 导出编排：文档模型 → 导出计划 → worker 执行 → 下载 MP4。
 */
export function exportVideo(
  adapter: EditorAdapter,
  onProgress: (message: string, progress?: number) => void,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const project = adapter.getProject();
    // 不把系统字体打包进仓库；FFmpeg 使用运行环境默认字体，部署时可通过 ExportOptions 注入字体。
    const plan = buildExportPlan(project);
    const assets = usedAssets(project);
    const inputs = assets
      .filter((a) => a.url)
      .map((a) => {
        const ext = a.name.includes(".") ? a.name.split(".").pop()?.toLowerCase() : "mp4";
        return { path: `/assets/${a.id}.${ext ?? "mp4"}`, url: a.url! };
      });

    const worker = new Worker(new URL("./worker/export.worker.ts", import.meta.url), {
      type: "module",
    });
    const requestId = Math.floor(Math.random() * 1e9);

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as {
        type: string;
        requestId: number;
        data?: Uint8Array;
        message?: string;
        progress?: number;
      };
      if (msg.requestId !== requestId) return;
      switch (msg.type) {
        case "status":
          onProgress(msg.message ?? "");
          break;
        case "progress":
          onProgress("渲染中…", msg.progress);
          break;
        case "done":
          worker.terminate();
          // BlobPart 在 TS 5.7 对 SharedArrayBuffer 更严格；复制成独立 ArrayBuffer。
          const bytes = msg.data!;
          const owned = new Uint8Array(bytes.byteLength);
          owned.set(bytes);
          resolve(new Blob([owned.buffer], { type: "video/mp4" }));
          break;
        case "error":
          worker.terminate();
          reject(new Error(msg.message ?? "导出失败"));
          break;
      }
    };
    worker.onerror = (err) => {
      worker.terminate();
      reject(new Error(err.message));
    };

    worker.postMessage({
      type: "run",
      payload: { requestId, inputs, filterComplex: plan.filterComplex, outputArgs: plan.outputArgs },
    });
  });
}
