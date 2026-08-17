import { useEffect, useState } from "react";
import { bootDemo, redo, togglePlay, undo, useAppState } from "./store";
import { Topbar } from "./components/Topbar";
import { Sidebar } from "./components/Sidebar";
import { Stage } from "./components/Stage";
import { AgentPanel } from "./components/AgentPanel";
import { Timeline } from "./components/Timeline";
import { SettingsModal } from "./components/SettingsModal";

/** 面板宽度（px），可拖拽分隔条调整 */
const PANEL_LIMITS = { sidebar: { min: 200, max: 430 }, agent: { min: 260, max: 560 } };

export function App() {
  const state = useAppState();
  const [panels, setPanels] = useState({ sidebar: 264, agent: 336 });

  // ⌘Z / ⇧⌘Z 全局撤销重做；空格 播放/暂停
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === " " && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        togglePlay();
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 拖拽分隔条：pointerdown 时挂全局监听，实时调整面板宽度
  const startResize = (kind: "sidebar" | "agent") => (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panels[kind];
    const limits = PANEL_LIMITS[kind];
    const onMove = (ev: PointerEvent) => {
      const delta = ev.clientX - startX;
      // sidebar 向右拖 = 变宽；agent 向左拖 = 变宽
      const next = kind === "sidebar" ? startW + delta : startW - delta;
      const clamped = Math.max(limits.min, Math.min(limits.max, next));
      setPanels((p) => (kind === "sidebar" ? { ...p, sidebar: clamped } : { ...p, agent: clamped }));
    };
    const onUp = () => {
      document.body.classList.remove("resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ?demo=1：自动载入演示项目（无头验证 / 演示链接用）
  if (!state.booted && !state.bootProgress && new URLSearchParams(location.search).get("demo") === "1") {
    void bootDemo();
  }

  if (!state.booted) {
    return (
      <div className="boot-screen">
        <div className="boot-card">
          <img className="brand-mark large" src="/brand/logo-128.png" alt="Cassie" width={56} height={56} />
          <h1>Cassie</h1>
          <p className="boot-sub">Semantic Video Editor · 语义主体驱动的视频编辑器</p>
          {state.bootProgress ? (
            <div className="boot-progress">
              <div className="spinner" />
              <span>{state.bootProgress}</span>
            </div>
          ) : (
            <button className="primary-btn boot-btn" onClick={() => void bootDemo()}>
              载入 NOCTURNE 演示项目
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <Topbar />
      <main
        className="app"
        style={{ gridTemplateColumns: `${panels.sidebar}px 12px minmax(0, 1fr) 12px ${panels.agent}px` }}
      >
        <Sidebar />
        <div className="panel-divider left" onPointerDown={startResize("sidebar")} title="拖动调整左侧栏宽度" />
        <Stage />
        <div className="panel-divider right" onPointerDown={startResize("agent")} title="拖动调整 Agent 面板宽度" />
        <AgentPanel />
        <Timeline />
      </main>
      {state.toast && <div className="toast visible">{state.toast}</div>}
      {state.settingsOpen && <SettingsModal />}
    </>
  );
}
