import type { Intent } from "@cassie/harness";
import type { TimeUs } from "@cassie/editor-core";

/**
 * 模型客户端 —— 全站唯一的模型访问入口。
 * 所有请求走本地代理（/api/llm、/api/vision），用户填写的 key 只在本机流动，
 * 从不出现在前端代码、仓库或任何远端日志。
 */

export interface LlmConfig {
  enabled: boolean;
  baseUrl: string; // OpenAI 兼容端点，或以 /anthropic 结尾的 Anthropic 格式端点
  apiKey: string;
  model: string;
}

export interface VisionConfig {
  enabled: boolean;
  /** SAM 3 提取服务地址（servers/sam3），实现 /extract 契约 */
  baseUrl: string;
  apiKey: string;
}

const isAnthropicEndpoint = (baseUrl: string) => /anthropic/i.test(baseUrl);

/** 本地代理转发：请求体里带 baseUrl/apiKey（仅发给 localhost 代理） */
async function proxyFetch<T>(path: string, payload: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`代理请求失败 ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

// ---------- 语义 LLM（意图解析 / 命名 / 关系判定共用） ----------

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function llmChat(cfg: LlmConfig, messages: LlmMessage[], opts: { timeoutMs?: number } = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const data = await proxyFetch<{ content: string }>("/api/llm", {
      cfg,
      messages,
      anthropic: isAnthropicEndpoint(cfg.baseUrl),
    });
    return data.content;
  } finally {
    clearTimeout(timer);
  }
}

/** 从 LLM 文本回复中稳健提取 JSON 对象 */
export function extractJson<T>(text: string): T {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fence?.[1] ?? text;
  const start = candidate.search(/[{[]/);
  const end = candidate.lastIndexOf(/[}\]]/.source) + 1;
  if (start < 0 || end <= start) throw new Error("回复中没有 JSON");
  return JSON.parse(candidate.slice(start, end)) as T;
}

// ---------- 意图解析（LLM 版） ----------

export const INTENT_SYSTEM_PROMPT = `你是视频编辑器 Cassie 的语义意图解析器。把用户指令解析为严格 JSON，不要输出任何其他内容。
JSON 契约：
{
  "subjectRef": string|null,   // 主体：实体 id / 名称 / @引用，如 "@Nocturne_Bottle"；无法确定填 null
  "operation": "replace_variant"|"retime_lifecycle"|"recolor"|"reframe"|"regen_motion"|"set_attrs",
  "args": {…},                 // retime_lifecycle: {"shiftUs": 提前为负、推迟为正的微秒数}
                                // replace_variant: {"variant": …} / recolor: {"color": …} / reframe: {"framing": …}
                                // regen_motion: {} / set_attrs: {"attrs": {…}}
  "scope": "moment"|"shot"|"entity_lifecycle"|"from_here"|"full",
  "fromUs": number|null         // scope=from_here 时的起点（微秒）
}
判定规则：
- 出现「从第一次出现到消失/生命期/全程/同一个主体」→ scope=entity_lifecycle
- 出现「第X秒/从X秒开始」→ scope=from_here 且 fromUs=X秒
- 「提前/推迟N秒」→ operation=retime_lifecycle，提前为负
- 「变成蓝/换颜色」→ recolor；「替换成/换成X」→ replace_variant；「特写/构图/景别」→ reframe；「轨迹/运动」→ regen_motion`;

export async function llmParseIntent(
  cfg: LlmConfig,
  text: string,
  ctx: { playheadUs: TimeUs; entities: { id: string; name: string; reference?: string }[] },
): Promise<Intent> {
  const user = [
    `用户指令：${text}`,
    `上下文：playhead=${(ctx.playheadUs / 1e6).toFixed(1)}s；可用主体：${ctx.entities
      .map((e) => `${e.id}(${e.name}${e.reference ? `,${e.reference}` : ""})`)
      .join("；") || "（无，由用户指令决定）"}`,
  ].join("\n");
  const reply = await llmChat(cfg, [
    { role: "system", content: INTENT_SYSTEM_PROMPT },
    { role: "user", content: user },
  ]);
  const parsed = extractJson<{
    subjectRef?: string | null;
    operation?: Intent["operation"];
    args?: Record<string, string | number | boolean>;
    scope?: Intent["scope"];
    fromUs?: number | null;
  }>(reply);
  const operation = parsed.operation ?? "set_attrs";
  const scope = parsed.scope ?? "entity_lifecycle";
  const fromUs = typeof parsed.fromUs === "number" ? parsed.fromUs : undefined;
  return {
    text,
    operation,
    subjectRef: parsed.subjectRef ?? null,
    args: parsed.args ?? {},
    scope,
    fromUs,
  };
}

// ---------- SAM 3 视觉提取 ----------

export interface ExtractedTrack {
  track_id: string | number;
  score: number;
  /** 该轨迹首尾帧时间（微秒，由帧率换算） */
  startUs: TimeUs;
  endUs: TimeUs;
  boxes: { t: TimeUs; box: [number, number, number, number] }[];
}

export interface ExtractedCandidate {
  concept: string;
  tracks: ExtractedTrack[];
}

export interface ExtractRequest {
  /** 视频文件（FormData 上传） */
  file: File;
  /** 概念提示词，如 ["perfume bottle", "person"] */
  prompts: string[];
}

export async function visionExtract(cfg: VisionConfig, req: ExtractRequest): Promise<{ candidates: ExtractedCandidate[] }> {
  const form = new FormData();
  form.append("file", req.file);
  form.append("prompts", JSON.stringify(req.prompts));
  form.append("baseUrl", cfg.baseUrl);
  form.append("apiKey", cfg.apiKey);
  const res = await fetch("/api/vision", { method: "POST", body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`视觉提取失败 ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as { candidates: ExtractedCandidate[] };
}
