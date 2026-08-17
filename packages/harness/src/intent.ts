import type { EntityId } from "@cassie/spec";
import type { TimeUs } from "@cassie/editor-core";

/**
 * 用户意图解析（v1 确定性关键词解析）。
 * 生产管线中这里是 LLM 适配槽：parseIntent 的输入输出契约不变，
 * 未来替换为模型调用后结果仍然可回归测试。
 */
export type Scope = "moment" | "shot" | "entity_lifecycle" | "from_here" | "full";
export type Operation =
  | "replace_variant"
  | "retime_lifecycle"
  | "recolor"
  | "reframe"
  | "regen_motion"
  | "set_attrs";

export interface Intent {
  text: string;
  operation: Operation;
  /** 主体引用：实体 id / 实体名 / @引用；null = 由上下文（当前选择）提供 */
  subjectRef: string | null;
  args: Record<string, string | number | boolean>;
  scope: Scope;
  /** from_here 的起点（µs） */
  fromUs?: TimeUs;
}

export function parseIntent(text: string, ctx: { playheadUs?: TimeUs; selectedEntityId?: EntityId; fromUs?: TimeUs } = {}): Intent {
  const t = text;
  let fromUs = ctx.fromUs;

  let scope: Scope = "entity_lifecycle";
  if (/第一次出现到消失|生命期|全程|同一(个)?(商品|主体|人物)|全片/.test(t)) scope = "entity_lifecycle";
  if (/第\s*(\d+(?:\.\d+)?)\s*秒|从(\d+(?:\.\d+)?)秒/.test(t)) {
    scope = "from_here";
    const m = /第\s*(\d+(?:\.\d+)?)\s*秒|从\s*(\d+(?:\.\d+)?)\s*秒/.exec(t);
    const sec = Number(m?.[1] ?? m?.[2]);
    if (Number.isFinite(sec)) fromUs = Math.round(sec * 1_000_000);
  }
  if (/此刻|当前帧|这里/.test(t)) scope = "moment";
  if (/本镜头|这个镜头|这一段/.test(t) && !/从第/.test(t)) scope = "shot";

  let operation: Operation = "set_attrs";
  const args: Intent["args"] = {};
  if (/大幅.*轨迹|重新生成.*轨迹|轨迹.*AI|换.*轨迹/.test(t)) operation = "regen_motion";
  else if (/提前|推迟|延后|提前.*秒|晚.*秒|提前露出/.test(t)) {
    operation = "retime_lifecycle";
    const m = /(提前|推迟|延后)\s*(\d+(?:\.\d+)?)\s*秒/.exec(t);
    const dir = m?.[1] === "提前" ? -1 : 1;
    const sec = Number(m?.[2] ?? 2);
    args.shiftUs = dir * Math.round(sec * 1_000_000);
  } else if (/蓝/.test(t)) {
    operation = "recolor";
    args.color = "deep_blue";
  } else if (/银|替换/.test(t)) {
    operation = "replace_variant";
    args.variant = "matte_silver";
  } else if (/特写|构图|景别/.test(t)) {
    operation = "reframe";
    args.framing = "product_close_up";
  }

  // 主体引用：@引用 优先，其次首个「主体名词」由上层上下文提供
  const atRef = /@[\w一-龥-]+/.exec(t)?.[0] ?? null;

  return { text: t, operation, subjectRef: atRef, args, scope, fromUs };
}

/** 从可用实体中解析 subjectRef → EntityId（BOUND 阶段） */
export function resolveSubject(
  subjectRef: string | null,
  candidates: { id: EntityId; name: string; reference?: string }[],
  fallbackId: EntityId | null,
): EntityId | null {
  if (!subjectRef) return fallbackId;
  const hit = candidates.find(
    (c) => c.id === subjectRef || c.name === subjectRef || c.reference === subjectRef,
  );
  if (hit) return hit.id;
  // @引用 去掉 @ 再匹配
  const bare = subjectRef.replace(/^@/, "");
  const byRef = candidates.find((c) => c.reference === bare || c.name === bare);
  return byRef?.id ?? fallbackId;
}
