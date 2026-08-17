/**
 * Harness 生产状态机。
 * 正常流：DRAFT → BOUND → TRACED → IMPACTED → GUARDED → PLANNED
 *         → GENERATING → VALIDATING → COMMITTING → COMMITTED
 * 旁路：FAILED / CANCELLED / ROLLED_BACK
 */
export type HarnessState =
  | "DRAFT"
  | "BOUND"
  | "TRACED"
  | "IMPACTED"
  | "GUARDED"
  | "PLANNED"
  | "GENERATING"
  | "VALIDATING"
  | "COMMITTING"
  | "COMMITTED"
  | "FAILED"
  | "CANCELLED"
  | "ROLLED_BACK";

export const FLOW: HarnessState[] = [
  "DRAFT",
  "BOUND",
  "TRACED",
  "IMPACTED",
  "GUARDED",
  "PLANNED",
  "GENERATING",
  "VALIDATING",
  "COMMITTING",
  "COMMITTED",
];

export const TERMINAL: HarnessState[] = ["COMMITTED", "FAILED", "CANCELLED", "ROLLED_BACK"];

export function nextState(state: HarnessState): HarnessState | null {
  const idx = FLOW.indexOf(state);
  if (idx < 0) return null;
  return FLOW[idx + 1] ?? null;
}

export function canAdvance(state: HarnessState): boolean {
  return !TERMINAL.includes(state);
}
