import { dryRun, type EditorAdapter, type Project } from "@cassie/editor-core";
import { deriveLifecycle, type SemanticProject } from "@cassie/spec";
import {
  analyzeImpact,
  compileCommands,
  runGuards,
  type EditTransaction,
} from "./compile";
import { parseIntent, resolveSubject, type Scope } from "./intent";
import { canAdvance, FLOW, type HarnessState } from "./states";

/**
 * Harness —— 后台真实事务执行器（不再是 UI 状态展示）。
 * 每个语义修改走完整状态机；命令在预演通过后才通过 EditorAdapter 落盘；
 * 事务全程可持久化、可回滚。
 */
export class Harness {
  private adapter: EditorAdapter;
  private semantic: SemanticProject;
  private transactions: EditTransaction[] = [];

  constructor(adapter: EditorAdapter, semantic: SemanticProject) {
    this.adapter = adapter;
    this.semantic = semantic;
  }

  getSemantic(): SemanticProject {
    return this.semantic;
  }

  /** 语义层自身状态变化（绑定、约束调整）后同步 */
  setSemantic(semantic: SemanticProject): void {
    this.semantic = semantic;
  }

  listTransactions(): EditTransaction[] {
    return this.transactions;
  }

  /**
   * 完整确定性编译：DRAFT → BOUND → TRACED → IMPACTED → GUARDED → PLANNED。
   * 不落盘，不修改任何状态；返回可检查、可预览的事务。
   */
  compile(
    intentText: string,
    ctx: { playheadUs?: number; selectedEntityId?: string; scopeOverride?: Scope } = {},
  ): EditTransaction {
    const project = this.adapter.getProject();
    const intent = parseIntent(intentText, ctx);
    if (ctx.scopeOverride) intent.scope = ctx.scopeOverride;
    const tx: EditTransaction = {
      id: `tx_${this.transactions.length + 1}`,
      status: "DRAFT",
      intent,
      subjectId: null,
      lifecycleBefore: null,
      lifecycleAfter: null,
      impact: { rows: [], affectedEntities: [], affectedClipIds: [], affectedTracks: [] },
      guards: [],
      commands: [],
      baseRevision: this.adapter.checkpoint(),
      committedRevision: null,
      validation: null,
      error: null,
      stateLog: [],
    };
    this.advance(tx, "DRAFT");

    // BOUND：解析主体
    const candidates = Object.values(this.semantic.entities).map((e) => ({
      id: e.id,
      name: e.name,
      reference: e.reference,
    }));
    const subjectId = resolveSubject(intent.subjectRef, candidates, ctx.selectedEntityId ?? null);
    tx.subjectId = subjectId;
    if (!subjectId) {
      return this.fail(tx, "无法解析指令中的主体：请指定实体名或 @资产引用");
    }
    this.advance(tx, "BOUND");

    // TRACED：主体生命周期（出现 → 消失）
    const entity = this.semantic.entities[subjectId];
    if (!entity) {
      return this.fail(tx, `语义主体不存在：${subjectId}`);
    }
    if (entity.locked) {
      return this.fail(tx, `硬锁：主体「${entity.name}」已锁定，禁止修改`, "BOUND");
    }
    tx.lifecycleBefore = deriveLifecycle(entity, project);
    this.advance(tx, "TRACED");

    // IMPACTED：影响范围求解
    tx.impact = analyzeImpact(this.semantic, project, subjectId, intent.scope, intent.fromUs);
    this.advance(tx, "IMPACTED");

    // GUARDED：锁定与约束检查（时间移动类需要携带位移量）
    const timeShifts =
      intent.operation === "retime_lifecycle"
        ? tx.impact.affectedClipIds.map((clipId) => {
            const clip = findClip(project, clipId);
            const shift = Number(intent.args.shiftUs ?? 0);
            return clip ? { clipId, newStartUs: Math.max(0, clip.startUs + shift) } : { clipId, newStartUs: 0 };
          })
        : [];
    tx.guards = runGuards(this.semantic, tx.impact, timeShifts);
    const blockers = tx.guards.filter((g) => g.kind === "violation");
    if (blockers.length > 0) {
      return this.fail(tx, blockers.map((b) => b.message).join("；"), "GUARDED");
    }
    this.advance(tx, "GUARDED");

    // PLANNED：编译 Editor Commands
    const { commands } = compileCommands(tx.intent, this.semantic, project, subjectId, tx.impact);
    if (commands.length === 0) {
      return this.fail(tx, "没有可编译的修改：主体在请求范围内没有绑定片段", "PLANNED");
    }
    // 预演：确认命令合法、可原子应用
    dryRun(project, commands);
    tx.commands = commands;
    const after = dryRun(project, commands);
    tx.lifecycleAfter = deriveLifecycle(entity, after);
    this.advance(tx, "PLANNED");

    this.transactions.push(tx);
    return tx;
  }

  /** 提交：VALIDATING → COMMITTING → COMMITTED；任何一步失败状态落 FAILED，项目不变 */
  commit(tx: EditTransaction): EditTransaction {
    if (tx.status !== "PLANNED") return this.fail(tx, `无法从 ${tx.status} 提交`, tx.status);
    this.advance(tx, "VALIDATING");
    const validation = validate(tx);
    tx.validation = validation;
    if (!validation.passed) return this.fail(tx, "验证未通过", "VALIDATING");
    this.advance(tx, "COMMITTING");
    try {
      const result = this.adapter.applyCommands(tx.commands);
      tx.committedRevision = result.project.revision;
    } catch (err) {
      return this.fail(tx, err instanceof Error ? err.message : String(err), "COMMITTING");
    }
    this.advance(tx, "COMMITTED");
    return tx;
  }

  /** 回滚：把项目状态退回到 baseRevision（通过 undo 逐步退） */
  rollback(tx: EditTransaction): EditTransaction {
    if (!canAdvance(tx.status)) return tx;
    let guard = 0;
    while (this.adapter.checkpoint() !== tx.baseRevision && this.adapter.canUndo() && guard < 100) {
      this.adapter.undo();
      guard++;
    }
    this.advance(tx, "ROLLED_BACK");
    return tx;
  }

  cancel(tx: EditTransaction): EditTransaction {
    if (tx.status === "COMMITTED" || tx.status === "ROLLED_BACK") return tx;
    this.advance(tx, "CANCELLED");
    return tx;
  }

  private advance(tx: EditTransaction, state: HarnessState): void {
    tx.status = state;
    tx.stateLog.push({ state, atUs: Date.now() });
  }

  private fail(tx: EditTransaction, message: string, at: HarnessState = tx.status): EditTransaction {
    tx.error = message;
    this.advance(tx, "FAILED");
    tx.stateLog.push({ state: at, atUs: Date.now() });
    this.transactions.push(tx);
    return tx;
  }
}

function validate(tx: EditTransaction): NonNullable<EditTransaction["validation"]> {
  const checks = [
    { name: "主体已绑定", passed: tx.subjectId !== null, detail: tx.subjectId ?? "无" },
    { name: "生命周期闭合", passed: (tx.lifecycleAfter?.exitUs ?? 0) > (tx.lifecycleAfter?.enterUs ?? 0), detail: lifecycleStr(tx.lifecycleAfter) },
    { name: "命令非空", passed: tx.commands.length > 0, detail: `${tx.commands.length} 条命令` },
    { name: "无硬锁冲突", passed: tx.guards.every((g) => g.kind !== "violation"), detail: `${tx.guards.length} 条约束提示` },
  ];
  return { passed: checks.every((c) => c.passed), checks };
}

function lifecycleStr(l: { enterUs: number; exitUs: number } | null): string {
  return l ? `${(l.enterUs / 1e6).toFixed(1)}s → ${(l.exitUs / 1e6).toFixed(1)}s` : "无";
}

function findClip(project: Project, clipId: string) {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return clip;
  }
  return undefined;
}

export { FLOW };
