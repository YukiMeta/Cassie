import { useSyncExternalStore } from "react";
import {
  LocalAdapter,
  addClipCmd,
  compositeCmd,
  createClip,
  createProject,
  moveClipCmd,
  newClipId,
  removeClipCmd,
  setClipAttrsCmd,
  setClipRangeCmd,
  splitClipCmd,
  trimClipCmd,
  us,
  type AssetId,
  type ClipId,
  type EditorCommand,
  type EditorAdapter,
  type MediaAsset,
  type Project,
  type TimeUs,
} from "@cassie/editor-core";
import { Harness, type EditTransaction, type Scope } from "@cassie/harness";
import type { EntityId, SemanticProject } from "@cassie/spec";

/**
 * 应用状态。所有变更走 EditorAdapter（可撤销），Harness 负责语义事务。
 */
export interface AppState {
  adapter: EditorAdapter;
  harness: Harness;
  semantic: SemanticProject;
  transactions: EditTransaction[];
  selectedEntityId: EntityId | null;
  selectedClipId: ClipId | null;
  playheadUs: TimeUs;
  playing: boolean;
  toast: string | null;
  exporting: boolean;
  booted: boolean;
  bootProgress: string | null;
  /** 时间线拖拽吸附 0.5s */
  snapEnabled: boolean;
  /** 舞台安全框显示 */
  safeFrame: boolean;
  /** 舞台预览缩放（0.5–2） */
  stageZoom: number;
}

let state: AppState;
const listeners = new Set<() => void>();
let version = 0;
let rafId: number | null = null;
let lastTick = 0;
/** useSyncExternalStore 需要快照引用变化才重渲染：
 *  每次 emit 版本号 +1，版本变化后的首次读取生成新浅拷贝；无 emit 时引用稳定（防循环渲染） */
let snapshotCache: { data: AppState; version: number } | null = null;

function emit() {
  version++;
  for (const l of listeners) l();
}

export function getState(): AppState {
  return state;
}

function getSnapshot(): AppState {
  if (snapshotCache === null || snapshotCache.version !== version) {
    snapshotCache = { data: { ...state }, version };
  }
  return snapshotCache.data;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useAppState(): AppState {
  return useSyncExternalStore(subscribe, getSnapshot);
}

// ---------- 初始化 ----------

export function initStore(): void {
  // 调试 / E2E 钩子（生产可移除）
  (globalThis as Record<string, unknown>).__cassie = { getState, compileIntent };
  const adapter = new LocalAdapter(createProject({ name: "NOCTURNE · Director Cut" }));
  const semantic = emptySemantic(adapter.getProject().id);
  const harness = new Harness(adapter, semantic);
  state = {
    adapter,
    harness,
    semantic,
    transactions: [],
    selectedEntityId: null,
    selectedClipId: null,
    playheadUs: us(8),
    playing: false,
    toast: null,
    exporting: false,
    booted: false,
    bootProgress: null,
    snapEnabled: true,
    safeFrame: true,
    stageZoom: 1,
  };
  adapter.subscribe(() => emit());

  // 恢复自动保存：项目 + 语义层一起持久化（语义绑定依赖项目稳定 ID）
  const raw = localStorage.getItem("cassie:autosave");
  if (raw) {
    try {
      const data = JSON.parse(raw) as { project: string; semantic: SemanticProject };
      adapter.load(data.project);
      adapter.rehydrate((id) =>
        id.startsWith("demo_") ? `/demo/${adapter.getProject().assets[id]?.name}` : undefined,
      );
      if (data.semantic && Object.keys(data.semantic.entities).length > 0) {
        state.semantic = data.semantic;
        state.harness.setSemantic(state.semantic);
        state.booted = true;
      }
    } catch {
      localStorage.removeItem("cassie:autosave");
    }
  }
  emit();
}

// ---------- 动作 ----------

export function setToast(message: string): void {
  state.toast = message;
  emit();
  setTimeout(() => {
    if (state.toast === message) {
      state.toast = null;
      emit();
    }
  }, 2400);
}

export function selectEntity(entityId: EntityId | null): void {
  state.selectedEntityId = entityId;
  state.selectedClipId = null;
  emit();
}

export function toggleEntityLock(entityId: EntityId): void {
  const entity = state.semantic.entities[entityId];
  if (!entity) return;
  entity.locked = !entity.locked;
  state.harness.setSemantic(state.semantic);
  setToast(entity.locked ? `${entity.name} 已锁定（编译将阻断）` : `${entity.name} 已解锁`);
}

export function selectClip(clipId: ClipId | null): void {
  state.selectedClipId = clipId;
  emit();
}

export function setPlayhead(playheadUs: TimeUs): void {
  state.playheadUs = Math.max(0, Math.min(state.adapter.getProject().settings.durationUs, playheadUs));
  emit();
}

export function togglePlay(): void {
  state.playing = !state.playing;
  if (state.playing) {
    lastTick = performance.now();
    const loop = (now: number) => {
      if (!state.playing) return;
      const dt = (now - lastTick) / 1000;
      lastTick = now;
      const durationUs = state.adapter.getProject().settings.durationUs;
      let next = state.playheadUs + Math.round(dt * 1_000_000);
      if (next >= durationUs) {
        next = 0;
        state.playing = false;
      }
      state.playheadUs = next;
      emit();
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }
  emit();
}

export function undo(): void {
  state.adapter.undo();
}
export function redo(): void {
  state.adapter.redo();
}

export function toggleSnap(): void {
  state.snapEnabled = !state.snapEnabled;
  emit();
}

export function toggleSafeFrame(): void {
  state.safeFrame = !state.safeFrame;
  emit();
}

export function setStageZoom(zoom: number): void {
  state.stageZoom = Math.max(0.5, Math.min(2, zoom));
  emit();
}

export function stageZoomIn(): void {
  setStageZoom(state.stageZoom + 0.25);
}
export function stageZoomOut(): void {
  setStageZoom(state.stageZoom - 0.25);
}
export function stageZoomFit(): void {
  setStageZoom(1);
}

// ---------- 演示项目 ----------

export async function bootDemo(): Promise<void> {
  state.bootProgress = "正在生成演示项目…";
  emit();
  try {
    await bootDemoInner();
  } catch (err) {
    state.bootProgress = null;
    emit();
    setToast(`演示项目载入失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

async function bootDemoInner(): Promise<void> {
  const { adapter } = state;
  // 演示素材时长已知（由 scripts/gen-demo-media.sh 生成），
  // 不依赖 media metadata 事件：加载即时完成，headless 环境同样可用。
  const assets: MediaAsset[] = [
    { id: "demo_night", kind: "video", name: "night.mp4", durationUs: 15_000_000, url: "/demo/night.mp4" },
    { id: "demo_mia", kind: "video", name: "mia.mp4", durationUs: 12_000_000, url: "/demo/mia.mp4" },
    { id: "demo_bottle", kind: "video", name: "bottle.mp4", durationUs: 15_000_000, url: "/demo/bottle.mp4" },
    { id: "demo_music", kind: "audio", name: "music.mp3", durationUs: 15_000_000, url: "/demo/music.mp3" },
  ];
  const night = assets[0]!;
  const mia = assets[1]!;
  const bottle = assets[2]!;
  const music = assets[3]!;

  const videoTrack = adapter.getProject().tracks.find((t) => t.kind === "video")!;
  const textTrack = adapter.getProject().tracks.find((t) => t.kind === "text")!;
  const audioTrack = adapter.getProject().tracks.find((t) => t.kind === "audio")!;

  const clipNight = createClip({ assetId: night.id, startUs: 0, endUs: 15_000_000 });
  const clipMia = createClip({ assetId: mia.id, startUs: 0, endUs: 10_000_000, attrs: { appearance: { identity: "locked" } } });
  const clipBottle = createClip({
    assetId: bottle.id,
    startUs: 4_000_000,
    endUs: 15_000_000,
    attrs: { appearance: { variant: "glass_violet" } },
  });
  const clipLogo = createClip({
    assetId: null,
    startUs: 12_000_000,
    endUs: 15_000_000,
    attrs: { text: "NOCTURNE", color: "white", fontSize: 96, x: 0.5, y: 0.88 },
  });
  const clipMusic = createClip({ assetId: music.id, startUs: 0, endUs: 15_000_000 });

  const commands = [
    ...assets.map((a) => ({ kind: "setAsset" as const, assetId: a.id, asset: a })),
    addClipCmd(clipNight, videoTrack.id),
    addClipCmd(clipMia, videoTrack.id),
    addClipCmd(clipBottle, videoTrack.id),
    addClipCmd(clipLogo, textTrack.id),
    addClipCmd(clipMusic, audioTrack.id),
  ];
  adapter.applyCommands(commands);

  // 语义层：绑定真实 clip id
  state.semantic = {
    id: "sem_nocturne",
    editorProjectId: adapter.getProject().id,
    entities: {
      product: entity("product", "香水瓶 B", "subject", "@Nocturne_Bottle", 4_000_000, 15_000_000, clipBottle.id),
      character: entity("character", "人物 A · Mia", "subject", "@Mia", 0, 10_000_000, clipMia.id),
      scene: entity("scene", "巴黎夜景", "scene", "@Paris_Night", 0, 15_000_000, clipNight.id),
      logo: entity("logo", "品牌文案", "text", "@Nocturne_Logo", 12_000_000, 15_000_000, clipLogo.id),
    },
    relations: [
      { id: "rel_hold", type: "held_by", subjectId: "product", objectId: "character", windowUs: [4_000_000, 10_000_000] },
      { id: "rel_cut", type: "cut_to", subjectId: "product", objectId: "logo", windowUs: [10_000_000, 15_000_000] },
    ],
    constraints: [
      { id: "c_logo", kind: "preserve", what: "logo", scope: "global" },
      { id: "c_identity", kind: "preserve", what: "人物 A · Mia", scope: "global" },
      { id: "c_beat", kind: "anchor", what: clipMusic.id, anchorUs: 10_500_000, scope: "global" },
    ],
  };
  state.harness.setSemantic(state.semantic);
  state.selectedEntityId = "product";
  state.playheadUs = us(8);
  state.booted = true;
  state.bootProgress = null;
  autosave();
  emit();
}

function entity(
  id: EntityId,
  name: string,
  kind: "subject" | "scene" | "text",
  reference: string,
  enterUs: TimeUs,
  exitUs: TimeUs,
  clipId: ClipId,
) {
  return {
    id,
    name,
    kind,
    reference,
    lifecycle: { enterUs, exitUs },
    attributes: {},
    binds: [{ targetType: "clip" as const, targetId: clipId, role: "primary" as const }],
    locked: false,
  };
}

function emptySemantic(editorProjectId: string): SemanticProject {
  return { id: "sem_empty", editorProjectId, entities: {}, relations: [], constraints: [] };
}

// ---------- Harness 桥接 ----------

export function compileIntent(text: string, scopeOverride?: Scope): EditTransaction {
  const tx = state.harness.compile(text, {
    playheadUs: state.playheadUs,
    selectedEntityId: state.selectedEntityId ?? undefined,
    scopeOverride,
  });
  state.transactions = state.harness.listTransactions();
  emit();
  return tx;
}

export function commitTransaction(tx: EditTransaction): EditTransaction {
  const result = state.harness.commit(tx);
  state.transactions = state.harness.listTransactions();
  autosave();
  emit();
  return result;
}

export function rollbackTransaction(tx: EditTransaction): EditTransaction {
  const result = state.harness.rollback(tx);
  state.transactions = state.harness.listTransactions();
  autosave();
  emit();
  return result;
}

export function cancelTransaction(tx: EditTransaction): EditTransaction {
  const result = state.harness.cancel(tx);
  state.transactions = state.harness.listTransactions();
  emit();
  return result;
}

// ---------- 时间线编辑 ----------

export function splitAtPlayhead(): void {
  if (!state.selectedClipId) return;
  state.adapter.applyCommands([splitClipCmd(state.selectedClipId, state.playheadUs)]);
  autosave();
}

export function trimSelected(edge: "start" | "end", deltaUs: TimeUs): void {
  if (!state.selectedClipId) return;
  state.adapter.applyCommands([trimClipCmd(state.selectedClipId, edge, deltaUs)]);
  autosave();
}

export function moveClipTo(clipId: ClipId, newStartUs: TimeUs, trackId?: string): void {
  state.adapter.applyCommands([moveClipCmd(clipId, Math.max(0, newStartUs), trackId)]);
  autosave();
}

export function deleteSelectedClip(): void {
  if (!state.selectedClipId) return;
  state.adapter.applyCommands([removeClipCmd(state.selectedClipId)]);
  state.selectedClipId = null;
  autosave();
}

export function setSelectedRange(startUs?: TimeUs, endUs?: TimeUs): void {
  if (!state.selectedClipId) return;
  state.adapter.applyCommands([setClipRangeCmd(state.selectedClipId, { startUs, endUs })]);
  autosave();
}

export function setClipAttrs(clipId: ClipId, attrs: Record<string, unknown>): void {
  state.adapter.applyCommands([setClipAttrsCmd(clipId, attrs)]);
  autosave();
}

// ---------- 导入 / 持久化 ----------

export async function importMedia(files: FileList): Promise<void> {
  const { adapter } = state;
  const videoTrack = adapter.getProject().tracks.find((t) => t.kind === "video")!;
  const audioTrack = adapter.getProject().tracks.find((t) => t.kind === "audio")!;
  const commands: EditorCommand[] = [];
  for (const file of Array.from(files)) {
    const url = URL.createObjectURL(file);
    const kind: MediaAsset["kind"] = file.type.startsWith("video") ? "video" : file.type.startsWith("audio") ? "audio" : "image";
    const asset: MediaAsset = { id: `up_${newClipId()}`, kind, name: file.name, durationUs: 0, url };
    if (kind === "video" || kind === "audio") {
      asset.durationUs = await probeDuration(url, kind);
    }
    commands.push({ kind: "setAsset" as const, assetId: asset.id, asset });
    // 探测失败或素材过短时不建 clip，避免违反文档不变量
    const usable = kind === "image" || asset.durationUs > 1_000_000;
    if (kind !== "audio" && usable) {
      const span = kind === "image" ? 5_000_000 : Math.min(asset.durationUs, 5_000_000);
      const clip = createClip({ assetId: asset.id, startUs: 0, endUs: span });
      commands.push(addClipCmd(clip, videoTrack.id));
    }
  }
  adapter.applyCommands([compositeCmd(commands)]);
  autosave();
  setToast(`已导入 ${files.length} 个媒体文件`);
}

function probeDuration(url: string, kind: "video" | "audio"): Promise<TimeUs> {
  return new Promise((resolve) => {
    if (kind === "audio") {
      const a = new Audio();
      a.src = url;
      a.onloadedmetadata = () => resolve(Math.round(a.duration * 1e6));
      a.onerror = () => resolve(0);
      return;
    }
    const v = document.createElement("video");
    v.preload = "metadata";
    v.src = url;
    v.onloadedmetadata = () => resolve(Math.round(v.duration * 1e6));
    v.onerror = () => resolve(0);
  });
}

export function saveToFile(): void {
  const json = state.adapter.save();
  const blob = new Blob([json], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${state.adapter.getProject().name.replace(/\s+/g, "-")}.cassie.json`;
  a.click();
  setToast("项目已导出为 .cassie.json");
}

export function loadFromFile(file: File): void {
  file.text().then((text) => {
    try {
      state.adapter.load(text);
      state.harness.setSemantic(emptySemantic(state.adapter.getProject().id));
      state.selectedEntityId = null;
      state.selectedClipId = null;
      autosave();
      setToast("项目已加载");
    } catch (err) {
      setToast(`加载失败：${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

export function autosave(): void {
  try {
    localStorage.setItem(
      "cassie:autosave",
      JSON.stringify({ project: state.adapter.save(), semantic: state.semantic }),
    );
  } catch {
    // localStorage 满时静默降级
  }
}

export function setExporting(v: boolean): void {
  state.exporting = v;
  emit();
}

// ---------- 工具 ----------

export function activeClipsAt(project: Project, timeUs: TimeUs): { trackId: string; clipId: ClipId }[] {
  const out: { trackId: string; clipId: ClipId }[] = [];
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.startUs <= timeUs && clip.endUs > timeUs) out.push({ trackId: track.id, clipId: clip.id });
    }
  }
  return out;
}

export function appearanceToCssFilter(attrs: Record<string, unknown>): string {
  const appearance = (attrs.appearance ?? {}) as Record<string, string>;
  const filters: string[] = [];
  if (appearance.variant === "matte_silver") filters.push("saturate(0.2)", "brightness(1.35)", "contrast(1.05)");
  if (appearance.variant === "glass_violet") filters.push("saturate(1.2)", "hue-rotate(-8deg)");
  if (appearance.color === "deep_blue") filters.push("hue-rotate(140deg)", "saturate(1.4)");
  if (appearance.color === "violet") filters.push("hue-rotate(-30deg)", "saturate(1.3)");
  return filters.join(" ");
}

export function assetIdOf(state: AppState, entityId: EntityId): AssetId | null {
  const entity = state.semantic.entities[entityId];
  if (!entity) return null;
  const bind = entity.binds.find((b) => b.targetType === "clip");
  if (!bind) return null;
  for (const track of state.adapter.getProject().tracks) {
    const clip = track.clips.find((c) => c.id === bind.targetId);
    if (clip) return clip.assetId;
  }
  return null;
}
