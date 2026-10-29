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

export const AGENT_SYSTEM = `You are the editing agent inside Cassie, focused on videos up to 15 seconds.
Use project_overview first; never invent ids. Change projects only through typed, validated, undoable tools. Pass the latest revision to apply_edit.
Video understanding and semantic grounding are available in the left 理解 panel; use read_video_analysis to read its saved source observations and grounding. Observation ids are not authored timeline event ids; map source ranges to actual clips and do not invent bindings. You cannot infer motion or event order from one preview frame. If an instruction needs an unobserved action or an uncertain target, ask the user to analyze and locate it there; never invent a binding or claim an edit was completed.
Variants and localization are outside this version's UI scope. Work on the current timeline only. The current tools can edit text, geometry, timing and tracked-region appearance; they cannot generate arbitrary new actions.
Use select to inspect existing targets and track_subject for a named visible object when necessary. Verify visual changes with preview_frame. A still frame does not prove dynamic action correctness. Finish briefly in the user's language with actual changes and transaction ids.`;

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
