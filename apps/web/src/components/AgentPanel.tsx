import { useState } from "react";
import { deriveLifecycle } from "@cassie/spec";
import {
  cancelTransaction,
  commitTransaction,
  compileIntentSmart,
  rollbackTransaction,
  setToast,
  useAppState,
} from "../store";
import type { EditTransaction, Scope } from "@cassie/harness";
import { PanelGrip } from "./PanelGrip";

const HARNESS_FLOW = ["BOUND", "TRACED", "IMPACTED", "GUARDED", "PLANNED", "VALIDATING", "COMMITTED"];

const SCOPE_OPTIONS: { label: string; scope: Scope }[] = [
  { label: "主体生命周期", scope: "entity_lifecycle" },
  { label: "本镜头", scope: "shot" },
  { label: "从这里开始", scope: "from_here" },
];

function fmt(us: number): string {
  return `${(us / 1_000_000).toFixed(1)}s`;
}

function transactionLabel(tx: EditTransaction | undefined): string {
  if (!tx) return "等待指令";
  if (tx.status === "COMMITTED") return "已提交";
  if (tx.status === "FAILED") return "需要修正";
  if (tx.status === "CANCELLED") return "已取消";
  if (tx.status === "ROLLED_BACK") return "已回滚";
  return tx.status;
}

export function AgentPanel() {
  const state = useAppState();
  const [input, setInput] = useState("把香水瓶替换成磨砂银瓶，从第一次出现到消失都保持同一个商品");
  const [scope, setScope] = useState<Scope>("entity_lifecycle");
  const selected = state.selectedEntityId ? state.semantic.entities[state.selectedEntityId] : undefined;
  const lifecycle = selected ? deriveLifecycle(selected, state.adapter.getProject()) : null;
  const tx = state.transactions[state.transactions.length - 1];

  const plan = async () => {
    try {
      await compileIntentSmart(input, scope);
      setToast("已生成 Harness 执行计划，请检查影响范围后提交。");
    } catch (error) {
      setToast(`计划生成失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const execute = () => {
    if (!tx) return;
    try {
      commitTransaction(tx);
      setToast("语义事务已提交，Editor Commands 已写入时间线。");
    } catch (error) {
      setToast(`提交失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <aside className="agent-panel panel">
      <div className="agent-head">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <PanelGrip panel="agent" />
          <div>
            <span className="eyebrow">Subject Harness</span>
            <strong>语义修改编译器</strong>
          </div>
        </div>
        <span className="agent-status">{transactionLabel(tx)}</span>
      </div>
      <div className="agent-body">
        <div className="context-card">
          <div className="context-title"><strong>当前上下文</strong><span>{selected ? "已绑定实体" : "未选择主体"}</span></div>
          <dl className="context-grid">
            <dt>主体</dt><dd>{selected?.name ?? "选择时间线或画布主体"}</dd>
            <dt>引用</dt><dd>{selected?.reference ?? "—"}</dd>
            <dt>主体生命期</dt><dd>{lifecycle ? `${fmt(lifecycle.enterUs)} — ${fmt(lifecycle.exitUs)}` : "—"}</dd>
            <dt>版本</dt><dd>Revision {state.adapter.getProject().revision}</dd>
          </dl>
          <div className="scope-row">
            {SCOPE_OPTIONS.map((opt) => (
              <button
                key={opt.scope}
                className={`scope-chip ${scope === opt.scope ? "active" : ""}`}
                onClick={() => setScope(opt.scope)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="harness-card">
          <div className="context-title"><strong>Harness 状态机</strong><span>{tx?.status ?? "DRAFT"}</span></div>
          <div className="harness-flow">
            {HARNESS_FLOW.map((item) => {
              const current = tx ? HARNESS_FLOW.indexOf(tx.status) : -1;
              const index = HARNESS_FLOW.indexOf(item);
              return <div key={item} className={`harness-node ${index < current || tx?.status === "COMMITTED" && index <= current ? "done" : ""} ${index === current ? "active" : ""}`}><b>{String(index + 1).padStart(2, "0")} · {item}</b>{item === "IMPACTED" ? "计算时间线传播" : item === "GUARDED" ? "检查关系与硬锁" : item === "PLANNED" ? "编译 Editor Commands" : item === "COMMITTED" ? "验证并提交版本" : item === "BOUND" ? "绑定语义主体" : "追踪主体生命周期"}</div>;
            })}
          </div>
          {tx && <div className="impact-list">{tx.impact.rows.map((row) => <div className="impact-row" key={`${row.kind}-${row.copy}`}><b>{row.kind}</b><span>{row.copy}</span><i className={`impact-tag ${row.tag === "CHANGE" ? "change" : "guard"}`}>{row.tag}</i></div>)}</div>}
        </div>

        <div className="quick-prompts">
          {["让香水瓶从第8秒开始变成蓝色，Logo和人物保持不变", "把香水瓶替换成磨砂银瓶，从第一次出现到消失都保持同一个商品", "把商品第一次出现提前2秒，音乐节奏保持不变", "重新生成商品的大幅运动轨迹"].map((prompt) => <button key={prompt} onClick={() => setInput(prompt)}>{prompt.slice(0, 12)}{prompt.length > 12 ? "…" : ""}</button>)}
        </div>

        <div className="composer">
          <input value={input} onChange={(event) => setInput(event.target.value)} aria-label="Agent 指令" />
          <div className="reference-chips"><span className="reference-token">{selected?.reference ?? "@Nocturne_Bottle"}</span></div>
          <div className="composer-row"><span className="composer-hint">{state.parsing ? "模型解析中…" : state.parseMode === "llm" ? "LLM 解析意图 · 失败自动回退本地" : "本地确定性解析 · 可在 ⚙ 模型 中配置 LLM"}</span><button className="primary-btn plan-btn" onClick={() => void plan()} disabled={state.parsing}>{state.parsing ? "解析中…" : "生成执行计划"}</button></div>
        </div>

        {tx && <div className="plan-card visible">
          <div className="context-title"><strong>Agent 执行计划</strong><span>{tx.status}</span></div>
          <div className="plan-step"><span className="step-index">1</span><div><strong>定位主体生命周期</strong><span>{tx.lifecycleBefore ? `${fmt(tx.lifecycleBefore.enterUs)} → ${fmt(tx.lifecycleBefore.exitUs)}` : "未解析"}</span></div></div>
          <div className="plan-step"><span className="step-index">2</span><div><strong>计算级联影响</strong><span>{tx.impact.affectedEntities.length} 个主体 · {tx.impact.affectedClipIds.length} 个片段</span></div></div>
          <div className="plan-step"><span className="step-index">3</span><div><strong>编译可撤销命令</strong><span>{tx.commands.length} 条 Editor Commands · base revision {tx.baseRevision}</span></div></div>
          {tx.error && <div className="patch-preview">{tx.error}</div>}
          <div className="modal-actions">
            {tx.status === "PLANNED" && <button className="primary-btn execute-btn" onClick={execute}>确认并提交</button>}
            {tx.status === "COMMITTED" && <button className="secondary-btn" onClick={() => { rollbackTransaction(tx); setToast("事务已回滚到提交前版本。"); }}>回滚事务</button>}
            {!(["COMMITTED", "ROLLED_BACK", "CANCELLED", "FAILED"] as string[]).includes(tx.status) && <button className="ghost-btn" onClick={() => { cancelTransaction(tx); setToast("事务已取消。"); }}>取消</button>}
          </div>
        </div>}
      </div>
    </aside>
  );
}
