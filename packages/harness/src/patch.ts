import type { PatchOp } from "@cassie/spec";
import { canonical } from "./events";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const isObject = (v: unknown): v is Record<string, Json> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Structural diff from `a` to `b`. Objects diff per key, equal-length arrays per index; an array that
 * changed length is replaced whole, so keyed records (regions, variants, assets) stay cheap.
 */
export function diff(a: unknown, b: unknown, path: (string | number)[] = [], out: PatchOp[] = []): PatchOp[] {
  if (canonical(a) === canonical(b)) return out;
  if (isObject(a) && isObject(b)) {
    for (const key of Object.keys(a)) if (b[key] === undefined && a[key] !== undefined) out.push({ op: "del", path: [...path, key] });
    for (const key of Object.keys(b)) if (b[key] !== undefined) diff(a[key], b[key], [...path, key], out);
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    a.forEach((x, i) => diff(x, b[i], [...path, i], out));
    return out;
  }
  out.push({ op: "set", path, value: structuredClone(b) });
  return out;
}

export function applyPatch<T>(value: T, ops: PatchOp[]): T {
  let root = structuredClone(value) as unknown;
  for (const op of ops) {
    if (!op.path.length) { if (op.op === "set") root = structuredClone(op.value); continue; }
    let node = root as Record<string | number, unknown>;
    for (const key of op.path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
    const last = op.path.at(-1)!;
    if (op.op === "del") delete node[last];
    else node[last] = structuredClone(op.value);
  }
  return root as T;
}

/** Fast content digest for conflict checks (two FNV-1a passes); not a security hash. */
export function digest(value: unknown): string {
  const text = canonical(value);
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
