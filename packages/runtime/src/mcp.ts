import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { shortVideoAgentTools, callAgentTool, closeAgentBrowser, type ToolContext } from "./agent-tools";
import { serveWorkspace } from "./server";

const PROTOCOL = "2025-06-18";

const INSTRUCTIONS = `Cassie is a local, file-based short-video workspace. Browser state is never the source of truth.
Start with project_overview. Import a local path with add_video_source if needed. Use prepare_video_evidence, inspect ordered frames with read_evidence_frame (or local image tools), and submit_video_analysis. For a semantic query, prepare a focused evidence window, re-inspect it, then submit_video_grounding against the current analysis id. No browser, upload dialog, API key or second model is required for this native-agent path.
Optional analyze_video / ground_video adapters use host environment configuration and send images to that provider. Never invent observations or evidence. Preserve ambiguous/not_found states. Source observation ids are not timeline event ids.
Edits still use typed apply_edit with baseRevision; rollback and render_video are unchanged. Viewing a still does not prove dynamic edit correctness. The UI is a viewer of files and evidence, not a prerequisite to operating Cassie.`;

/**
 * MCP over stdio for external coding agents. stdout carries only JSON-RPC, so all logging (including
 * the renderer's) is redirected to stderr. A private runtime on a free port serves preview frames.
 */
export async function serveMcp(projectFile: string, version: string): Promise<void> {
  const file = resolve(projectFile);
  const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);
  let runtime = null as Awaited<ReturnType<typeof serveWorkspace>> | null;
  const ctx: ToolContext = { file, baseUrl: async () => (runtime ??= await serveWorkspace(file, 0)).url };

  const handle = async (req: { id?: number | string; method: string; params?: Record<string, any> }) => {
    switch (req.method) {
      case "initialize":
        return { protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "cassie", version }, instructions: INSTRUCTIONS };
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: shortVideoAgentTools().map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: { readOnlyHint: ["project_overview", "list_variants", "edit_reference", "plan_edit", "history", "preview_frame", "subject_sync_quote", "read_video_analysis", "read_evidence_frame"].includes(t.name), destructiveHint: false, openWorldHint: Boolean(t.external || t.paid) },
          })),
        };
      case "tools/call": {
        const result = await callAgentTool(ctx, String(req.params?.name), req.params?.arguments ?? {});
        return {
          content: [{ type: "text", text: result.text }, ...(result.image ? [{ type: "image", data: result.image.data, mimeType: result.image.mimeType }] : [])],
          ...(result.isError ? { isError: true } : {}),
        };
      }
      default:
        throw Object.assign(new Error(`Method not found: ${req.method}`), { code: -32601 });
    }
  };

  const lines = createInterface({ input: process.stdin });
  const pending = new Set<Promise<unknown>>();
  for await (const line of lines) {
    if (!line.trim()) continue;
    let req: { id?: number | string; method: string; params?: Record<string, any> };
    try {
      req = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    if (req.id === undefined) continue;
    const job = handle(req)
      .then(result => send({ jsonrpc: "2.0", id: req.id, result }))
      .catch((e: { code?: number; message?: string }) => send({ jsonrpc: "2.0", id: req.id, error: { code: typeof e.code === "number" ? e.code : -32603, message: e.message ?? String(e) } }))
      .finally(() => pending.delete(job));
    pending.add(job);
  }
  await Promise.all(pending);
  runtime?.close();
  await closeAgentBrowser();
}
