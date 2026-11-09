import { providerWorkbench } from "../lib/workspace-mode";
import { exportVideo } from "../export";
import { renderOnServer } from "../lib/model-client";
import {
  exportRuntime,
  redo,
  setExporting,
  setSettingsOpen,
  setToast,
  undo,
  useAppState,
} from "../store";

export function Topbar() {
  const state = useAppState();
  const project = state.adapter.getProject();
  const durationSec = (project.settings.durationUs / 1e6).toFixed(0);
  const history = state.adapter.getHistory();
  const showProject = Boolean(state.runtime) || (providerWorkbench && state.booted);
  const runtimeUndo = Boolean(state.runtime?.workspace.transactions.some((t) => t.status === "committed"));

  const handleExport = async () => {
    if (state.exporting || state.busy) return;
    setExporting(true);
    try {
      if (state.runtime) {
        setToast("开始导出：运行时渲染 MP4");
        const url = await exportRuntime();
        if (!url) return;
        const a = document.createElement("a");
        a.href = url;
        a.download = `${project.name.replace(/\s+/g, "-")}.mp4`;
        a.click();
        setToast("导出完成，MP4 已下载");
        return;
      }
      const render = state.modelConfig.render;
      const useServer = render.enabled && Boolean(render.baseUrl);
      setToast(useServer ? "开始导出：提交到渲染服务" : "开始导出：素材与渲染都在本地完成");
      const blob = useServer
        ? await renderOnServer(render, project, (message, progress) =>
            setToast(progress > 0 ? `${message} ${progress}%` : message),
          )
        : await exportVideo(state.adapter, (message) => {
            if (message === "渲染中…") return;
            setToast(message);
          });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${project.name.replace(/\s+/g, "-")}.mp4`;
      a.click();
      setToast("导出完成，MP4 已下载");
    } catch (err) {
      setToast(`导出失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <header className="topbar">
      <div className="brand">
        {providerWorkbench && <img className="brand-mark" src="/brand/logo-64.png" alt="" width={28} height={28} />}
        <div className="brand-copy">
          <strong>Cassie</strong>
          {providerWorkbench && <span>Semantic Video Editor</span>}
        </div>
      </div>
      {showProject && <div className="project-meta">
        <span className="project-title">{project.name}</span>
        <span>·</span>
        <span>
          {durationSec}s / {project.settings.width}:{project.settings.height}
        </span>
        <span className="autosave">● 已保存</span>
      </div>}
      {providerWorkbench && <nav className="mode-switch" aria-label="工作模式">
        <button onClick={() => setToast("故事板模式：v2 规划中")}>故事板</button>
        <button className="active">导演画布</button>
        <button onClick={() => setToast("成片模式：先导出 MP4 或在 v2 中直接交付")}>成片</button>
      </nav>}
      <div className="top-actions">
        <button
          className="ghost-btn"
          onClick={() => undo()}
          disabled={!showProject || (state.runtime ? !runtimeUndo || Boolean(state.busy) : !history.past)}
          aria-label="撤销" title="撤销 (⌘Z)"
        >
          ↶
        </button>
        {!state.runtime && providerWorkbench && <button
          className="ghost-btn"
          onClick={() => redo()}
          disabled={state.runtime ? true : !history.future}
          aria-label="重做" title={state.runtime ? "运行时工程暂不支持重做" : "重做"}
        >
          ↷
        </button>}
        {providerWorkbench && <button
          className="ghost-btn parse-mode-chip"
          title={state.parseMode === "llm" ? "意图解析：用户配置的 LLM" : "意图解析：本地确定性（未配置模型）"}
          onClick={() => setSettingsOpen(true)}
        >
          {state.parseMode === "llm" ? "⚡ LLM" : "▣ 本地解析"}
        </button>}
        {providerWorkbench && <span className="version-chip">版本 {String(project.revision).padStart(2, "0")}</span>}
        {providerWorkbench && <button className="ghost-btn" onClick={() => setSettingsOpen(true)} title="模型设置（BYOK）">
          ⚙ 模型
        </button>}
        <button className="primary-btn" onClick={() => void handleExport()} disabled={!showProject || state.exporting || Boolean(state.busy)}>
          {state.exporting ? "渲染中…" : "导出成片"}
        </button>
      </div>
    </header>
  );
}
