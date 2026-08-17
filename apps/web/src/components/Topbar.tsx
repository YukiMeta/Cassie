import { exportVideo } from "../export";
import {
  redo,
  setExporting,
  setToast,
  undo,
  useAppState,
} from "../store";

export function Topbar() {
  const state = useAppState();
  const project = state.adapter.getProject();
  const durationSec = (project.settings.durationUs / 1e6).toFixed(0);
  const history = state.adapter.getHistory();

  const handleExport = async () => {
    if (state.exporting) return;
    setExporting(true);
    setToast("开始导出：素材与渲染都在本地完成");
    try {
      const blob = await exportVideo(state.adapter, (message) => {
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
        <div className="brand-mark">C</div>
        <div className="brand-copy">
          <strong>Cassie</strong>
          <span>Semantic Video Editor</span>
        </div>
      </div>
      <div className="project-meta">
        <span className="project-title">Projects / {project.name}</span>
        <span>·</span>
        <span>
          {durationSec}s / {project.settings.width}:{project.settings.height}
        </span>
        <span className="autosave">● 已保存</span>
      </div>
      <nav className="mode-switch" aria-label="工作模式">
        <button disabled>故事板</button>
        <button className="active">导演画布</button>
        <button disabled>成片</button>
      </nav>
      <div className="top-actions">
        <button
          className="ghost-btn"
          onClick={() => undo()}
          disabled={!history.past}
          title="撤销 (⌘Z)"
        >
          ↶
        </button>
        <button
          className="ghost-btn"
          onClick={() => redo()}
          disabled={!history.future}
          title="重做"
        >
          ↷
        </button>
        <button className="ghost-btn version-chip">版本 {String(project.revision).padStart(2, "0")}</button>
        <button className="primary-btn" onClick={() => void handleExport()} disabled={state.exporting}>
          {state.exporting ? "渲染中…" : "导出成片"}
        </button>
      </div>
    </header>
  );
}
