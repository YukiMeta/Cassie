import { useEffect, useState } from "react";
import type { SubjectRegion } from "@cassie/spec";
import { regionsOf, selectRegion, setPlayhead, setRegionLook, useAppState } from "../store";

const COLORS: [RegExp, string, string][] = [
  [/红|red/i, "#e0352b", "红色"],
  [/橙|orange/i, "#f07a1a", "橙色"],
  [/黄|yellow/i, "#f2c418", "黄色"],
  [/绿|green/i, "#2fa84f", "绿色"],
  [/青|cyan|teal/i, "#14b8c4", "青色"],
  [/蓝|blue/i, "#2f6cf6", "蓝色"],
  [/紫|purple|violet/i, "#8a4cf0", "紫色"],
  [/粉|pink/i, "#f05aa8", "粉色"],
  [/金|gold/i, "#c9a227", "金色"],
  [/银|silver|灰|gray|grey/i, "#a9b0bb", "银色"],
  [/黑|black/i, "#1b1d22", "黑色"],
  [/白|white/i, "#f4f4f2", "白色"],
];

/** 从指令里解析外观修改（颜色 / 强度 / 羽化）。替换类指令交给生成管线。 */
export function parseLookInstruction(text: string): { patch: Partial<SubjectRegion["look"]>; summary: string } | null {
  const color = COLORS.find(([re]) => re.test(text));
  const strength = /(\d{1,3})\s*%/.exec(text);
  const patch: Partial<SubjectRegion["look"]> = {};
  const parts: string[] = [];
  if (color) {
    patch.color = color[1];
    parts.push(`颜色改为${color[2]}`);
    if (!strength) patch.tint = 0.85;
  }
  if (strength) {
    patch.tint = Math.min(100, Number(strength[1])) / 100;
    parts.push(`强度 ${strength[1]}%`);
  }
  if (/还原|恢复原|去掉颜色|原色/.test(text)) {
    patch.tint = 0;
    parts.push("恢复原色");
  }
  return parts.length ? { patch, summary: parts.join("，") } : null;
}

/** 选中局部主体后的直接修改：只作用在物体区域内，框外画面不受影响。 */
export function RegionCard() {
  const state = useAppState();
  const entity = state.selectedEntityId ? state.semantic.entities[state.selectedEntityId] : undefined;
  const regions = entity ? regionsOf(entity.id) : [];
  const selected = regions.find((r) => r.id === state.selectedRegionId) ?? regions[0];
  const [scope, setScope] = useState<"one" | "all">("all");
  const [tint, setTint] = useState(0);
  const [feather, setFeather] = useState(0);
  useEffect(() => {
    if (selected) {
      setTint(Math.round(selected.look.tint * 100));
      setFeather(selected.look.feather);
    }
  }, [selected?.id, selected?.look.tint, selected?.look.feather]);
  if (!entity || !selected || !state.runtime) return null;
  const events = state.runtime.events;
  const fps = state.runtime.document.frameRate.num / state.runtime.document.frameRate.den;
  const targets = scope === "all" ? regions.map((r) => r.id) : [selected.id];
  const label = (r: SubjectRegion) => state.runtime!.document.events.find((e) => e.id === r.eventId)?.label ?? r.id;

  return (
    <div className="context-card region-card">
      <div className="context-title">
        <strong>直接修改 · {entity.name}</strong>
        <span>{regions.length} 处出现</span>
      </div>
      <div className="scope-row">
        <button className={`scope-chip ${scope === "all" ? "active" : ""}`} onClick={() => setScope("all")}>全部出现</button>
        <button className={`scope-chip ${scope === "one" ? "active" : ""}`} onClick={() => setScope("one")}>仅这一处</button>
      </div>
      <label className="region-field">
        <span>颜色</span>
        <input
          type="color"
          value={selected.look.color}
          disabled={Boolean(state.busy)}
          onChange={(e) => setRegionLook(targets, { color: e.target.value, ...(selected.look.tint === 0 ? { tint: 0.85 } : {}) })}
        />
      </label>
      <label className="region-field">
        <span>强度 {tint}%</span>
        <input type="range" min={0} max={100} value={tint} onChange={(e) => setTint(Number(e.target.value))} onPointerUp={() => setRegionLook(targets, { tint: tint / 100 })} onKeyUp={() => setRegionLook(targets, { tint: tint / 100 })} />
      </label>
      <label className="region-field">
        <span>羽化 {feather}px</span>
        <input type="range" min={0} max={40} value={feather} onChange={(e) => setFeather(Number(e.target.value))} onPointerUp={() => setRegionLook(targets, { feather })} onKeyUp={() => setRegionLook(targets, { feather })} />
      </label>
      <div className="occurrence-list">
        {regions.map((r) => {
          const e = events.find((x) => x.id === r.eventId);
          return (
            <button
              key={r.id}
              className={`occurrence ${r.id === selected.id ? "active" : ""}`}
              onClick={() => {
                selectRegion(r.id);
                if (e) setPlayhead(((e.startFrame + 1) / fps) * 1e6);
              }}
            >
              <span>{label(r)}</span>
              <small>{e ? `${(e.startFrame / fps).toFixed(1)}s—${(e.endFrame / fps).toFixed(1)}s` : "未触发"} · {r.keys.length} 关键框{r.replacement ? " · 已替换" : ""}</small>
            </button>
          );
        })}
      </div>
      <p className="region-note">修改只作用在跟踪到的物体区域内，框外画面保持原样；每次修改都是一条可撤销记录。</p>
    </div>
  );
}
