import { useEffect } from "react";
import { bootDemo, redo, undo, useAppState } from "./store";
import { Topbar } from "./components/Topbar";
import { Sidebar } from "./components/Sidebar";
import { Stage } from "./components/Stage";
import { AgentPanel } from "./components/AgentPanel";
import { Timeline } from "./components/Timeline";

export function App() {
  const state = useAppState();

  // ⌘Z / ⇧⌘Z 全局撤销重做
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ?demo=1：自动载入演示项目（无头验证 / 演示链接用）
  if (!state.booted && !state.bootProgress && new URLSearchParams(location.search).get("demo") === "1") {
    void bootDemo();
  }

  if (!state.booted) {
    return (
      <div className="boot-screen">
        <div className="boot-card">
          <div className="brand-mark large">C</div>
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
      <main className="app">
        <Sidebar />
        <Stage />
        <AgentPanel />
        <Timeline />
      </main>
      {state.toast && <div className="toast visible">{state.toast}</div>}
    </>
  );
}
