import {
  assertProjectValid,
  cloneClip,
  findClip,
  findTrack,
  type Clip,
  type ClipAttrs,
  type ClipId,
  type Project,
  type TrackId,
} from "./project";
import type { TimeUs } from "./time";

/**
 * 命令即数据。所有修改编译为可序列化、可撤销的 EditorCommand。
 * 执行是纯函数：applyCommand(project, cmd) → { project, inverse }，
 * 逆命令由执行时捕获的真实旧值精确重建 —— undo = 执行 inverse，redo 免费。
 */
export type EditorCommand =
  | SplitClipCommand
  | TrimClipCommand
  | MoveClipCommand
  | ReplaceMediaCommand
  | SetClipAssetCommand
  | SetClipRangeCommand
  | SetClipAttrsCommand
  | AddClipCommand
  | RemoveClipCommand
  | CompositeCommand;

export interface SplitClipCommand {
  kind: "splitClip";
  clipId: ClipId;
  /** 切点（µs），必须严格落在 clip 区间内部 */
  atUs: TimeUs;
}
export interface TrimClipCommand {
  kind: "trimClip";
  clipId: ClipId;
  edge: "start" | "end";
  /** 正值向内收，负值向外扩（自动夹取到合法边界：素材范围、时间线 0 点、最小 1ms） */
  deltaUs: TimeUs;
}
export interface MoveClipCommand {
  kind: "moveClip";
  clipId: ClipId;
  /** 目标轨道；省略 = 原轨道 */
  trackId?: TrackId;
  /** 新的时间线入点（µs，≥ 0） */
  newStartUs: TimeUs;
}
export interface ReplaceMediaCommand {
  kind: "replaceMedia";
  clipId: ClipId;
  assetId: string;
  /** keepHead: 素材入点不变，时间线时长夹取到新素材可用范围；
   *  stretch: 时间线区间不变，素材入点归零。默认 keepHead */
  fit?: "keepHead" | "stretch";
}
export interface SetClipAssetCommand {
  kind: "setClipAsset";
  clipId: ClipId;
  /** null = 无素材（文字卡） */
  assetId: string | null;
}
export interface SetClipRangeCommand {
  kind: "setClipRange";
  clipId: ClipId;
  /** 时间线入点/出点/素材入点；任一省略 = 保持原值 */
  startUs?: TimeUs;
  endUs?: TimeUs;
  sourceInUs?: TimeUs;
}
export interface SetClipAttrsCommand {
  kind: "setClipAttrs";
  clipId: ClipId;
  attrs: ClipAttrs;
  /** true = 替换整个 attrs；默认浅合并 */
  replace?: boolean;
}
export interface AddClipCommand {
  kind: "addClip";
  trackId: TrackId;
  clip: Clip;
  /** 插入位置索引（省略 = 追加） */
  index?: number;
}
export interface RemoveClipCommand {
  kind: "removeClip";
  clipId: ClipId;
}
export interface CompositeCommand {
  kind: "composite";
  commands: EditorCommand[];
}

export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}

/** 定位 clip 所在轨道与索引 */
function locate(project: Project, clipId: ClipId): { track: Track; index: number; clip: Clip } {
  for (const track of project.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, index, clip: track.clips[index]! };
  }
  throw new CommandError(`clip 不存在: ${clipId}`);
}

// ---------- 执行（纯函数） ----------

export interface ApplyResult {
  project: Project;
  inverse: EditorCommand;
}

export function applyCommand(project: Project, cmd: EditorCommand): ApplyResult {
  const next = structuredClone(project);
  const inverse = executeInPlace(next, cmd);
  assertProjectValid(next);
  return { project: next, inverse };
}

/** 在克隆上原地执行并返回精确逆命令（内部） */
function executeInPlace(project: Project, cmd: EditorCommand): EditorCommand {
  switch (cmd.kind) {
    case "composite": {
      const inverses: EditorCommand[] = [];
      for (const sub of cmd.commands) inverses.unshift(executeInPlace(project, sub));
      return { kind: "composite", commands: inverses };
    }

    case "splitClip": {
      const { track, index, clip } = locate(project, cmd.clipId);
      if (cmd.atUs <= clip.startUs || cmd.atUs >= clip.endUs) {
        throw new CommandError(`切点 ${cmd.atUs} 不在 clip [${clip.startUs}, ${clip.endUs}] 内部`);
      }
      const headLen = cmd.atUs - clip.startUs;
      const head = { ...clip, endUs: cmd.atUs }; // 头部保留原 id（语义绑定跟随头部）
      const tail = {
        ...cloneClip(clip),
        startUs: cmd.atUs,
        sourceInUs: clip.sourceInUs + headLen,
      };
      track.clips.splice(index, 1, head, tail);
      return {
        kind: "composite",
        commands: [
          { kind: "removeClip", clipId: tail.id },
          {
            kind: "setClipRange",
            clipId: clip.id,
            startUs: clip.startUs,
            endUs: clip.endUs,
            sourceInUs: clip.sourceInUs,
          },
        ],
      };
    }

    case "trimClip": {
      const { track, index, clip } = locate(project, cmd.clipId);
      const old = { startUs: clip.startUs, endUs: clip.endUs, sourceInUs: clip.sourceInUs };
      const span = clip.endUs - clip.startUs;
      const MIN_SPAN = 1_000; // 最小 1ms
      let { startUs, endUs, sourceInUs } = clip;
      if (cmd.edge === "start") {
        const maxTrim = span - MIN_SPAN;
        const asset = clip.assetId !== null ? project.assets[clip.assetId] : undefined;
        const maxExtend = asset && asset.kind !== "image" ? Math.min(sourceInUs, startUs) : Math.min(sourceInUs, startUs);
        const d = Math.max(-maxExtend, Math.min(cmd.deltaUs, maxTrim));
        startUs += d;
        sourceInUs += d;
      } else {
        const maxTrim = span - MIN_SPAN;
        const asset = clip.assetId !== null ? project.assets[clip.assetId] : undefined;
        const maxExtend =
          !asset || asset.kind === "image"
            ? Number.POSITIVE_INFINITY
            : Math.max(0, asset.durationUs - (sourceInUs + span));
        const d = Math.max(-maxExtend, Math.min(cmd.deltaUs, maxTrim));
        endUs -= d;
      }
      track.clips[index] = { ...clip, startUs, endUs, sourceInUs };
      return {
        kind: "setClipRange",
        clipId: clip.id,
        startUs: old.startUs,
        endUs: old.endUs,
        sourceInUs: old.sourceInUs,
      };
    }

    case "moveClip": {
      const { track, index, clip } = locate(project, cmd.clipId);
      if (cmd.newStartUs < 0) throw new CommandError(`入点不能为负: ${cmd.newStartUs}`);
      const oldTrackId = track.id;
      const oldStartUs = clip.startUs;
      const target = cmd.trackId ? findTrack(project, cmd.trackId) : track;
      if (!target) throw new CommandError(`轨道不存在: ${cmd.trackId}`);
      const span = clip.endUs - clip.startUs;
      const moved = { ...clip, startUs: cmd.newStartUs, endUs: cmd.newStartUs + span };
      if (target.id === track.id) {
        track.clips[index] = moved;
      } else {
        track.clips.splice(index, 1);
        target.clips.push(moved);
      }
      return { kind: "moveClip", clipId: clip.id, trackId: oldTrackId, newStartUs: oldStartUs };
    }

    case "replaceMedia": {
      const { track, index, clip } = locate(project, cmd.clipId);
      const asset = project.assets[cmd.assetId];
      if (!asset) throw new CommandError(`资产不存在: ${cmd.assetId}`);
      const old = { assetId: clip.assetId, startUs: clip.startUs, endUs: clip.endUs, sourceInUs: clip.sourceInUs };
      const span = clip.endUs - clip.startUs;
      if (cmd.fit === "stretch" || asset.kind === "image" || asset.kind === "audio") {
        track.clips[index] = { ...clip, assetId: cmd.assetId, sourceInUs: 0 };
      } else {
        const available = asset.durationUs - clip.sourceInUs;
        if (available <= 0) throw new CommandError(`新素材「${asset.name}」在入点 ${clip.sourceInUs} 后无可用时长`);
        const newSpan = Math.min(span, available);
        track.clips[index] = { ...clip, assetId: cmd.assetId, endUs: clip.startUs + newSpan };
      }
      return {
        kind: "composite",
        commands: [
          {
            kind: "setClipRange",
            clipId: clip.id,
            startUs: old.startUs,
            endUs: old.endUs,
            sourceInUs: old.sourceInUs,
          },
          { kind: "setClipAsset", clipId: clip.id, assetId: old.assetId },
        ],
      };
    }

    case "setClipAsset": {
      const { track, index, clip } = locate(project, cmd.clipId);
      const old = clip.assetId;
      track.clips[index] = { ...clip, assetId: cmd.assetId };
      return { kind: "setClipAsset", clipId: clip.id, assetId: old };
    }

    case "setClipRange": {
      const { track, index, clip } = locate(project, cmd.clipId);
      const old = { startUs: clip.startUs, endUs: clip.endUs, sourceInUs: clip.sourceInUs };
      const startUs = cmd.startUs ?? clip.startUs;
      const endUs = cmd.endUs ?? clip.endUs;
      const sourceInUs = cmd.sourceInUs ?? clip.sourceInUs;
      if (endUs <= startUs) throw new CommandError(`区间非法: [${startUs}, ${endUs}]`);
      if (startUs < 0 || sourceInUs < 0) throw new CommandError(`入点不能为负`);
      track.clips[index] = { ...clip, startUs, endUs, sourceInUs };
      return {
        kind: "setClipRange",
        clipId: clip.id,
        startUs: old.startUs,
        endUs: old.endUs,
        sourceInUs: old.sourceInUs,
      };
    }

    case "setClipAttrs": {
      const { track, index, clip } = locate(project, cmd.clipId);
      const old = clip.attrs;
      const nextAttrs = cmd.replace ? structuredClone(cmd.attrs) : deepMerge(clip.attrs, cmd.attrs);
      track.clips[index] = { ...clip, attrs: nextAttrs };
      return { kind: "setClipAttrs", clipId: clip.id, attrs: structuredClone(old), replace: true };
    }

    case "addClip": {
      const track = findTrack(project, cmd.trackId);
      if (!track) throw new CommandError(`轨道不存在: ${cmd.trackId}`);
      const clip = structuredClone(cmd.clip);
      const at = cmd.index ?? track.clips.length;
      track.clips.splice(at, 0, clip);
      return { kind: "removeClip", clipId: clip.id };
    }

    case "removeClip": {
      const { track, index } = locate(project, cmd.clipId);
      const [removed] = track.clips.splice(index, 1);
      return { kind: "addClip", trackId: track.id, clip: structuredClone(removed!), index };
    }
  }
}

function deepMerge(base: ClipAttrs, patch: ClipAttrs): ClipAttrs {
  const out: ClipAttrs = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const bv = out[k];
    if (bv && v && typeof bv === "object" && typeof v === "object" && !Array.isArray(bv) && !Array.isArray(v)) {
      out[k] = { ...bv, ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 在克隆上预演，不改变输入；用于批量事务的原子校验 */
export function dryRun(project: Project, commands: EditorCommand[]): Project {
  let cur = structuredClone(project);
  for (const cmd of commands) cur = applyCommand(cur, cmd).project;
  return cur;
}

// ---------- 高层命令构造（Harness 与 UI 共用的编译目标） ----------

export function splitClipCmd(clipId: ClipId, atUs: TimeUs): SplitClipCommand {
  return { kind: "splitClip", clipId, atUs };
}
export function trimClipCmd(clipId: ClipId, edge: "start" | "end", deltaUs: TimeUs): TrimClipCommand {
  return { kind: "trimClip", clipId, edge, deltaUs };
}
export function moveClipCmd(clipId: ClipId, newStartUs: TimeUs, trackId?: TrackId): MoveClipCommand {
  return { kind: "moveClip", clipId, trackId, newStartUs };
}
export function replaceMediaCmd(clipId: ClipId, assetId: string, fit?: "keepHead" | "stretch"): ReplaceMediaCommand {
  return { kind: "replaceMedia", clipId, assetId, fit };
}
export function setClipRangeCmd(
  clipId: ClipId,
  range: { startUs?: TimeUs; endUs?: TimeUs; sourceInUs?: TimeUs },
): SetClipRangeCommand {
  return { kind: "setClipRange", clipId, ...range };
}
export function setClipAttrsCmd(clipId: ClipId, attrs: ClipAttrs, replace = false): SetClipAttrsCommand {
  return { kind: "setClipAttrs", clipId, attrs, replace };
}
export function compositeCmd(commands: EditorCommand[]): CompositeCommand {
  return { kind: "composite", commands };
}
