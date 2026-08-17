import { nanoid } from "nanoid";
import type { TimeUs } from "./time";

export type AssetId = string;
export type ClipId = string;
export type TrackId = string;

export type MediaKind = "video" | "image" | "audio";
export type TrackKind = "video" | "audio" | "text";

/**
 * 项目文档 —— 剪辑的真实事实源（OpenCut 项目数据即实际剪辑状态）。
 * 语义状态（Video Spec）不在这里，通过稳定 ID 由 spec 层映射。
 */
export interface Project {
  id: string;
  name: string;
  /** 文档修订号：每次命令批次应用 +1，作为回滚点/版本标识 */
  revision: number;
  settings: ProjectSettings;
  assets: Record<AssetId, MediaAsset>;
  tracks: Track[];
}

export interface ProjectSettings {
  fps: number;
  width: number;
  height: number;
  /** 项目总时长（µs） */
  durationUs: TimeUs;
}

export interface MediaAsset {
  id: AssetId;
  kind: MediaKind;
  name: string;
  /** 素材原始时长（µs）；image 为 0 */
  durationUs: TimeUs;
  width?: number;
  height?: number;
  /** 运行时 blob 引用（objectURL）；持久化时只保留 id，由资产库恢复 */
  url?: string;
}

export interface Track {
  id: TrackId;
  kind: TrackKind;
  name: string;
  locked: boolean;
  clips: Clip[];
}

export interface ClipAttrs {
  /** text 轨道：文字内容与样式 */
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  /** 画面元素布局（相对画布，0–1） */
  x?: number;
  y?: number;
  scale?: number;
  opacity?: number;
  /** 语义外观（由 harness/AI 写），如 { variant: "matte_silver", color: "deep_blue" } */
  appearance?: Record<string, string | number | boolean>;
  [key: string]: unknown;
}

export interface Clip {
  id: ClipId;
  /** null = 生成类（text 轨道文字卡） */
  assetId: AssetId | null;
  /** 时间线入点/出点（µs，出点不含） */
  startUs: TimeUs;
  endUs: TimeUs;
  /** 素材内入点（µs）；出点 = sourceInUs + (endUs - startUs) */
  sourceInUs: TimeUs;
  attrs: ClipAttrs;
  /** 自由扩展元数据（UI 注释等）；语义绑定在 spec 层，不落这里 */
  meta?: Record<string, unknown>;
}

// ---------- 工厂 ----------

export function createProject(opts: {
  name?: string;
  fps?: number;
  width?: number;
  height?: number;
  durationUs?: TimeUs;
}): Project {
  return {
    id: nanoid(12),
    name: opts.name ?? "未命名项目",
    revision: 0,
    settings: {
      fps: opts.fps ?? 30,
      width: opts.width ?? 1080,
      height: opts.height ?? 1920,
      durationUs: opts.durationUs ?? 15_000_000,
    },
    assets: {},
    tracks: [
      { id: nanoid(8), kind: "video", name: "画面", locked: false, clips: [] },
      { id: nanoid(8), kind: "text", name: "文字", locked: false, clips: [] },
      { id: nanoid(8), kind: "audio", name: "音乐", locked: false, clips: [] },
    ],
  };
}

export function createClip(partial: {
  assetId: AssetId | null;
  startUs: TimeUs;
  endUs: TimeUs;
  sourceInUs?: TimeUs;
  attrs?: ClipAttrs;
}): Clip {
  return {
    id: nanoid(10),
    assetId: partial.assetId,
    startUs: partial.startUs,
    endUs: partial.endUs,
    sourceInUs: partial.sourceInUs ?? 0,
    attrs: partial.attrs ?? {},
  };
}

export function cloneClip(clip: Clip, id = nanoid(10)): Clip {
  return {
    ...clip,
    id,
    attrs: { ...clip.attrs, appearance: { ...clip.appearance } },
    meta: clip.meta ? { ...clip.meta } : undefined,
  };
}

// ---------- 查询 ----------

export function findTrack(project: Project, trackId: TrackId): Track | undefined {
  return project.tracks.find((t) => t.id === trackId);
}

export function findClip(project: Project, clipId: ClipId): { track: Track; clip: Clip } | undefined {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return undefined;
}

export function findAsset(project: Project, assetId: AssetId): MediaAsset | undefined {
  return project.assets[assetId];
}

export function clipDurationUs(clip: Clip): TimeUs {
  return clip.endUs - clip.startUs;
}

/** 剪辑不变量校验；违规抛 Error（含具体描述） */
export function assertProjectValid(project: Project): void {
  const seenClip = new Set<ClipId>();
  const seenTrack = new Set<TrackId>();
  const seenAsset = new Set<AssetId>();
  for (const [assetId, asset] of Object.entries(project.assets)) {
    if (seenAsset.has(assetId)) throw new Error(`asset id 重复: ${assetId}`);
    seenAsset.add(assetId);
    if (asset.durationUs < 0) throw new Error(`asset ${assetId} 时长非法`);
  }
  for (const track of project.tracks) {
    if (seenTrack.has(track.id)) throw new Error(`track id 重复: ${track.id}`);
    seenTrack.add(track.id);
    for (const clip of track.clips) {
      if (seenClip.has(clip.id)) throw new Error(`clip id 重复: ${clip.id}`);
      seenClip.add(clip.id);
      if (clip.endUs <= clip.startUs) throw new Error(`clip ${clip.id} 区间非法: [${clip.startUs}, ${clip.endUs}]`);
      if (clip.sourceInUs < 0) throw new Error(`clip ${clip.id} 素材入点非法`);
      if (clip.assetId !== null) {
        const asset = project.assets[clip.assetId];
        if (!asset) throw new Error(`clip ${clip.id} 引用了不存在的 asset ${clip.assetId}`);
        const kindOk =
          track.kind === "audio" ? asset.kind === "audio" : asset.kind === "video" || asset.kind === "image";
        if (!kindOk) throw new Error(`clip ${clip.id}: ${asset.kind} 资产不能放入 ${track.kind} 轨道`);
        if (asset.kind !== "image" && clip.sourceInUs + clipDurationUs(clip) > asset.durationUs + 1) {
          throw new Error(`clip ${clip.id} 超出素材时长: ${clip.sourceInUs + clipDurationUs(clip)} > ${asset.durationUs}`);
        }
      } else if (track.kind !== "text") {
        throw new Error(`clip ${clip.id} 无素材但不在 text 轨道`);
      }
    }
  }
}
