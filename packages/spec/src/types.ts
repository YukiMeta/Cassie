import type { ClipId, Project, TrackId, TimeUs } from "@cassie/editor-core";

/**
 * Cassie Video Spec —— 语义状态与约束层。
 * 原则：OpenCut 项目数据是实际剪辑状态；Video Spec 是语义状态与约束。
 * 两者通过稳定 ID（BindTarget）映射，语义修改最终编译为 Editor Commands。
 */
export type EntityId = string;

export interface SemanticProject {
  id: string;
  /** 绑定到的编辑器项目 id */
  editorProjectId: string;
  entities: Record<EntityId, SemanticEntity>;
  relations: Relation[];
  constraints: Constraint[];
}

export type EntityKind = "subject" | "scene" | "text" | "audio";

export interface SemanticEntity {
  id: EntityId;
  name: string;
  kind: EntityKind;
  /** @资产引用，如 "@Nocturne_Bottle" —— 跨项目长期资产 */
  reference?: string;
  /** 语义生命期：出现 → 消失（µs）。由绑定片段推导或显式声明 */
  lifecycle: Lifecycle;
  /** 语义属性（appearance.color / variant / motion_path …） */
  attributes: Record<string, SemanticValue>;
  /** 到编辑器元素的稳定映射 */
  binds: BindTarget[];
  /** 硬锁（在 GUARD 阶段阻断修改） */
  locked: boolean;
}

export type SemanticValue = string | number | boolean | SemanticValue[] | { [k: string]: SemanticValue };

export interface Lifecycle {
  enterUs: TimeUs;
  exitUs: TimeUs;
}

export interface BindTarget {
  targetType: "clip" | "track" | "asset";
  targetId: string;
  /** primary = 该实体身份所在片段（替换素材时身份不变） */
  role: "primary" | "supporting";
}

export type RelationType = "held_by" | "in_front_of" | "lit_by" | "anchored_to" | "cut_to";

export interface Relation {
  id: string;
  type: RelationType;
  subjectId: EntityId;
  objectId: EntityId;
  /** 关系有效时间窗（µs） */
  windowUs: [TimeUs, TimeUs];
}

export type ConstraintKind = "lock" | "preserve" | "anchor";

export interface Constraint {
  id: string;
  kind: ConstraintKind;
  /** 受约束对象：实体 id、@资产引用 或属性路径（"logo" / "character.identity" / "audio"） */
  what: string;
  scope: "entity" | "global";
  /** anchor 专用：不可移动的时间点 */
  anchorUs?: TimeUs;
}

// ---------- 查询与推导 ----------

/** 主体生命期 = 所有绑定片段的并集（出现于第一个片段入点，消失于最后一个片段出点） */
export function deriveLifecycle(entity: SemanticEntity, project: Project): Lifecycle {
  const clips = boundClips(entity, project);
  if (clips.length === 0) return { ...entity.lifecycle };
  let enterUs = Number.POSITIVE_INFINITY;
  let exitUs = 0;
  for (const clip of clips) {
    enterUs = Math.min(enterUs, clip.startUs);
    exitUs = Math.max(exitUs, clip.endUs);
  }
  return { enterUs, exitUs };
}

export function boundClips(entity: SemanticEntity, project: Project) {
  const clipIds = new Set(
    entity.binds.filter((b) => b.targetType === "clip").map((b) => b.targetId),
  );
  return project.tracks
    .flatMap((t) => t.clips)
    .filter((c) => clipIds.has(c.id));
}

export function boundTracks(entity: SemanticEntity, project: Project): TrackId[] {
  return entity.binds
    .filter((b) => b.targetType === "track")
    .map((b) => b.targetId)
    .filter((id) => project.tracks.some((t) => t.id === id));
}

/** 实体生命期是否覆盖时间点 */
export function covers(ts: TimeUs, lifecycle: Lifecycle): boolean {
  return ts >= lifecycle.enterUs && ts < lifecycle.exitUs;
}

/** 两个生命期是否重叠 */
export function overlaps(a: Lifecycle, b: Lifecycle): boolean {
  return a.enterUs < b.exitUs && b.enterUs < a.exitUs;
}

/** 与实体有直接关系且时间窗重叠的其他实体 */
export function relatedEntities(semantic: SemanticProject, entityId: EntityId): { relation: Relation; otherId: EntityId }[] {
  const out: { relation: Relation; otherId: EntityId }[] = [];
  for (const rel of semantic.relations) {
    if (rel.subjectId === entityId) out.push({ relation: rel, otherId: rel.objectId });
    else if (rel.objectId === entityId) out.push({ relation: rel, otherId: rel.subjectId });
  }
  return out;
}

/** 约束检查（GUARD 阶段）：返回违规清单 */
export function checkConstraints(
  semantic: SemanticProject,
  opts: {
    affectedEntities: EntityId[];
    affectedTracks: TrackId[];
    affectedClipIds: ClipId[];
    proposedTimeShiftUs?: { clipId: ClipId; newStartUs: TimeUs }[];
  },
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];
  const entityIds = new Set(opts.affectedEntities);

  for (const c of semantic.constraints) {
    const targets = resolveConstraintTargets(semantic, c);
    const hit = targets.some((t) => entityIds.has(t));
    if (!hit) continue;

    if (c.kind === "lock") {
      violations.push({ constraintId: c.id, kind: "violation", message: `硬锁「${c.what}」阻止修改` });
    }
    if (c.kind === "preserve") {
      violations.push({ constraintId: c.id, kind: "warning", message: `保护「${c.what}」—— 需在事务中显式保留` });
    }
    if (c.kind === "anchor" && c.anchorUs !== undefined) {
      const moved = (opts.proposedTimeShiftUs ?? []).find((m) => m.clipId && targets.some((t) => t === m.clipId));
      if (!moved) continue;
      // 锚点是否仍被覆盖
      const stillCovered = targets.some((t) => {
        const range = opts.proposedTimeShiftUs?.find((m) => m.clipId === t);
        return range && range.newStartUs <= c.anchorUs!;
      });
      if (!stillCovered) {
        violations.push({ constraintId: c.id, kind: "violation", message: `锚点 ${c.anchorUs} 不再被「${c.what}」覆盖` });
      }
    }
  }
  return violations;
}

export interface ConstraintViolation {
  constraintId: string;
  kind: "violation" | "warning";
  message: string;
}

function resolveConstraintTargets(semantic: SemanticProject, c: Constraint): (EntityId | ClipId)[] {
  // what 可以是：实体 id、实体名、@引用、或 clip id
  const hits: (EntityId | ClipId)[] = [];
  for (const e of Object.values(semantic.entities)) {
    if (e.id === c.what || e.name === c.what || e.reference === c.what) hits.push(e.id);
  }
  if (hits.length === 0 && c.what.startsWith("clip_")) hits.push(c.what);
  return hits;
}
