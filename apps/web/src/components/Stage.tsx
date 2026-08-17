import { useEffect, useRef, useState } from "react";
import { appearanceToCssFilter, deleteSelectedClip, selectClip, splitAtPlayhead, useAppState } from "../store";

/**
 * 舞台：真实视频预览（video element 按播放头 seek）+ 文字叠加层 + 外观滤镜。
 * 顶部视频轨道 clip 是当前可见画面；appearance 属性实时映射为 CSS 滤镜。
 */
export function Stage() {
  const state = useAppState();
  const project = state.adapter.getProject();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [hoverLabel, setHoverLabel] = useState<string | null>(null);

  const videoTracks = project.tracks.filter((t) => t.kind === "video");
  const textTracks = project.tracks.filter((t) => t.kind === "text");

  // 当前播放头处的可见 clip（视频轨按序，最后的在上层）
  let topClip = null as { trackId: string; clipId: string } | null;
  for (const track of videoTracks) {
    for (const clip of track.clips) {
      if (clip.startUs <= state.playheadUs && clip.endUs > state.playheadUs) {
        topClip = { trackId: track.id, clipId: clip.id };
      }
    }
  }
  const topVideoClip = topClip
    ? videoTracks.flatMap((t) => t.clips).find((c) => c.id === topClip!.clipId)
    : null;
  const topAsset = topVideoClip?.assetId ? project.assets[topVideoClip.assetId] : null;

  // 视频 seek 同步
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !topAsset || topAsset.kind !== "video" || !topAsset.url || !topVideoClip) {
      if (video && !video.paused) video.pause();
      return;
    }
    const target = (topVideoClip.sourceInUs + (state.playheadUs - topVideoClip.startUs)) / 1e6;
    const drift = Math.abs(video.currentTime - target);
    if (drift > 0.12) {
      video.currentTime = target;
    } else if (!state.playing && !video.paused) {
      video.pause();
    }
    if (state.playing && video.paused) void video.play().catch(() => undefined);
    if (!state.playing && !video.paused) video.pause();
    // src 归一化比较，避免每次渲染重置播放
    const currentPath = new URL(video.src, location.href).pathname;
    const targetPath = new URL(topAsset.url, location.href).pathname;
    if (currentPath !== targetPath) {
      video.src = topAsset.url;
    }
  });

  const activeTextClips = textTracks
    .flatMap((t) => t.clips.map((c) => ({ track: t, clip: c })))
    .filter(({ clip }) => clip.startUs <= state.playheadUs && clip.endUs > state.playheadUs);

  const selectedClip = state.selectedClipId
    ? project.tracks.flatMap((t) => t.clips).find((c) => c.id === state.selectedClipId)
    : null;

  const filter = topVideoClip ? appearanceToCssFilter(topVideoClip.attrs) : "none";
  const shotLabel =
    state.playheadUs < 4_000_000 ? "镜头 01 · 进入夜景" : state.playheadUs < 10_000_000 ? "镜头 02 · 展示商品" : "镜头 03 · Hero Packshot";

  return (
    <section className="stage-panel">
      <div className="stage-toolbar">
        <div className="tool-group">
          <button className="tool-btn active" title="选择">
            ↖ 选择
          </button>
          <button className="tool-btn" title="在时间线中操作">
            ⌁ 吸附 0.5s
          </button>
          <button className="tool-btn" title="删除所选片段" onClick={deleteSelectedClip}>
            ⌫ 删除
          </button>
          <button className="tool-btn" title="在播放头切分所选片段" onClick={splitAtPlayhead}>
            ✂ 切分
          </button>
        </div>
        <div className="tool-group">
          <span className="zoom">适应画布 · 9:16</span>
          <button className="tool-btn">⌗ 安全框</button>
        </div>
      </div>
      <div className="stage-workspace">
        <div className="video-wrap">
          {selectedClip && (
            <div className="selection-toolbar visible">
              <span className="selection-name">
                {project.assets[selectedClip.assetId ?? ""]?.name ?? "文字卡"}
              </span>
            </div>
          )}
          <div
            className="video-frame"
            onMouseLeave={() => setHoverLabel(null)}
          >
            <video
              ref={videoRef}
              className="stage-video"
              muted
              playsInline
              style={{ filter }}
              onMouseEnter={() => topVideoClip && setHoverLabel(topVideoClip.id)}
            />
            {activeTextClips.map(({ clip }) => (
              <div
                key={clip.id}
                className="stage-text-overlay"
                style={{
                  left: `${((clip.attrs.x ?? 0.5) as number) * 100}%`,
                  top: `${((clip.attrs.y ?? 0.5) as number) * 100}%`,
                  fontSize: `${((clip.attrs.fontSize ?? 48) as number) / 10.8}cqw`,
                  color: (clip.attrs.color as string) ?? "#fff",
                  opacity: ((clip.attrs.opacity ?? 1) as number),
                }}
              >
                {(clip.attrs.text as string) ?? ""}
              </div>
            ))}
            {topVideoClip && (
              <button
                className={`canvas-object frame-chip ${state.selectedClipId === topVideoClip.id ? "selected" : ""}`}
                onClick={() => selectClip(topVideoClip.id)}
              >
                {topVideoClip.id.slice(-6)}
              </button>
            )}
            <div className="safe-frame" />
            <div className="frame-info">
              <span>{shotLabel}</span>
              <span id="frameTime">
                {(state.playheadUs / 1e6).toFixed(1)}s
              </span>
            </div>
            {hoverLabel && <div className="hover-label">clip · {hoverLabel.slice(-8)}</div>}
          </div>
        </div>
      </div>
    </section>
  );
}
