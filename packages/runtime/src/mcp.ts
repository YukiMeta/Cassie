import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { AGENT_TOOLS, callAgentTool, closeAgentBrowser, type ToolContext } from "./agent-tools";
import { serveWorkspace } from "./server";

const PROTOCOL = "2025-06-18";

const INSTRUCTIONS = `Cassie edits one video project through typed, undoable edits.
Start with project_overview. Change things with apply_edit (pass the revision you read), and check visual changes with preview_frame before you report done.
Text in variants follows master variables; prefer set-variable / set-variant-values over editing variants one by one.
subject_sync costs money: call subject_sync_quote, show the quote to the human, and pass confirmed=true only after they agree.
Every change can be undone with rollback.`;

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
          tools: AGENT_TOOLS.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: { readOnlyHint: ["project_overview", "list_variants", "edit_reference", "plan_edit", "history", "preview_frame", "subject_sync_quote"].includes(t.name), destructiveHint: false, openWorldHint: Boolean(t.paid) },
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
