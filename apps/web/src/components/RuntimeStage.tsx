import { useCallback, useEffect, useRef, useState } from "react";
import {
  claimDetected,
  clearDetection,
  detectAtPlayhead,
  selectEntity,
  selectRegion,
  stageZoomFit,
  stageZoomIn,
  stageZoomOut,
  toggleSafeFrame,
  useAppState,
} from "../store";
import { sceneUrl } from "../lib/runtime";
import { PanelGrip } from "./PanelGrip";

type SceneWindow = Window & { cassieSeek?: (time: number) => Promise<void> };
interface Rect { id: string; left: number; top: number; width: number; height: number }

/**
 * 运行时画布：预览就是导出用的同一份场景（局部主体着色与替换都与成片一致）。
 * 叠加层负责交互：点物体选中局部主体，识别框认领新主体。
 */
export function RuntimeStage() {
  const state = useAppState();
  const runtime = state.runtime!;
  const { width, height } = runtime.document.editor.settings;
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState(0.3);
  const [regions, setRegions] = useState<Rect[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  const scale = fit * state.stageZoom;
  const revision = runtime.document.editor.revision;

  useEffect(() => {
    const el = workspaceRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const box = el.getBoundingClientRect();
      setFit(Math.max(0.05, Math.min((box.width - 48) / width, (box.height - 48) / height)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [width, height]);

  const measure = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    const next: Rect[] = [];
    for (const el of doc.querySelectorAll<HTMLElement>("[data-cassie-region]")) {
      if (el.style.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      next.push({ id: el.dataset.cassieRegion!, left: r.left, top: r.top, width: r.width, height: r.height });
    }
    setRegions(next);
  }, []);

  const seek = useCallback(async () => {
    const win = frameRef.current?.contentWindow as SceneWindow | null;
    if (!win?.cassieSeek) return;
    await win.cassieSeek(state.playheadUs / 1e6).catch(() => undefined);
    measure();
  }, [state.playheadUs, measure]);

  useEffect(() => {
    void seek();
  }, [seek, revision]);

  const pickRegion = (x: number, y: number) => {
    const hits = regions.filter((r) => x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height);
    hits.sort((a, b) => a.width * a.height - b.width * b.height);
    return hits[0]?.id ?? null;
  };

  const toScene = (e: React.PointerEvent | React.MouseEvent) => {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: (e.clientX - box.left) / scale, y: (e.clientY - box.top) / scale };
  };

  const det = state.detection;
  const detBoxes = (() => {
    if (!det) return [];
    const index = runtime.document.scene.layers.findIndex((l) => l.id === det.layerId);
    const video = frameRef.current?.contentDocument?.getElementById(`video-${index}`) as HTMLVideoElement | null;
    if (!video?.videoWidth) return [];
    const r = video.getBoundingClientRect();
    const sx = r.width / video.videoWidth, sy = r.height / video.videoHeight;
    return [...det.objects]
      .sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])
      .map((o) => ({ o, left: r.left + o.box[0] * sx, top: r.top + o.box[1] * sy, width: o.box[2] * sx, height: o.box[3] * sy }));
  })();

  const regionName = (id: string) => {
    const region = runtime.document.regions?.[id];
    return region ? state.semantic.entities[region.entityId]?.name ?? id : id;
  };

  return (
    <section className="stage-panel">
      <div className="stage-toolbar">
        <div className="tool-group">
          <PanelGrip panel="stage" />
          <button className="tool-btn active" title="点击画面中的物体选中局部主体" onClick={() => selectRegion(null)}>
            ↖ 选择
          </button>
          <button
            className={`tool-btn ${det ? "active" : ""}`}
            title="识别当前帧中的物体，点击识别框单独选中它"
            disabled={Boolean(state.busy)}
            onClick={() => (det ? clearDetection() : detectAtPlayhead())}
          >
            {det ? "✕ 取消识别" : "⌖ 识别物体"}
          </button>
          <button className={`tool-btn ${state.safeFrame ? "active" : ""}`} title="显示/隐藏安全框" onClick={toggleSafeFrame}>
            ⌗ 安全框
          </button>
          {state.busy && <span className="stage-busy">{state.busy}</span>}
        </div>
        <div className="tool-group">
          <button className="tool-btn" title="缩小预览" onClick={stageZoomOut}>−</button>
          <button className="zoom" title="恢复适应画布" onClick={stageZoomFit}>
            {Math.round(scale * 100)}% · 适应
          </button>
          <button className="tool-btn" title="放大预览" onClick={stageZoomIn}>＋</button>
        </div>
      </div>
      <div className="stage-workspace runtime" ref={workspaceRef}>
        <div className="runtime-frame" style={{ width: width * scale, height: height * scale }}>
          <iframe
            ref={frameRef}
            title="Cassie 预览"
            src={sceneUrl(revision)}
            sandbox="allow-scripts allow-same-origin"
            style={{ width, height, transform: `scale(${scale})` }}
            onLoad={() => void seek()}
          />
          <div
            className="runtime-overlay"
            onPointerMove={(e) => {
              const p = toScene(e);
              setHover(pickRegion(p.x, p.y));
            }}
            onPointerLeave={() => setHover(null)}
            onPointerDown={(e) => {
              const p = toScene(e);
              const id = pickRegion(p.x, p.y);
              if (id) selectRegion(id);
              else {
                selectRegion(null);
                selectEntity(null);
              }
            }}
          >
            {regions.map((r) => (
              <div
                key={r.id}
                className={`region-outline ${state.selectedRegionId === r.id ? "selected" : ""} ${hover === r.id ? "hover" : ""}`}
                style={{ left: r.left * scale, top: r.top * scale, width: r.width * scale, height: r.height * scale }}
              >
                {(state.selectedRegionId === r.id || hover === r.id) && <span>{regionName(r.id)}</span>}
              </div>
            ))}
            {state.safeFrame && <div className="safe-frame" />}
          </div>
          {det && (
            <div className="detect-layer">
              {detBoxes.map(({ o, left, top, width: w, height: h }, i) => (
                <button
                  key={i}
                  className="detect-box"
                  disabled={Boolean(state.busy)}
                  style={{ left: left * scale, top: top * scale, width: w * scale, height: h * scale }}
                  onClick={() => claimDetected(o)}
                >
                  <span>{o.label} {Math.round(o.score * 100)}%</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
