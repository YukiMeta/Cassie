import { useEffect, useRef, useState, type JSX } from "react";
import {
  bootDemo,
  redo,
  setSlotSize,
  swapSlots,
  togglePlay,
  undo,
  useAppState,
  type PanelId,
  type SlotId,
} from "./store";
import { Topbar } from "./components/Topbar";
import { Sidebar } from "./components/Sidebar";
import { Stage } from "./components/Stage";
import { AgentPanel } from "./components/AgentPanel";
import { Timeline } from "./components/Timeline";
import { SettingsModal } from "./components/SettingsModal";
import { LayoutContext } from "./components/PanelGrip";

const SLOT_ORDER: SlotId[] = ["left", "center", "right", "bottom"];
const SIZE_LIMITS = { leftW: { min: 200, max: 430 }, rightW: { min: 260, max: 560 }, bottomH: { min: 120, max: 480 } };

const PANEL_COMPONENTS: Record<PanelId, () => JSX.Element> = {
  script: Sidebar,
  stage: Stage,
  agent: AgentPanel,
  timeline: Timeline,
};

export function App() {
  const state = useAppState();
  const slotEls = useRef<Partial<Record<SlotId, HTMLDivElement | null>>>({});
  const dragRef = useRef<{ panel: PanelId; from: SlotId } | null>(null);
  const [dragTarget, setDragTarget] = useState<SlotId | null>(null);

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

  const hitSlot = (x: number, y: number): SlotId | null => {
    for (const slot of SLOT_ORDER) {
      const el = slotEls.current[slot];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return slot;
    }
    return null;
  };

  /** 分区拖拽重排：抓住 ⣿ 拖动 → 悬停目标槽位高亮 → 松开交换 */
  const startPanelDrag = (e: React.PointerEvent, panel: PanelId) => {
    e.preventDefault();
    const from = (Object.entries(state.layout.slots).find(([, p]) => p === panel)?.[0] ?? "left") as SlotId;
    dragRef.current = { panel, from };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    document.body.classList.add("panel-dragging");
    const onMove = (ev: PointerEvent) => setDragTarget(hitSlot(ev.clientX, ev.clientY));
    const onUp = (ev: PointerEvent) => {
      const target = hitSlot(ev.clientX, ev.clientY);
      if (target && target !== from) swapSlots(from, target);
      dragRef.current = null;
      setDragTarget(null);
      document.body.classList.remove("panel-dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /** 分隔条拖拽：左/右槽宽与底部槽高 */
  const startResize = (kind: keyof typeof SIZE_LIMITS) => (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startSize = state.layout.sizes[kind];
    const limits = SIZE_LIMITS[kind];
    const onMove = (ev: PointerEvent) => {
      const delta = kind === "rightW" ? startX - ev.clientX : kind === "leftW" ? ev.clientX - startX : startY - ev.clientY;
      const next = Math.max(limits.min, Math.min(limits.max, startSize + delta));
      setSlotSize({ [kind]: next });
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

  const { slots, sizes } = state.layout;
  const renderPanel = (panel: PanelId) => {
    const Comp = PANEL_COMPONENTS[panel];
    return <Comp key={panel} />;
  };

  return (
    <LayoutContext.Provider value={{ startPanelDrag }}>
      <Topbar />
      <main
        className="app"
        style={{
          gridTemplateColumns: `${sizes.leftW}px 12px minmax(0, 1fr) 12px ${sizes.rightW}px`,
          gridTemplateRows: `minmax(0, 1fr) 10px ${sizes.bottomH}px`,
        }}
      >
        <div
          className={`slot ${dragTarget === "left" ? "drop-target" : ""} ${dragRef.current?.from === "left" ? "drag-source" : ""}`}
          ref={(el) => {
            slotEls.current.left = el;
          }}
        >
          {renderPanel(slots.left)}
        </div>
        <div className="panel-divider left" onPointerDown={startResize("leftW")} title="拖动调整宽度" />
        <div
          className={`slot ${dragTarget === "center" ? "drop-target" : ""} ${dragRef.current?.from === "center" ? "drag-source" : ""}`}
          ref={(el) => {
            slotEls.current.center = el;
          }}
        >
          {renderPanel(slots.center)}
        </div>
        <div className="panel-divider right" onPointerDown={startResize("rightW")} title="拖动调整宽度" />
        <div
          className={`slot ${dragTarget === "right" ? "drop-target" : ""} ${dragRef.current?.from === "right" ? "drag-source" : ""}`}
          ref={(el) => {
            slotEls.current.right = el;
          }}
        >
          {renderPanel(slots.right)}
        </div>
        <div className="panel-divider bottom" onPointerDown={startResize("bottomH")} title="拖动调整高度" />
        <div
          className={`slot ${dragTarget === "bottom" ? "drop-target" : ""} ${dragRef.current?.from === "bottom" ? "drag-source" : ""}`}
          ref={(el) => {
            slotEls.current.bottom = el;
          }}
        >
          {renderPanel(slots.bottom)}
        </div>
      </main>
      {state.toast && <div className="toast visible">{state.toast}</div>}
      {state.settingsOpen && <SettingsModal />}
    </LayoutContext.Provider>
  );
}
