import { useEffect, useRef, useState, type ReactNode } from "react";
import { clearAgent, sendAgentMessage, setSettingsOpen, stopAgent, useAppState } from "../store";
import type { AgentMessage } from "../lib/agent";

const TOOL_LABEL: Record<string, string> = {
  read_video_analysis: "读取短片理解与定位证据",
  project_overview: "读取工程",
  list_variants: "查看变体",
  edit_reference: "查阅编辑类型",
  plan_edit: "预演修改",
  apply_edit: "应用修改",
  history: "查看历史",
  rollback: "回滚",
  preview_frame: "截取画面",
  select: "定位画面内容",
  track_subject: "识别并跟踪",
  locate_variant: "变体迁移定位",
  check_layout: "检查遮挡",
  render_video: "渲染视频",
  subject_sync_quote: "主体同步报价",
  subject_sync: "同步主体",
};

const SUGGESTIONS = [
  "查看当前视频工程的片段和已跟踪对象",
  "检查当前时间线上的文字有没有遮挡主体",
  "列出最近的修改记录，说明哪些可以撤销",
];

function callSummary(name: string, args: Record<string, unknown>): string {
  const edit = args.edit as { kind?: string } | undefined;
  if (edit?.kind) return edit.kind;
  if (name === "track_subject") return String(args.name ?? args.prompt ?? "");
  if (name === "locate_variant") return String(args.variantId ?? "");
  if (name === "select") return String(args.selector ?? "");
  if (name === "check_layout") return `${args.subject ?? ""} ⟂ ${args.avoid ?? ""}`;
  if (name === "preview_frame") return `${args.variantId ?? "母版"} · ${Number(args.seconds ?? 0).toFixed(1)}s`;
  if (name === "rollback") return String(args.transactionId ?? "").slice(0, 8);
  if (Array.isArray(args.variantIds)) return `${args.variantIds.length} 条`;
  if (args.filter) return String(args.filter);
  if (args.variantId) return String(args.variantId);
  return "";
}

function Steps({ messages }: { messages: AgentMessage[] }) {
  const out: ReactNode[] = [];
  messages.forEach((m, i) => {
    if (m.role === "user") out.push(<div key={i} className="ac-user">{m.text}</div>);
    else if (m.role === "assistant") {
      if (m.text.trim()) out.push(<div key={i} className="ac-reply">{m.text}</div>);
      m.toolCalls.forEach((c) => {
        const result = messages.find((r) => r.role === "tool" && r.id === c.id) as Extract<AgentMessage, { role: "tool" }> | undefined;
        out.push(
          <div key={`${i}-${c.id}`} className={`ac-step ${result ? (result.isError ? "error" : "done") : "running"}`}>
            <div className="ac-step-head">
              <i />
              <b>{TOOL_LABEL[c.name] ?? c.name}</b>
              <span>{callSummary(c.name, c.args)}</span>
            </div>
            {result?.isError && <div className="ac-step-error">{errorText(result.text)}</div>}
            {result?.image && <img className="ac-frame" src={`data:${result.image.mimeType};base64,${result.image.data}`} alt={result.text} title={result.text} />}
          </div>,
        );
      });
    }
  });
  return <>{out}</>;
}

function errorText(text: string): string {
  try {
    const v = JSON.parse(text) as { message?: string };
    return v.message ?? text;
  } catch {
    return text;
  }
}

export function AgentChat() {
  const state = useAppState();
  const { messages, running, error } = state.agent;
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const configured = state.modelConfig.llm.enabled && Boolean(state.modelConfig.llm.apiKey);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, running]);
  const send = (text: string) => {
    void sendAgentMessage(text);
    setDraft("");
  };
  return (
    <div className="agent-chat">
      <div className="ac-log" ref={scroller}>
        {!messages.length && (
          <div className="ac-empty">
            <p>用一句话告诉 Agent 要改什么。它只能通过可回滚的编辑修改工程，改完会截图自查。</p>
            {SUGGESTIONS.map((s) => (
              <button key={s} className="ac-suggest" disabled={!configured || running} onClick={() => send(s)}>{s}</button>
            ))}
          </div>
        )}
        <Steps messages={messages} />
        {running && <div className="ac-thinking">思考中…</div>}
        {error && (
          <div className="ac-error">
            {error}
            {!configured && <button className="tool-btn" onClick={() => setSettingsOpen(true)}>打开模型设置</button>}
          </div>
        )}
      </div>
      <div className="ac-compose">
        <textarea
          value={draft}
          rows={2}
          placeholder={configured ? "例如：把文字往下挪，别压住主体" : "先在模型设置里配置语义模型"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!running) send(draft);
            }
          }}
        />
        <div className="ac-actions">
          {messages.length > 0 && !running && <button className="tool-btn" onClick={clearAgent}>新对话</button>}
          {running ? (
            <button className="danger-btn" onClick={stopAgent}>停止</button>
          ) : (
            <button className="primary-btn" disabled={!draft.trim()} onClick={() => send(draft)}>发送</button>
          )}
        </div>
      </div>
    </div>
  );
}
