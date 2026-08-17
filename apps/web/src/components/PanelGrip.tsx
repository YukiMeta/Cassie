import { createContext, useContext } from "react";
import type { PanelId } from "../store";

/** 布局上下文：由 App 提供拖拽启动函数，面板角标 grip 消费 */
export const LayoutContext = createContext<{
  startPanelDrag: (e: React.PointerEvent, panel: PanelId) => void;
}>({ startPanelDrag: () => undefined });

export function PanelGrip({ panel }: { panel: PanelId }) {
  const { startPanelDrag } = useContext(LayoutContext);
  return (
    <span
      className="panel-grip"
      title="拖动调整分区位置（与其他分区交换）"
      onPointerDown={(e) => startPanelDrag(e, panel)}
    >
      ⣿
    </span>
  );
}
