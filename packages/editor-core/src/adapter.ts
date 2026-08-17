import { applyCommand, dryRun, type ApplyResult, type EditorCommand } from "./commands";
import type { Project } from "./project";
import { parseProjectFile, projectToJson, rehydrateUrls } from "./serialize";

/**
 * EditorAdapter —— Cassie 上层与编辑器内核之间的唯一边界。
 * 未来把实现换成 OpenCut Rewrite 的 Rust Core（Editor API / Headless）时，
 * 上层代码零改动，替换的只是这个实现。
 */
export interface EditorAdapter {
  getProject(): Project;
  /** 原子应用一批命令：全部预演通过后才落盘；失败则状态不变。
   *  recordHistory=false 用于拖拽等连续手势（只落盘不入撤销栈），手势结束再以记录模式提交一次 */
  applyCommands(commands: EditorCommand[], opts?: { recordHistory?: boolean }): ApplyResult;
  undo(): ApplyResult | null;
  redo(): ApplyResult | null;
  canUndo(): boolean;
  canRedo(): boolean;
  getHistory(): { past: number; future: number };
  save(): string;
  load(json: string): void;
  /** 资产 URL 恢复入口（objectURL 不持久化） */
  rehydrate(resolveUrl: (assetId: string) => string | undefined): void;
  /** 版本戳：事务回滚点 */
  checkpoint(): number;
  subscribe(listener: (project: Project) => void): () => void;
}

/**
 * 本地 TypeScript 实现。历史栈以逆命令为单元：
 * past 栈顶 = 最近一次操作的精确逆命令；undo 执行之，其结果逆命令入 future（redo 免费）。
 */
export class LocalAdapter implements EditorAdapter {
  private project: Project;
  private past: EditorCommand[] = [];
  private future: EditorCommand[] = [];
  private listeners = new Set<(p: Project) => void>();

  constructor(project: Project) {
    this.project = project;
  }

  getProject(): Project {
    return this.project;
  }

  applyCommands(commands: EditorCommand[], opts: { recordHistory?: boolean } = {}): ApplyResult {
    const record = opts.recordHistory !== false;
    if (commands.length === 0) {
      return { project: this.project, inverse: { kind: "composite", commands: [] } };
    }
    // 原子性：先在克隆上完整预演，任何一步失败都不落盘
    dryRun(this.project, commands);
    let project = this.project;
    const inverses: EditorCommand[] = [];
    for (const cmd of commands) {
      const result = applyCommand(project, cmd);
      project = result.project;
      inverses.unshift(result.inverse);
    }
    this.project = { ...project, revision: project.revision + 1 };
    const inverse = { kind: "composite", commands: inverses } as EditorCommand;
    if (record) {
      this.past.push(inverse);
      this.future = [];
    }
    this.emit();
    return { project: this.project, inverse };
  }

  undo(): ApplyResult | null {
    const inverse = this.past.pop();
    if (!inverse) return null;
    const applied = applyCommand(this.project, inverse);
    this.project = { ...applied.project, revision: applied.project.revision + 1 };
    this.future.push(applied.inverse);
    this.emit();
    return applied;
  }

  redo(): ApplyResult | null {
    const forward = this.future.pop();
    if (!forward) return null;
    const applied = applyCommand(this.project, forward);
    this.project = { ...applied.project, revision: applied.project.revision + 1 };
    this.past.push(applied.inverse);
    this.emit();
    return applied;
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }
  canRedo(): boolean {
    return this.future.length > 0;
  }
  getHistory(): { past: number; future: number } {
    return { past: this.past.length, future: this.future.length };
  }

  save(): string {
    return projectToJson(this.project);
  }
  load(json: string): void {
    this.project = parseProjectFile(json);
    this.past = [];
    this.future = [];
    this.emit();
  }
  rehydrate(resolveUrl: (assetId: string) => string | undefined): void {
    this.project = rehydrateUrls(this.project, resolveUrl);
    this.emit();
  }

  checkpoint(): number {
    return this.project.revision;
  }

  subscribe(listener: (project: Project) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l(this.project);
  }
}
