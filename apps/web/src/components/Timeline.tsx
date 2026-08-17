import { useRef, useState } from "react";
import { formatTimecode, moveClipCmd, setClipRangeCmd } from "@cassie/editor-core";
import type { Clip, Project, TimeUs } from "@cassie/editor-core";
import { deriveLifecycle } from "@cassie/spec";
import {
  autosave,
  hasKeyframeAtPlayhead,
  selectClip,
  setPlayhead,
  toggleKeyframe,
  togglePlay,
  toggleSnap,
  useAppState,
  type Keyframe,
} from "../store";
import { PanelGrip } from "./PanelGrip";

const TRANSCRIPT = [
  { time: 1.0, label: "人物进入巴黎夜景" },
  { time: 5.0, label: "拿出香水" },
  { time: 8.0, label: "商品第一次清晰露出" },
  { time: 10.5, label: "音乐卡点 · 产品特写" },
  { time: 13.0, label: "品牌文案出现" },
];

const TRACK_GLYPHS: Record<string, string> = { video: "V", text: "T", audio: "♪" };
const SNAP_US = 500_000;

function clipOf(project: Project, clipId: string): Clip | null {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return clip;
  }
  return null;
}

export function Timeline() {
  const state = useAppState();
  const [view, setView] = useState<"edit" | "semantic">("semantic");
  const [zoom, setZoom] = useState(1);
  const project = state.adapter.getProject();
  const durationUs = project.settings.durationUs;
  const pct = (us: TimeUs) => `${(us / durationUs) * zoom * 100}%`;
  const rulerRef = useRef<HTMLDivElement | null>(null);

  const scrub = (clientX: number) => {
    const rect = rulerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPlayhead(((clientX - rect.left) / rect.width / zoom) * durationUs);
  };

  const entityOfClip = (clipId: string) => {
    const entry = Object.entries(state.semantic.entities).find(([, e]) =>
      e.binds.some((b) => b.targetType === "clip" && b.targetId === clipId),
    );
    return entry ? entry[1] : null;
  };

  /**
   * 拖拽 = 连续「无历史」应用 + 抬起时一次「有历史」应用：
   * 整个手势在撤销栈里只占一条，⌘Z 一步回到拖拽前。
   */
  const onClipPointerDown = (e: React.PointerEvent, clip: Clip, trackId: string) => {
    e.stopPropagation();
    selectClip(clip.id);
    const canvas = (e.currentTarget as HTMLElement).closest(".track-canvas") as HTMLElement | null;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const originX = e.clientX;
    const originalStart = clip.startUs;
    const originalEnd = clip.endUs;
    const edge = (e.target as HTMLElement).closest(".edge-handle")?.getAttribute("data-edge") ?? "move";
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    el.classList.add("dragging");

    let finalCmd: Parameters<typeof state.adapter.applyCommands>[0] | null = null;

    const move = (ev: PointerEvent) => {
      const rawDeltaUs = ((ev.clientX - originX) / rect.width / zoom) * durationUs;
      const deltaUs = state.snapEnabled ? Math.round(rawDeltaUs / SNAP_US) * SNAP_US : rawDeltaUs;
      if (edge === "move") {
        const start = Math.max(0, originalStart + deltaUs);
        const cmd = [moveClipCmd(clip.id, start, trackId)];
        state.adapter.applyCommands(cmd, { recordHistory: false });
        finalCmd = cmd;
      } else if (edge === "start") {
        const start = Math.max(0, Math.min(originalEnd - 1_000, originalStart + deltaUs));
        const cmd = [setClipRangeCmd(clip.id, { startUs: start })];
        state.adapter.applyCommands(cmd, { recordHistory: false });
        finalCmd = cmd;
      } else {
        const end = Math.min(durationUs, Math.max(originalStart + 1_000, originalEnd + deltaUs));
        const cmd = [setClipRangeCmd(clip.id, { endUs: end })];
        state.adapter.applyCommands(cmd, { recordHistory: false });
        finalCmd = cmd;
      }
    };
    const up = () => {
      el.classList.remove("dragging");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      if (finalCmd) {
        // 手势级历史：先把片段无历史地还原到手势前位置，
        // 再以记录模式应用到最终位置 —— 这样撤销一次就回到手势前。
        const restoreCmd =
          edge === "move"
            ? [moveClipCmd(clip.id, originalStart, trackId)]
            : edge === "start"
              ? [setClipRangeCmd(clip.id, { startUs: originalStart })]
              : [setClipRangeCmd(clip.id, { endUs: originalEnd })];
        state.adapter.applyCommands(restoreCmd, { recordHistory: false });
        state.adapter.applyCommands(finalCmd);
        autosave();
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const selectedClip = state.selectedClipId ? clipOf(project, state.selectedClipId) : null;
  const semanticRows = Object.values(state.semantic.entities).map((entity) => {
    const lifecycle = deriveLifecycle(entity, project);
    const clipIds = new Set(entity.binds.filter((bind) => bind.targetType === "clip").map((bind) => bind.targetId));
    const clips = project.tracks.flatMap((track) => track.clips).filter((clip) => clipIds.has(clip.id));
    return { entity, lifecycle, clips };
  });
  const playhead = pct(state.playheadUs);

  return (
    <section className="timeline panel">
      <div className="timeline-head">
        <div className="transport">
          <PanelGrip panel="timeline" />
          <button className="play-btn" onClick={togglePlay}>
            {state.playing ? "❚❚" : "▶"}
          </button>
          <span className="timecode">
            {formatTimecode(state.playheadUs)} / {formatTimecode(durationUs)}
          </span>
          {selectedClip && (
            <span className="selection-readout">
              已选择：{formatTimecode(selectedClip.startUs)}—{formatTimecode(selectedClip.endUs)} ·{" "}
              {entityOfClip(selectedClip.id)?.name ?? project.assets[selectedClip.assetId ?? ""]?.name ?? "片段"}
            </span>
          )}
        </div>
        <div className="timeline-tools">
          <div className="timeline-view">
            <button className={view === "edit" ? "active" : ""} onClick={() => setView("edit")}>
              基础剪辑
            </button>
            <button className={view === "semantic" ? "active" : ""} onClick={() => setView("semantic")}>
              语义编排
            </button>
          </div>
          <button
            className={`secondary-btn ${state.snapEnabled ? "active" : ""}`}
            title="时间线吸附 0.5s"
            onClick={toggleSnap}
          >
            ⌁ 吸附 0.5s
          </button>
          <button
            className={`secondary-btn ${state.selectedClipId && hasKeyframeAtPlayhead(state.selectedClipId) ? "active" : ""}`}
            title="在播放头处给所选片段标记/删除关键帧"
            disabled={!state.selectedClipId}
            onClick={() => state.selectedClipId && toggleKeyframe(state.selectedClipId)}
          >
            ◆ 关键帧
          </button>
          <button className="secondary-btn" title="缩小时间线" onClick={() => setZoom((z) => Math.max(1, z - 1))}>
            −
          </button>
          <button className="secondary-btn" title="放大时间线" onClick={() => setZoom((z) => Math.min(3, z + 1))}>
            ＋
          </button>
          <button className="secondary-btn" onClick={() => setPlayhead(state.playheadUs + 1_000_000)}>
            下一秒
          </button>
        </div>
      </div>
      <div className="timeline-body">
        <div className="ruler-row">
          <div className="track-label">时间</div>
          <div
            className="track-canvas"
            ref={rulerRef}
            style={{ minWidth: `${zoom * 100}%` }}
            onPointerDown={(e) => {
              scrub(e.clientX);
              const move = (ev: PointerEvent) => scrub(ev.clientX);
              const up = () => {
                e.currentTarget.removeEventListener("pointermove", move);
                e.currentTarget.removeEventListener("pointerup", up);
              };
              e.currentTarget.addEventListener("pointermove", move);
              e.currentTarget.addEventListener("pointerup", up);
            }}
          >
            {[0, 3, 6, 9, 12, 15].map((s) => (
              <span key={s} className="tick" style={{ left: `${(s / 15) * zoom * 100}%` }}>
                {s}s
              </span>
            ))}
            <div className="playhead" style={{ left: playhead }} />
          </div>
        </div>

        {project.tracks.map((track) => (
          <div className="track-row" key={track.id}>
            <div className="track-label">
              <b>{TRACK_GLYPHS[track.kind] ?? "•"}</b> {track.name}
            </div>
            <div className="track-canvas" style={{ minWidth: `${zoom * 100}%` }}>
              {track.clips.map((clip) => {
                const entity = entityOfClip(clip.id);
                const selected = state.selectedClipId === clip.id;
                const thumb = clip.assetId ? project.assets[clip.assetId]?.meta?.thumb : null;
                const keyframes = (Array.isArray(clip.attrs.keyframes) ? (clip.attrs.keyframes as Keyframe[]) : []) as Keyframe[];
                const span = clip.endUs - clip.startUs;
                return (
                  <div
                    key={clip.id}
                    className={`timeline-clip dragable ${selected ? "selected" : ""} ${track.kind === "audio" ? "audio" : ""} ${thumb ? "has-thumb" : ""}`}
                    style={{
                      left: pct(clip.startUs),
                      width: pct(clip.endUs - clip.startUs),
                      ...(thumb ? { backgroundImage: `linear-gradient(rgba(10,12,22,.55), rgba(10,12,22,.55)), url(${thumb})` } : {}),
                    }}
                    data-clip-id={clip.id}
                    onPointerDown={(e) => onClipPointerDown(e, clip, track.id)}
                    title={`${formatTimecode(clip.startUs)}—${formatTimecode(clip.endUs)}${entity ? ` · ${entity.name}` : ""}`}
                  >
                    <span className="entry-label">{(clip.startUs / 1e6).toFixed(1)}s</span>
                    <span className="clip-name">
                      {entity?.name ?? project.assets[clip.assetId ?? ""]?.name ?? (clip.attrs.text ? String(clip.attrs.text) : "片段")}
                    </span>
                    {keyframes.map((k, i) => (
                      <button
                        key={i}
                        className="keyframe-marker"
                        style={{ left: `${(k.tUs / span) * 100}%` }}
                        title={`关键帧 @${(k.tUs / 1e6).toFixed(1)}s（点击跳转）`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPlayhead(clip.startUs + k.tUs);
                        }}
                        onPointerDown={(e) => e.stopPropagation()}
                      >
                        ◆
                      </button>
                    ))}
                    <span className="edge-handle in" data-edge="start" />
                    <span className="edge-handle out" data-edge="end" />
                    <span className="exit-label">{(clip.endUs / 1e6).toFixed(1)}s</span>
                  </div>
                );
              })}
              <div className="playhead" style={{ left: playhead }} />
            </div>
          </div>
        ))}

        {view === "semantic" &&
          semanticRows.map(({ entity, lifecycle, clips }) => (
            <div className="track-row semantic-track" key={entity.id}>
              <div className="track-label">
                <b>◎</b>
                <span>{entity.name}</span>
                <small>
                  {(lifecycle.enterUs / 1e6).toFixed(1)}s—{(lifecycle.exitUs / 1e6).toFixed(1)}s
                </small>
              </div>
              <div className="track-canvas" style={{ minWidth: `${zoom * 100}%` }} onPointerDown={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setPlayhead(((e.clientX - rect.left) / rect.width / zoom) * durationUs);
              }}>
                <div
                  className="semantic-clip"
                  style={{ left: pct(lifecycle.enterUs), width: pct(lifecycle.exitUs - lifecycle.enterUs) }}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (clips[0]) selectClip(clips[0].id);
                  }}
                >
                  <span className="clip-name">{entity.reference ?? entity.name}</span>
                  <span className="entry-label">进场 {(lifecycle.enterUs / 1e6).toFixed(1)}s</span>
                  <span className="exit-label">出场 {(lifecycle.exitUs / 1e6).toFixed(1)}s</span>
                </div>
                <div className="playhead" style={{ left: playhead }} />
              </div>
            </div>
          ))}
      </div>
      <div className="transcript">
        <div className="transcript-label">语义定位</div>
        {TRANSCRIPT.map((chip) => (
          <button
            key={chip.time}
            className={`transcript-chip ${Math.abs(state.playheadUs / 1e6 - chip.time) < 0.5 ? "active" : ""}`}
            onClick={() => setPlayhead(chip.time * 1_000_000)}
          >
            <b>{chip.time.toFixed(1)}</b>
            {chip.label}
          </button>
        ))}
      </div>
    </section>
  );
}
