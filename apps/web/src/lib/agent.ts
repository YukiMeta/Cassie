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

export const AGENT_SYSTEM = `You are Cassie's editing agent for local videos up to 15 seconds. Project files are authoritative; browser state is only a viewer.
Use project_overview first. Work through typed, undoable tools and pass the latest revision to apply_edit.
For understanding, prepare_video_evidence, inspect ordered images with read_evidence_frame, and submit_video_analysis. For semantic queries, re-read focused evidence and submit_video_grounding against the current analysis id. Use your own vision; do not ask the user to upload files in a form, click Analyze, or configure another model. analyze_video / ground_video are optional host-configured adapters.
Never invent observations, evidence or ids. Preserve ambiguous/not_found results. Source observation ids are not timeline event ids; explicitly map source windows to actual clips before editing.
Variants are outside the default scope. Current tools edit text, geometry, timing and tracked-region appearance; they do not generate arbitrary new actions. Verify actual output; a still frame cannot prove motion correctness. Finish in the user's language with real changes and transaction ids.`;

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
