import type { EditorCommand, Project, TimeUs, TrackId } from "@cassie/editor-core";
import {
  boundClips,
  checkConstraints,
  deriveLifecycle,
  relatedEntities,
  type ConstraintViolation,
  type EntityId,
  type Lifecycle,
  type SemanticProject,
} from "@cassie/spec";
import type { Intent, Scope } from "./intent";
import type { HarnessState } from "./states";

/**
 * EditTransaction —— 一次语义修改的完整持久化记录。
 * 计划书要求持久化：用户原始意图 / 主体与生命周期 / 修改前版本 / 受影响元素 /
 * 锁定约束 / 生成任务 / Editor Commands / 验证结果 / 最终版本与回滚点。
 */
export interface EditTransaction {
  id: string;
  status: HarnessState;
  intent: Intent;
  subjectId: EntityId | null;
  lifecycleBefore: Lifecycle | null;
  lifecycleAfter: Lifecycle | null;
  impact: ImpactReport;
  guards: ConstraintViolation[];
  commands: EditorCommand[];
  /** 修改前项目版本（回滚点） */
  baseRevision: number;
  /** 提交后项目版本 */
  committedRevision: number | null;
  validation: ValidationReport | null;
  error: string | null;
  stateLog: { state: HarnessState; atUs: number }[];
}

export interface ValidationReport {
  passed: boolean;
  checks: { name: string; passed: boolean; detail: string }[];
}

export interface ImpactRow {
  kind: "主状态" | "关系" | "构图" | "保护";
  copy: string;
  tag: "CHANGE" | "RECHECK" | "REFLOW" | "LOCK";
}

export interface ImpactReport {
  rows: ImpactRow[];
  affectedEntities: EntityId[];
  affectedClipIds: string[];
  affectedTracks: TrackId[];
}

// ---------- 影响分析（IMPACTED 阶段，纯函数） ----------

export function analyzeImpact(
  semantic: SemanticProject,
  project: Project,
  subjectId: EntityId,
  scope: Scope,
  fromUs?: TimeUs,
): ImpactReport {
  const entity = semantic.entities[subjectId];
  if (!entity) throw new Error(`实体不存在: ${subjectId}`);
  const lifecycle = deriveLifecycle(entity, project);
  const allClips = boundClips(entity, project);
  const affectedClipIds = new Set(allClips.map((c) => c.id));
  const affectedEntities = new Set<EntityId>([subjectId]);
  const affectedTracks = new Set<TrackId>();
  const w0 = lifecycle.enterUs;
  const w1 = lifecycle.exitUs;

  const rows: ImpactRow[] = [
    { kind: "主状态", copy: `${entity.name} · ${fmt(w0)}—${fmt(w1)}`, tag: "CHANGE" },
  ];

  for (const { relation, otherId } of relatedEntities(semantic, subjectId)) {
    if (!(relation.windowUs[0] < w1 && relation.windowUs[1] > w0)) continue;
    const other = semantic.entities[otherId];
    affectedEntities.add(otherId);
    rows.push({
      kind: "关系",
      copy: `${other?.name ?? otherId} ${relationLabel(relation.type)} · ${fmt(relation.windowUs[0])}—${fmt(relation.windowUs[1])}`,
      tag: "RECHECK",
    });
  }

  // 构图：同一时间窗内、其他轨道上的画面片段
  for (const track of project.tracks) {
    if (track.kind !== "video") continue;
    for (const clip of track.clips) {
      if (affectedClipIds.has(clip.id)) {
        affectedTracks.add(track.id);
        continue;
      }
      if (clip.startUs < w1 && clip.endUs > w0) {
        affectedTracks.add(track.id);
        rows.push({ kind: "构图", copy: `${track.name} · ${fmt(clip.startUs)}—${fmt(clip.endUs)}`, tag: "REFLOW" });
      }
    }
  }

  // 保护：将受检的约束列出来（GUARD 阶段做实际判定）
  const targeted = constraintTargets(semantic, [...affectedEntities], [...affectedClipIds]);
  for (const c of targeted) rows.push({ kind: "保护", copy: c.what, tag: "LOCK" });

  // scope 决定命令编译时的 clip 集合
  const scopedClips =
    scope === "entity_lifecycle" || scope === "full"
      ? allClips
      : scope === "from_here"
        ? allClips.filter((c) => c.endUs > (fromUs ?? 0))
        : scope === "moment"
          ? allClips.filter((c) => c.startUs <= (fromUs ?? 0) && c.endUs > (fromUs ?? 0))
          : allClips; // shot：v1 与生命周期同义，由编译期再做镜头窗口裁剪

  return {
    rows,
    affectedEntities: [...affectedEntities],
    affectedClipIds: scopedClips.map((c) => c.id),
    affectedTracks: [...affectedTracks],
  };
}

function constraintTargets(semantic: SemanticProject, entityIds: EntityId[], clipIds: string[]) {
  const idSet = new Set(entityIds);
  const names = entityIds.map((id) => semantic.entities[id]).filter(Boolean);
  return semantic.constraints.filter((c) => {
    if (clipIds.includes(c.what)) return true;
    return names.some(
      (e) => c.what === e!.id || c.what === e!.name || c.what === e!.reference,
    ) || idSet.has(c.what);
  });
}

/** GUARD 阶段：真实约束判定 */
export function runGuards(
  semantic: SemanticProject,
  impact: ImpactReport,
  proposedShifts: { clipId: string; newStartUs: TimeUs }[] = [],
): ConstraintViolation[] {
  return checkConstraints(semantic, {
    affectedEntities: impact.affectedEntities,
    affectedTracks: impact.affectedTracks,
    affectedClipIds: impact.affectedClipIds,
    proposedTimeShiftUs: proposedShifts,
  });
}

function relationLabel(type: string): string {
  const labels: Record<string, string> = {
    held_by: "手持",
    in_front_of: "遮挡",
    lit_by: "受光",
    anchored_to: "锚定",
    cut_to: "接镜",
  };
  return labels[type] ?? type;
}

function fmt(us: TimeUs): string {
  return `${(us / 1_000_000).toFixed(1)}s`;
}

// ---------- 命令编译（PLANNED 阶段，纯函数） ----------

export function compileCommands(
  intent: Intent,
  semantic: SemanticProject,
  project: Project,
  subjectId: EntityId,
  impact: ImpactReport,
): { commands: EditorCommand[]; timeShifts: { clipId: string; newStartUs: TimeUs }[] } {
  const entity = semantic.entities[subjectId];
  if (!entity) throw new Error(`实体不存在: ${subjectId}`);
  const clips = boundClips(entity, project).filter((c) => impact.affectedClipIds.includes(c.id));
  const commands: EditorCommand[] = [];
  const timeShifts: { clipId: string; newStartUs: TimeUs }[] = [];

  switch (intent.operation) {
    case "replace_variant": {
      const variant = String(intent.args.variant ?? "updated");
      for (const clip of clips) {
        commands.push({ kind: "setClipAttrs", clipId: clip.id, attrs: { appearance: { variant } } });
      }
      break;
    }
    case "recolor": {
      const color = String(intent.args.color ?? "deep_blue");
      for (const clip of clips) {
        commands.push({ kind: "setClipAttrs", clipId: clip.id, attrs: { appearance: { color } } });
      }
      break;
    }
    case "retime_lifecycle": {
      const shiftUs = Number(intent.args.shiftUs ?? 0);
      for (const clip of [...clips].sort((a, b) => a.startUs - b.startUs)) {
        const newStart = Math.max(0, clip.startUs + shiftUs);
        const span = clip.endUs - clip.startUs;
        commands.push({ kind: "setClipRange", clipId: clip.id, startUs: newStart, endUs: newStart + span });
        timeShifts.push({ clipId: clip.id, newStartUs: newStart });
      }
      break;
    }
    case "reframe": {
      const framing = String(intent.args.framing ?? "product_close_up");
      for (const clip of clips) {
        commands.push({ kind: "setClipAttrs", clipId: clip.id, attrs: { appearance: { framing } } });
      }
      break;
    }
    case "regen_motion": {
      for (const clip of clips) {
        commands.push({
          kind: "setClipAttrs",
          clipId: clip.id,
          attrs: { appearance: { motion_path: "ai_generated" } },
        });
      }
      break;
    }
    case "set_attrs": {
      const attrs = (intent.args.attrs as Record<string, unknown>) ?? {};
      for (const clip of clips) {
        commands.push({ kind: "setClipAttrs", clipId: clip.id, attrs });
      }
      break;
    }
  }

  return { commands, timeShifts };
}
