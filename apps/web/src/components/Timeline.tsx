import type { PointerEvent as ReactPointerEvent } from "react";
import { useState } from "react";
import { formatTimecode, type Clip, type Track } from "@cassie/editor-core";
import { deriveLifecycle } from "@cassie/spec";
import { selectClip, setPlayhead, togglePlay, useAppState } from "../store";

const pct = (value: number, duration: number) => `${Math.max(0, Math.min(100, (value / duration) * 100))}%`;

function ClipBlock({ clip, durationUs, selected, onSelect }: { clip: Clip; durationUs: number; selected: boolean; onSelect: () => void }) {
  return <button className={`timeline-clip ${selected ? "selected" : ""}`} style={{ left: pct(clip.startUs, durationUs), width: pct(clip.endUs - clip.startUs, durationUs) }} onClick={(event) => { event.stopPropagation(); onSelect(); }} title={`${formatTimecode(clip.startUs)}—${formatTimecode(clip.endUs)}`}>
    <span>{clip.attrs.text ? String(clip.attrs.text) : clip.id.slice(-8)}</span>
  </button>;
}

function TrackRow({ track, durationUs, selectedClipId, onScrub }: { track: Track; durationUs: number; selectedClipId: string | null; onScrub: (event: ReactPointerEvent<HTMLDivElement>) => void }) {
  return <div className="track-row" data-track={track.id}>
    <div className="track-label"><b>{track.kind === "video" ? "V" : track.kind === "audio" ? "A" : "T"}</b><span>{track.name}</span><small>{track.locked ? "▣" : ""}</small></div>
    <div className="track-canvas" onPointerDown={onScrub}>{track.clips.map((clip) => <ClipBlock key={clip.id} clip={clip} durationUs={durationUs} selected={selectedClipId === clip.id} onSelect={() => selectClip(clip.id)} />)}</div>
  </div>;
}

export function Timeline() {
  const state = useAppState();
  const [view, setView] = useState<"edit" | "semantic">("semantic");
  const project = state.adapter.getProject();
  const durationUs = project.settings.durationUs;
  const scrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setPlayhead(Math.round(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * durationUs));
  };
  const semanticRows = Object.values(state.semantic.entities).map((entity) => {
    const lifecycle = deriveLifecycle(entity, project);
    const clipIds = new Set(entity.binds.filter((bind) => bind.targetType === "clip").map((bind) => bind.targetId));
    const clips = project.tracks.flatMap((track) => track.clips).filter((clip) => clipIds.has(clip.id));
    return { entity, lifecycle, clips };
  });
  const playhead = pct(state.playheadUs, durationUs);

  return <section className="timeline panel">
    <div className="timeline-head">
      <div className="transport"><button className="play-btn" onClick={togglePlay}>{state.playing ? "❚❚" : "▶"}</button><span className="timecode">{formatTimecode(state.playheadUs)} / {formatTimecode(durationUs)}</span><span className="selection-readout">{state.selectedClipId ? `已选择：${state.selectedClipId.slice(-8)}` : "点击片段选择"}</span></div>
      <div className="timeline-tools"><div className="timeline-view"><button className={view === "edit" ? "active" : ""} onClick={() => setView("edit")}>基础剪辑</button><button className={view === "semantic" ? "active" : ""} onClick={() => setView("semantic")}>语义编排</button></div><button className="secondary-btn" onClick={() => setPlayhead(state.playheadUs + 1_000_000)}>下一秒</button></div>
    </div>
    <div className="timeline-body">
      <div className="ruler-row"><div className="track-label">时间</div><div className="track-canvas" onPointerDown={scrub}>{[0, 3, 6, 9, 12, 15].map((second) => <span key={second} className="tick" style={{ left: `${(second / 15) * 100}%` }}>{second}s</span>)}<div className="playhead" style={{ left: playhead }} /></div></div>
      {view === "edit" && project.tracks.map((track) => <TrackRow key={track.id} track={track} durationUs={durationUs} selectedClipId={state.selectedClipId} onScrub={scrub} />)}
      {view === "semantic" && <>
        {project.tracks.map((track) => <TrackRow key={track.id} track={track} durationUs={durationUs} selectedClipId={state.selectedClipId} onScrub={scrub} />)}
        {semanticRows.map(({ entity, lifecycle, clips }) => <div className="track-row semantic-track" key={entity.id}><div className="track-label"><b>◎</b><span>{entity.name}</span><small>{fmt(lifecycle.enterUs)}—{fmt(lifecycle.exitUs)}</small></div><div className="track-canvas" onPointerDown={scrub}><div className="semantic-clip" style={{ left: pct(lifecycle.enterUs, durationUs), width: pct(lifecycle.exitUs - lifecycle.enterUs, durationUs) }} onClick={(event) => { event.stopPropagation(); if (clips[0]) selectClip(clips[0].id); }}><span className="clip-name">{entity.reference ?? entity.name}</span><span className="entry-label">进场 {fmt(lifecycle.enterUs)}</span><span className="exit-label">出场 {fmt(lifecycle.exitUs)}</span></div><div className="playhead" style={{ left: playhead }} /></div></div>)}
      </>}
    </div>
    <div className="transcript"><div className="transcript-label">语义定位</div>{[1, 5, 8, 10.5, 13].map((second) => <button key={second} className="transcript-chip" onClick={() => setPlayhead(Math.round(second * 1_000_000))}><b>{second.toFixed(1)}</b>{second < 4 ? "人物进入巴黎夜景" : second < 8 ? "拿出香水" : second < 10 ? "商品第一次清晰露出" : second < 12 ? "音乐卡点 · 产品特写" : "品牌文案出现"}</button>)}</div>
  </section>;
}

function fmt(us: number): string {
  return `${(us / 1_000_000).toFixed(1)}s`;
}
