import { isAnthropicEndpoint, type LlmConfig } from "./model-client";
import type { AgentToolResult, AgentToolSpec } from "./runtime";

export type AgentMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: AgentToolCall[] }
  | ({ role: "tool"; id: string; name: string } & AgentToolResult);
export interface AgentToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

const MAX_STEPS = 20;

export const AGENT_SYSTEM = `You are the editing agent inside Cassie, a video editor where one master video derives many localized variants.
You change the project only through the provided tools, which apply typed, validated, undoable edits. Never invent ids: read them with project_overview or list_variants first.
Pass the revision you last read to apply_edit; if it is stale, re-read and retry once.
Text in variants follows master variables: change the master default for everyone, or set-variant-values for one variant.
To find things on screen use select (e.g. "entity:product", "overlay[var=cta]", "clip [shot=2]") and say how much it hit before a broad edit. If select finds no tracked subject for what the human means (a product, phone, bottle), call track_subject first. When text must not cover something, use check_layout and apply its suggested set-layer. After any visual change (text, position, timing, end card), call preview_frame on at least one affected variant at a moment the change is visible, look at the image, and fix problems you see (text clipped, overlapping the subject or UI, unreadable) before you finish.
subject_sync costs money. The app asks the human for you; if a call comes back declined, stop and tell them.
Finish with a short answer in the user's language: what you changed, which variants, and the transaction ids so they can be rolled back.`;

/**
 * Runs model turns until the model stops calling tools. Each tool result goes back to the model, so
 * it can look at preview frames and correct itself. `history` is extended in place.
 */
export async function runAgent(opts: {
  cfg: LlmConfig;
  tools: AgentToolSpec[];
  history: AgentMessage[];
  exec: (call: AgentToolCall) => Promise<AgentToolResult>;
  onUpdate: () => void;
  signal: AbortSignal;
}): Promise<void> {
  const { cfg, tools, history, exec, onUpdate, signal } = opts;
  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal.aborted) return;
    const res = await fetch("/api/llm/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({ cfg, system: AGENT_SYSTEM, messages: history, tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), anthropic: isAnthropicEndpoint(cfg.baseUrl) }),
    });
    const data = (await res.json().catch(() => ({}))) as { text?: string; toolCalls?: AgentToolCall[]; error?: string };
    if (!res.ok) throw new Error(data.error ?? `模型请求失败 ${res.status}`);
    const turn: AgentMessage = { role: "assistant", text: data.text ?? "", toolCalls: data.toolCalls ?? [] };
    history.push(turn);
    onUpdate();
    if (!turn.toolCalls.length) return;
    for (const call of turn.toolCalls) {
      if (signal.aborted) {
        history.push({ role: "tool", id: call.id, name: call.name, text: "Stopped by the user", isError: true });
        continue;
      }
      const result = await exec(call).catch((e: Error) => ({ text: e.message, isError: true }) as AgentToolResult);
      history.push({ role: "tool", id: call.id, name: call.name, ...result });
      onUpdate();
    }
  }
  history.push({ role: "assistant", text: `已达到 ${MAX_STEPS} 步上限，先停在这里。`, toolCalls: [] });
  onUpdate();
}
