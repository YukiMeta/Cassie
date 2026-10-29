import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseWorkspace, validateWorkspace, EventError } from "@cassie/harness";
import type { EventWorkspace } from "@cassie/spec";

export async function readWorkspace(file: string): Promise<EventWorkspace> {
  return parseWorkspace(await readFile(file, "utf8"));
}
export async function writeJson(file: string, value: unknown): Promise<void> {
  const target = resolve(file);
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, target);
  } finally { await unlink(temp).catch(() => undefined); }
}
/** Single writer across CLI and client processes; never remove another process's lock. */
export async function updateWorkspace(file: string, update: (workspace: EventWorkspace) => EventWorkspace | Promise<EventWorkspace>): Promise<EventWorkspace> {
  const lockPath = `${resolve(file)}.lock`;
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new EventError("WORKSPACE_BUSY", "Another writer owns this project; retry after it finishes. A crash lock must be inspected before removal.");
    throw error;
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    const next = await update(await readWorkspace(file));
    validateWorkspace(next);
    await writeJson(file, next);
    return next;
  } finally { await lock.close(); await unlink(lockPath); }
}
