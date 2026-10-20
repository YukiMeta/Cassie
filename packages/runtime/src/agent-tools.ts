import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyDocumentEdit, checkNoOverlap, diff, frameRuns, resolveSelector, EventError, planDocumentEdit, resolveEvents, resolveFrameCount, rollbackAction, staleSubjects, variableValues, variantDocument } from "@cassie/harness";
import type { DocumentEdit, EventDocument, Variant } from "@cassie/spec";
import { readWorkspace, updateWorkspace } from "./store";
import { renderVideo } from "./render";
import { trackConcept } from "./concept";
import { planSubjectSync, runSubjectSync, type SubjectProvider } from "./subject-sync";

/**
 * One tool surface for every agent: the in-app chat calls it over HTTP, external coding agents over
 * MCP. Tools only speak typed edits, never free-form code, so every change an agent makes is planned,
 * validated, recorded as a patch and can be rolled back like a human edit.
 */
export interface ToolContext {
  file: string;
  /** Base URL of a runtime serving this project; needed to capture preview frames. */
  baseUrl: () => Promise<string>;
}
export interface ToolResult {
  text: string;
  image?: { data: string; mimeType: "image/jpeg" };
}
export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Spends money on an external provider; callers must get a human yes before passing `confirmed`. */
  paid?: boolean;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}

const json = (value: unknown): ToolResult => ({ text: JSON.stringify(value, null, 1) });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });
const variantIdsArg = { type: "array", items: { type: "string" }, description: "Variant ids; omit for every variant whose subject is stale" };

const EDIT_CATALOG = `Every change is one typed edit object {kind, ...}. Frames are integers at the project frame rate; boxes are 0..1 fractions of the canvas.
set-event-timing {eventId, startFrame, durationFrames}
set-layer {layerId, patch: {x?, y?, width?, height?, rotation?, color?, text?, tint?}}   (pixels on the master canvas)
set-variable {variable: {id, label, type: "text"|"color", default}}   master value every variant follows unless it overrides
add-overlay-text {layerId, label, text? | bind?: variableId, color: "#rrggbb", startFrame, durationFrames, box: {x,y,width,height}, anchor?: "start"|"end"}   anchor "end" keeps end cards the same distance from the end in variants of another length
set-variant-values {variantId, values: {variableId: text}}   empty string clears the override
review-variant {variantId, review: "pending"|"approved"|"rejected", note?}   rejecting needs a note
add-variants {items: [{id, coords: {axisId: valueId}, review: "pending"}]} / remove-variants {ids}
set-region-look {regionId, patch: {hue?, saturation?, brightness?, ...}}
Subject references, takes and mattes carry media and are added through their own tools or the CLI, not here.`;

function overview(d: EventDocument) {
  const set = d.variants;
  const items = Object.values(set?.items ?? {});
  const tally = (pick: (v: Variant) => string) => items.reduce<Record<string, number>>((acc, v) => ({ ...acc, [pick(v)]: (acc[pick(v)] ?? 0) + 1 }), {});
  return {
    revision: d.editor.revision,
    canvas: `${d.editor.settings.width}x${d.editor.settings.height}`,
    fps: d.frameRate.num / d.frameRate.den,
    frames: resolveFrameCount(d),
    events: resolveEvents(d).map(e => ({ id: e.id, kind: e.kind, entityId: e.entityId, startFrame: e.startFrame, endFrame: e.endFrame, ...(e.text ? { text: e.text } : {}) })),
    layers: d.scene.layers.map(l => ({ id: l.id, kind: l.kind, eventId: l.eventId, ...(l.text ? { text: l.text } : {}), ...(l.bind ? { bind: l.bind } : {}) })),
    subjects: Object.values(d.semantic.entities).filter(e => e.kind === "subject").map(e => ({ id: e.id, name: e.name, locked: e.locked })),
    variables: Object.values(d.variables ?? {}),
    subjectReferences: Object.entries(d.subjectRefs ?? {}).map(([key, r]) => ({ key, entityId: r.entityId, scope: r.scope ?? "all variants", prompt: r.prompt })),
    variants: set ? {
      master: set.masterAssetId,
      axes: set.axes.map(a => ({ id: a.id, values: a.values.map(v => v.id) })),
      count: items.length,
      review: tally(v => v.review),
      withoutTake: items.filter(v => !v.take).length,
      staleSubjects: items.filter(v => staleSubjects(d, v).length).length,
      brief: set.brief,
      keep: set.keep,
    } : null,
  };
}

function summarizePlan(before: EventDocument, after: EventDocument) {
  const ops = diff({ ...before, editor: { ...before.editor, revision: 0 } }, { ...after, editor: { ...after.editor, revision: 0 } });
  return { patchOps: ops.length, touched: [...new Set(ops.map(o => o.path.slice(0, 3).join(".")))].slice(0, 16) };
}

async function staleIds(d: EventDocument, ids?: unknown): Promise<string[]> {
  const all = Object.values(d.variants?.items ?? {});
  const list = Array.isArray(ids) && ids.length ? ids.map(String) : all.filter(v => staleSubjects(d, v).length).map(v => v.id);
  for (const id of list) if (!d.variants?.items[id]) throw new EventError("NOT_FOUND", `Unknown variant ${id}`);
  return list;
}

async function provider(): Promise<(SubjectProvider & { pricing?: { perSecond?: number; unit?: string } }) | null> {
  const file = process.env.CASSIE_SUBJECT_PROVIDER;
  return file ? JSON.parse(await readFile(file, "utf8")) : null;
}

export async function subjectSyncQuote(d: EventDocument, ids: string[]) {
  const p = await provider();
  const items = ids.flatMap(id => {
    const v = d.variants!.items[id]!;
    const stale = v.take ? staleSubjects(d, v) : [];
    return stale.length ? [{ variantId: id, subjects: stale.map(e => d.semantic.entities[e]?.name ?? e), seconds: v.take!.durationUs / 1e6 }] : [];
  });
  const seconds = items.reduce((s, i) => s + i.seconds, 0);
  const rate = Number(p?.pricing?.perSecond);
  return { provider: p?.name ?? null, items, seconds, cost: rate > 0 ? { amount: Math.round(rate * seconds * 100) / 100, unit: String(p!.pricing!.unit ?? "credits") } : null };
}

let browser: Promise<{ newPage(): Promise<any>; close(): Promise<void> }> | null = null;

/** One headless Chrome per process, reused across preview captures. */
/** Puppeteer's own Chrome, or the newest one in the home cache when a sandboxed cache dir points elsewhere. */
export async function chromeExecutable(): Promise<string | null> {
  const { default: p } = await import("puppeteer");
  const own = String(await p.executablePath());
  if (existsSync(own)) return own;
  const root = join(homedir(), ".cache", "puppeteer", "chrome");
  const build = existsSync(root) ? readdirSync(root).sort().at(-1) : undefined;
  const app = build && join(root, build, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
  const linux = build && join(root, build, "chrome-linux64", "chrome");
  return [app, linux].find(f => f && existsSync(f)) || null;
}

async function chrome() {
  browser ??= import("puppeteer").then(async ({ default: p }) => p.launch({ headless: true, executablePath: (await chromeExecutable()) ?? undefined, args: ["--autoplay-policy=no-user-gesture-required"] }));
  return browser;
}

export async function closeAgentBrowser() {
  const b = await browser?.catch(() => null);
  browser = null;
  await b?.close().catch(() => undefined);
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: "project_overview",
    description: "Read the project: revision, canvas, events with frame ranges, layers, subjects, text variables, subject references and a variant summary. Call this first.",
    inputSchema: obj({}),
    run: async ctx => json(overview((await readWorkspace(ctx.file)).document)),
  },
  {
    name: "list_variants",
    description: "List variants with coordinates, review status, take size, resolved text variable values and stale subjects.",
    inputSchema: obj({ filter: { type: "string", enum: ["all", "pending", "approved", "rejected", "stale", "missing-take"] } }),
    run: async (ctx, args) => {
      const d = (await readWorkspace(ctx.file)).document;
      const filter = String(args.filter ?? "all");
      const rows = Object.values(d.variants?.items ?? {}).map(v => ({ id: v.id, coords: v.coords, review: v.review, note: v.note, take: v.take ? `${v.take.width}x${v.take.height} ${(v.take.durationUs / 1e6).toFixed(1)}s` : null, values: variableValues(d, v.id), stale: staleSubjects(d, v) }));
      return json(rows.filter(r => filter === "all" || (filter === "stale" ? r.stale.length : filter === "missing-take" ? !r.take : r.review === filter)));
    },
  },
  {
    name: "edit_reference",
    description: "Describe every typed edit kind and its fields. Read before planning an edit you have not used yet.",
    inputSchema: obj({}),
    run: async () => ({ text: EDIT_CATALOG }),
  },
  {
    name: "plan_edit",
    description: "Dry-run one typed edit: validates it and reports which events move and which document paths change, without saving. Use before apply_edit when unsure.",
    inputSchema: obj({ edit: { type: "object", description: "A typed edit, see edit_reference" } }, ["edit"]),
    run: async (ctx, args) => {
      const d = (await readWorkspace(ctx.file)).document;
      const plan = planDocumentEdit(d, args.edit as DocumentEdit);
      return json({ ok: true, baseRevision: plan.baseRevision, movedEvents: plan.changes.map(c => ({ eventId: c.eventId, from: [c.before.startFrame, c.before.endFrame], to: [c.after.startFrame, c.after.endFrame] })), ...summarizePlan(plan.base, plan.next) });
    },
  },
  {
    name: "apply_edit",
    description: "Apply one typed edit and save it as an undoable transaction. Pass the revision you last read so a concurrent human edit is never overwritten.",
    inputSchema: obj({ edit: { type: "object", description: "A typed edit, see edit_reference" }, baseRevision: { type: "integer" } }, ["edit", "baseRevision"]),
    run: async (ctx, args) => {
      const ws = await updateWorkspace(ctx.file, ws => {
        if (ws.document.editor.revision !== args.baseRevision) throw new EventError("STALE_PLAN", `Project is at revision ${ws.document.editor.revision}, not ${args.baseRevision}; re-read and retry`);
        return applyDocumentEdit(ws, planDocumentEdit(ws.document, args.edit as DocumentEdit));
      });
      const tx = ws.transactions.at(-1)!;
      return json({ ok: true, revision: ws.document.editor.revision, transactionId: tx.id });
    },
  },
  {
    name: "history",
    description: "Recent transactions, newest first, with ids usable for rollback.",
    inputSchema: obj({ limit: { type: "integer", minimum: 1, maximum: 50 } }),
    run: async (ctx, args) => {
      const ws = await readWorkspace(ctx.file);
      const n = Number(args.limit ?? 10);
      return json(ws.transactions.slice(-n).reverse().map(t => ({ id: t.id, kind: t.edit.kind, status: t.status, revision: t.baseRevision + 1 })));
    },
  },
  {
    name: "rollback",
    description: "Undo one applied transaction by id. Later transactions stay; the undo itself is recorded.",
    inputSchema: obj({ transactionId: str("From history or apply_edit") }, ["transactionId"]),
    run: async (ctx, args) => {
      const ws = await updateWorkspace(ctx.file, ws => rollbackAction(ws, String(args.transactionId)));
      return json({ ok: true, revision: ws.document.editor.revision });
    },
  },
  {
    name: "track_subject",
    description: "Find a subject by name in every shot (or the listed shots) and track it frame by frame, so selectors like `entity#<entityId>` and check_layout can see it. Runs locally, no cost, takes a few seconds per shot. Shots where it is not found are reported, never guessed. Each tracked shot is one undoable transaction. Prompt is a short English noun; comma-separate synonyms, e.g. \"phone, smartphone\".",
    inputSchema: obj({ prompt: str("What to find, e.g. \"phone\" or \"bottle\""), entityId: str("Lowercase id the subject will have, e.g. \"phone\"; reuse it to add shots to the same subject"), name: str("Display name, e.g. 手机"), shots: { type: "array", items: { type: "integer", minimum: 1 }, description: "1-based shot numbers; omit for all" } }, ["prompt", "entityId"]),
    run: async (ctx, args) => {
      const d = (await readWorkspace(ctx.file)).document;
      const out = await trackConcept(d, dirname(ctx.file), { prompt: String(args.prompt), entityId: String(args.entityId), name: args.name ? String(args.name) : undefined, shots: Array.isArray(args.shots) ? args.shots.map(Number) : undefined });
      const transactions: string[] = [];
      for (const edit of out.edits) {
        const ws = await updateWorkspace(ctx.file, ws => applyDocumentEdit(ws, planDocumentEdit(ws.document, edit)));
        transactions.push(ws.transactions.at(-1)!.id);
      }
      const missed = out.shots.filter(s => !s.found).map(s => s.shot);
      return json({ ok: out.edits.length > 0, entityId: String(args.entityId), detector: out.backend, shots: out.shots, transactions, revision: (await readWorkspace(ctx.file)).document.editor.revision, note: missed.length ? `Not found in shot ${missed.join(", ")}. Check those by eye with preview_frame before assuming the subject is absent.` : undefined });
    },
  },
  {
    name: "select",
    description: "Resolve a selector to what is on screen: matching entities, overlays or shots with their frame ranges and a sample canvas box. Use it before editing to confirm you have the right thing, and tell the human how much it hits. Grammar: entity|overlay|clip[:concept][#id][ [shot=N]][ [var=x]][ [kind=k]][ t=a..b (seconds) | f=a..b (frames) | sf=a..b (source frames)]. Examples: `entity:bottle [shot=2]`, `overlay[var=cta]`, `clip [shot=3]`, `entity#product t=8..12`.",
    inputSchema: obj({ selector: str("Selector text"), variantId: str("Resolve on a variant's canvas; omit for the master") }, ["selector"]),
    run: async (ctx, args) => {
      const d = (await readWorkspace(ctx.file)).document;
      const scene = args.variantId ? variantDocument(d, String(args.variantId)) : d;
      const fps = scene.frameRate.num / scene.frameRate.den;
      const matches = resolveSelector(scene, String(args.selector)).map(m => {
        const [first] = m.boxes, runs = frameRuns(m.boxes.keys());
        return { target: m.target, id: m.id, name: m.name, frames: m.boxes.size, ranges: runs.map(([a, b]) => `${(a / fps).toFixed(2)}s–${(b / fps).toFixed(2)}s`), sampleBox: first ? { frame: first[0], box: first[1].map(Math.round) } : null };
      });
      return json({ canvas: [scene.editor.settings.width, scene.editor.settings.height], hits: matches.length, frames: matches.reduce((n, m) => n + m.frames, 0), matches });
    },
  },
  {
    name: "check_layout",
    description: "Check a no_overlap rule: `subject` must stay `pad` px clear of everything `avoid` selects, on every frame both are on screen. Returns violating time ranges and, for overlays, a y position that clears them; apply it with set-layer, then preview_frame to confirm. Example: subject `overlay[var=cta]`, avoid `entity:product`.",
    inputSchema: obj({ subject: str("Selector for what must move or stay clear"), avoid: str("Selector for what must not be covered"), pad: { type: "number", minimum: 0, description: "Clearance in canvas px, default 16" }, variantId: str("Check a variant's canvas; omit for the master") }, ["subject", "avoid"]),
    run: async (ctx, args) => {
      const d = (await readWorkspace(ctx.file)).document;
      const scene = args.variantId ? variantDocument(d, String(args.variantId)) : d;
      const fps = scene.frameRate.num / scene.frameRate.den;
      const check = checkNoOverlap(scene, String(args.subject), String(args.avoid), args.pad === undefined ? 16 : Number(args.pad));
      return json({
        ok: check.ok,
        unchecked: check.unchecked,
        violations: check.violations.map(v => ({ ...v, frames: v.frames.map(([a, b]) => `${(a / fps).toFixed(2)}s–${(b / fps).toFixed(2)}s`) })),
        suggestions: check.suggestions.map(s => ({ reason: s.reason, edit: { kind: "set-layer", layerId: s.layerId, patch: s.patch } })),
        note: args.variantId && check.suggestions.length ? "Suggestions are in the variant's canvas; master layer edits apply to every variant, so verify each aspect with preview_frame." : undefined,
      });
    },
  },
  {
    name: "preview_frame",
    description: "Render one frame exactly as the renderer will (master, or a variant with its own take, canvas and text) and return it as an image. Use it to check your own edits: text fits, nothing covers the subject, the end card shows.",
    inputSchema: obj({ seconds: { type: "number", minimum: 0 }, variantId: str("Omit for the master") }, ["seconds"]),
    run: async (ctx, args) => {
      const d = (await readWorkspace(ctx.file)).document;
      const variantId = args.variantId ? String(args.variantId) : undefined;
      const scene = variantId ? variantDocument(d, variantId) : d;
      const page = await (await chrome()).newPage();
      try {
        await page.setViewport({ width: scene.editor.settings.width, height: scene.editor.settings.height, deviceScaleFactor: 1 });
        const fps = scene.frameRate.num / scene.frameRate.den;
        await page.goto(`${await ctx.baseUrl()}/scene${variantId ? `?variant=${encodeURIComponent(variantId)}` : ""}`, { waitUntil: "load" });
        await page.waitForFunction("window.__hf && typeof window.__hf.seek === 'function'", { timeout: 15_000 });
        const at = Math.min(Number(args.seconds), resolveFrameCount(scene) / fps - 1 / fps);
        await page.evaluate(`window.__hf.seek(${Math.max(0, at)})`);
        await page.evaluate("Promise.all([...document.querySelectorAll('video')].map(v => v.readyState >= 2 && !v.seeking ? 0 : new Promise(r => { v.addEventListener('seeked', r, { once: true }); setTimeout(r, 3000); })))");
        const data = Buffer.from(await page.screenshot({ type: "jpeg", quality: 82 })).toString("base64");
        return { text: `${variantId ?? "master"} at ${at.toFixed(2)}s, ${scene.editor.settings.width}x${scene.editor.settings.height}`, image: { data, mimeType: "image/jpeg" } };
      } finally {
        await page.close().catch(() => undefined);
      }
    },
  },
  {
    name: "render_video",
    description: "Render the master or one variant to an mp4 on disk and return its path. Takes roughly real time.",
    inputSchema: obj({ variantId: str("Omit for the master") }),
    run: async (ctx, args) => {
      const d = (await readWorkspace(ctx.file)).document;
      const variantId = args.variantId ? String(args.variantId) : undefined;
      const out = join(dirname(ctx.file), "renders", `${variantId ?? "master"}-r${d.editor.revision}.mp4`);
      await renderVideo(variantId ? variantDocument(d, variantId) : d, dirname(ctx.file), out);
      return json({ ok: true, path: out, revision: d.editor.revision });
    },
  },
  {
    name: "subject_sync_quote",
    description: "Before any subject sync: which variants are stale, what will be replaced, total seconds and estimated cost. Free.",
    inputSchema: obj({ variantIds: variantIdsArg }),
    run: async (ctx, args) => {
      const d = (await readWorkspace(ctx.file)).document;
      return json(await subjectSyncQuote(d, await staleIds(d, args.variantIds)));
    },
  },
  {
    name: "subject_sync",
    description: "Segment and replace stale subjects in variant takes through the configured provider. Costs money: show the quote to the human and only pass confirmed=true after they agree. Without a provider it only writes request bundles.",
    paid: true,
    inputSchema: obj({ variantIds: variantIdsArg, confirmed: { type: "boolean", description: "The human approved the quoted cost" } }),
    run: async (ctx, args) => {
      const d = (await readWorkspace(ctx.file)).document;
      const ids = await staleIds(d, args.variantIds);
      const quote = await subjectSyncQuote(d, ids);
      if (!quote.items.length) return json({ ok: true, synced: [], message: "Nothing stale" });
      const p = await provider();
      if (p && args.confirmed !== true) return json({ ok: false, needsConfirmation: true, quote, message: "Show this quote to the human and call again with confirmed=true only if they agree." });
      const busy = p ? await runningSyncs(ctx.file, quote.items.map(i => i.variantId)) : [];
      if (busy.length) return json({ ok: false, inProgress: busy, message: "A paid sync is already running for these variants. Wait and check list_variants; do not call subject_sync again for them." });
      const done: { variantId: string; bundle?: string }[] = [];
      if (p) await Promise.all(quote.items.map(i => markSync(ctx.file, i.variantId)));
      try {
      for (const item of quote.items) {
        const current = (await readWorkspace(ctx.file)).document;
        const dir = join(dirname(ctx.file), "sync", `${item.variantId}-${Date.now()}`);
        const request = await planSubjectSync(current, dirname(ctx.file), item.variantId, dir);
        if (!p) { done.push({ variantId: item.variantId, bundle: dir }); continue; }
        const edit = await runSubjectSync(current, dirname(ctx.file), request, p);
        await updateWorkspace(ctx.file, ws => applyDocumentEdit(ws, planDocumentEdit(ws.document, edit)));
        done.push({ variantId: item.variantId });
        await clearSync(ctx.file, item.variantId);
      }
      } catch (e) { await Promise.all(quote.items.map(i => clearSync(ctx.file, i.variantId))); throw e; }
      return json({ ok: true, provider: p?.name ?? null, synced: done, note: p ? "New takes are pending review" : "No provider configured; request bundles written" });
    },
  },
];

/** Paid sync jobs survive restarts on disk; one that never cleared is treated as running for SYNC_JOB_TTL_MS. */
const SYNC_JOB_TTL_MS = 30 * 60_000;
const syncJobFile = (file: string, id: string) => join(dirname(file), ".cassie-cache", "sync-jobs", `${encodeURIComponent(id)}.json`);

export async function markSync(file: string, id: string) {
  await mkdir(dirname(syncJobFile(file, id)), { recursive: true });
  await writeFile(syncJobFile(file, id), JSON.stringify({ variantId: id, startedAt: Date.now() }));
}

export async function clearSync(file: string, id: string) {
  await rm(syncJobFile(file, id), { force: true });
}

export async function runningSyncs(file: string, ids: string[]) {
  const busy: string[] = [];
  for (const id of ids) {
    const job = await readFile(syncJobFile(file, id), "utf8").then(t => JSON.parse(t) as { startedAt: number }, () => null);
    if (job && Date.now() - job.startedAt < SYNC_JOB_TTL_MS) busy.push(id);
  }
  return busy;
}

export async function callAgentTool(ctx: ToolContext, name: string, args: Record<string, unknown> = {}): Promise<ToolResult & { isError?: boolean }> {
  const tool = AGENT_TOOLS.find(t => t.name === name);
  if (!tool) return { text: `Unknown tool ${name}`, isError: true };
  try {
    return await tool.run(ctx, args ?? {});
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { text: JSON.stringify({ ok: false, error: err.code ?? "ERROR", message: err.message ?? String(e) }), isError: true };
  }
}

export const toolManifest = () => AGENT_TOOLS.map(({ name, description, inputSchema, paid }) => ({ name, description, inputSchema, ...(paid ? { paid } : {}) }));
