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
import { Harness, parseIntent, type EditTransaction, type Intent, type Scope } from "@cassie/harness";
import { llmParseIntent, type LlmConfig, type RenderConfig, type VisionConfig } from "./lib/model-client";
import type { DocumentEdit, EntityId, EventDocument, EventWorkspace, ResolvedEvent, SemanticEntity, SemanticProject, SubjectRegion } from "@cassie/spec";
import { projectToJson } from "@cassie/editor-core";
import * as rt from "./lib/runtime";
import type { DetectedObject } from "./lib/runtime";

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
  /** 用户自填模型配置（BYOK，localStorage 持久化） */
  modelConfig: ModelConfigState;
  /** 设置面板是否打开 */
  settingsOpen: boolean;
  /** 意图解析模式：llm = 走用户配置的模型（失败回退），deterministic = 关键词 */
  parseMode: "llm" | "deterministic";
  /** LLM 解析进行中（UI 用） */
  parsing: boolean;
  /** 分区布局：面板 ↔ 槽位 映射 + 尺寸（可拖拽重排、双向调尺寸，持久化） */
  layout: LayoutState;
  /** 连接本机运行时时的工程（唯一事实源）；为 null 时是浏览器内离线演示 */
  runtime: RuntimeState | null;
  /** 当前选中的局部主体区域（属于 selectedEntityId） */
  selectedRegionId: string | null;
  /** 画布上的物体识别结果（未认领） */
  detection: { layerId: string; sourceFrame: number; objects: DetectedObject[] } | null;
  /** 运行时任务进行中的说明（识别、跟踪、渲染） */
  busy: string | null;
}

export interface RuntimeState {
  workspace: EventWorkspace;
  document: EventDocument;
  events: ResolvedEvent[];
}

export interface ModelConfigState {
  llm: LlmConfig;
  vision: VisionConfig;
  render: RenderConfig;
}

/** 四个分区面板 */
export type PanelId = "script" | "stage" | "agent" | "timeline";
export type SlotId = "left" | "center" | "right" | "bottom";

export interface LayoutState {
  /** 槽位 → 面板分配 */
  slots: Record<SlotId, PanelId>;
  /** 左/右槽宽（px）与底部槽高（px） */
  sizes: { leftW: number; rightW: number; bottomH: number };
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
    modelConfig: loadModelConfig(),
    settingsOpen: false,
    parseMode: "llm",
    parsing: false,
    layout: loadLayout(),
    runtime: null,
    selectedRegionId: null,
    detection: null,
    busy: null,
  };
  adapter.subscribe(() => emit());
  // 运行时工程优先；连不上再恢复本地 autosave / 演示项目。
  void connectRuntime().then((ok) => {
    if (ok || state.booted) return;
    const raw = localStorage.getItem("cassie:autosave");
    if (!raw) {
      emit();
      return;
    }
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
    emit();
  });
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
  const owned = entityId ? regionsOf(entityId) : [];
  if (!owned.some((r) => r.id === state.selectedRegionId)) state.selectedRegionId = owned[0]?.id ?? null;
  emit();
}

export function toggleEntityLock(entityId: EntityId): void {
  const entity = state.semantic.entities[entityId];
  if (!entity) return;
  entity.locked = !entity.locked;
  state.harness.setSemantic(state.semantic);
  setToast(entity.locked ? `${entity.name} 已锁定（编译将阻断）` : `${entity.name} 已解锁`);
}

/** 语义提取结果落库：注册实体（绑定 clip）并同步 Harness */
export function addSemanticEntities(entities: SemanticEntity[]): number {
  let added = 0;
  for (const e of entities) {
    if (state.semantic.entities[e.id]) continue;
    state.semantic.entities[e.id] = e;
    added++;
  }
  if (added > 0) {
    state.harness.setSemantic(state.semantic);
    autosave();
    emit();
  }
  return added;
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
  if (state.runtime) {
    const tx = state.runtime.workspace.transactions.filter((t) => t.status === "committed").at(-1);
    if (!tx) return;
    void runtimeTask("撤销中…", async () => {
      await rt.rollback(tx.id);
      await reloadRuntime();
      setToast("已撤销最近一次修改");
    });
    return;
  }
  state.adapter.undo();
}
export function redo(): void {
  if (state.runtime) {
    setToast("运行时工程暂不支持重做：撤销记录保存在历史里");
    return;
  }
  state.adapter.redo();
}

// ---------- 运行时工程 ----------

/** 运行时可用时，工程以运行时文件为准：编辑全部走服务端事务，可撤销、可复验。 */
export async function connectRuntime(): Promise<boolean> {
  if (!(await rt.runtimeAvailable())) return false;
  try {
    await reloadRuntime();
    state.booted = true;
    state.playheadUs = 0;
    emit();
    return true;
  } catch (err) {
    setToast(`运行时工程读取失败：${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function reloadRuntime(): Promise<void> {
  const { workspace, events } = await rt.fetchProject();
  const document = workspace.document;
  state.runtime = { workspace, document, events };
  state.adapter.load(projectToJson(document.editor));
  state.adapter.rehydrate((id) => (document.media[id] ? rt.mediaUrl(id) : undefined));
  state.semantic = document.semantic;
  state.harness.setSemantic(state.semantic);
  if (state.selectedRegionId && !document.regions?.[state.selectedRegionId]) state.selectedRegionId = null;
  if (state.selectedEntityId && !document.semantic.entities[state.selectedEntityId]) state.selectedEntityId = null;
  emit();
}

async function runtimeTask<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (state.busy) {
    setToast(`请等待：${state.busy}`);
    return undefined;
  }
  state.busy = label;
  emit();
  try {
    return await fn();
  } catch (err) {
    setToast(err instanceof Error ? err.message : String(err));
    await reloadRuntime().catch(() => undefined);
    return undefined;
  } finally {
    state.busy = null;
    emit();
  }
}

export function runtimeEdit(edit: DocumentEdit, done?: string): Promise<unknown> {
  return runtimeTask("保存中…", async () => {
    await rt.applyEdit(state.runtime!.document.editor.revision, edit);
    await reloadRuntime();
    if (done) setToast(done);
  });
}

const frameRate = (d: EventDocument) => d.frameRate.num / d.frameRate.den;

/** 时间线手势落盘：片段或主体轨道对应的语义事件，按整帧写回。 */
export function commitEventTiming(eventId: string, startUs: TimeUs, endUs: TimeUs): void {
  const r = state.runtime;
  if (!r) return;
  const fps = frameRate(r.document);
  const startFrame = Math.max(0, Math.round((startUs / 1e6) * fps));
  const durationFrames = Math.max(1, Math.round(((endUs - startUs) / 1e6) * fps));
  const old = r.events.find((e) => e.id === eventId);
  if (old && old.startFrame === startFrame && old.endFrame - old.startFrame === durationFrames) return;
  void runtimeEdit({ kind: "set-event-timing", eventId, startFrame, durationFrames }, "时间已更新；依赖事件已重新计算");
}

export function eventOfClip(clipId: string): string | null {
  return state.runtime?.document.events.find((e) => e.clipId === clipId)?.id ?? null;
}

export function regionsOf(entityId: EntityId): SubjectRegion[] {
  return Object.values(state.runtime?.document.regions ?? {}).filter((r) => r.entityId === entityId);
}

export function selectRegion(regionId: string | null): void {
  const region = regionId ? state.runtime?.document.regions?.[regionId] : undefined;
  state.selectedRegionId = region?.id ?? null;
  if (region) state.selectedEntityId = region.entityId;
  state.selectedClipId = null;
  emit();
}

/** 当前播放头处的视频镜头层（识别物体的目标）。 */
export function videoLayerAt(frame: number) {
  const r = state.runtime;
  if (!r) return null;
  return r.document.scene.layers.find((l) => {
    if (l.kind !== "video" || !l.eventId) return false;
    const e = r.events.find((x) => x.id === l.eventId);
    return e?.active && e.startFrame <= frame && frame < e.endFrame;
  }) ?? null;
}

export function playheadFrame(): number {
  return state.runtime ? Math.round((state.playheadUs / 1e6) * frameRate(state.runtime.document)) : 0;
}

export function detectAtPlayhead(): void {
  const layer = videoLayerAt(playheadFrame());
  if (!layer) {
    setToast("当前帧没有视频镜头");
    return;
  }
  state.playing = false;
  void runtimeTask("正在识别当前帧中的物体…", async () => {
    const result = await rt.detectObjects(layer.id, playheadFrame());
    state.detection = result;
    setToast(result.objects.length ? `识别到 ${result.objects.length} 个物体：点击一个框，单独选中并跟踪它` : "没有识别到物体");
  });
}

export function clearDetection(): void {
  state.detection = null;
  emit();
}

/** 认领识别框：在整个镜头内跟踪，生成局部主体区域（同名物体跨镜头归入同一主体）。 */
export function claimDetected(object: DetectedObject): void {
  const det = state.detection;
  if (!det || !state.runtime) return;
  const before = new Set(Object.keys(state.runtime.document.regions ?? {}));
  const sameName = Object.values(state.semantic.entities).find((e) => e.attributes.regions && e.name === object.label);
  void runtimeTask(`正在跟踪「${object.label}」…`, async () => {
    await rt.claimRegion(state.runtime!.document.editor.revision, det.layerId, det.sourceFrame, object.box, object.label, sameName?.id);
    state.detection = null;
    await reloadRuntime();
    const created = Object.values(state.runtime!.document.regions ?? {}).find((r) => !before.has(r.id));
    if (created) selectRegion(created.id);
    setToast(`已选中「${object.label}」：在右侧直接修改，只作用于物体框内`);
  });
}

export function setRegionLook(regionIds: string[], patch: Partial<SubjectRegion["look"]>): void {
  void runtimeTask("保存中…", async () => {
    for (const id of regionIds) {
      await rt.applyEdit(state.runtime!.document.editor.revision, { kind: "set-region-look", regionId: id, patch });
      await reloadRuntime();
    }
  });
}

export async function exportRuntime(): Promise<string | undefined> {
  return runtimeTask("渲染中…", () => rt.renderJob((m) => {
    state.busy = m;
    emit();
  }));
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

// ---------- 模型配置（BYOK） ----------

const MODEL_CONFIG_KEY = "cassie:model-config";

export function loadModelConfig(): ModelConfigState {
  const defaults: ModelConfigState = {
    llm: {
      enabled: false,
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "",
      model: "deepseek-chat",
    },
    vision: { enabled: false, baseUrl: "http://localhost:8000", apiKey: "" },
    render: { enabled: false, baseUrl: "http://localhost:8797", apiKey: "" },
  };
  try {
    const raw = localStorage.getItem(MODEL_CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ModelConfigState>;
      return {
        llm: { ...defaults.llm, ...(parsed.llm ?? {}) },
        vision: { ...defaults.vision, ...(parsed.vision ?? {}) },
        render: { ...defaults.render, ...(parsed.render ?? {}) },
      };
    }
  } catch {
    // 配置损坏时用默认值
  }
  return defaults;
}

export function saveModelConfig(config: ModelConfigState): void {
  state.modelConfig = config;
  state.parseMode = config.llm.enabled ? "llm" : "deterministic";
  try {
    localStorage.setItem(MODEL_CONFIG_KEY, JSON.stringify(config));
  } catch {
    // localStorage 满时静默降级
  }
  emit();
}

export function setSettingsOpen(open: boolean): void {
  state.settingsOpen = open;
  emit();
}

// ---------- 分区布局 ----------

const LAYOUT_KEY = "cassie:layout";

export function loadLayout(): LayoutState {
  const defaults: LayoutState = {
    slots: { left: "script", center: "stage", right: "agent", bottom: "timeline" },
    sizes: { leftW: 264, rightW: 336, bottomH: 208 },
  };
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LayoutState>;
      return {
        slots: { ...defaults.slots, ...(parsed.slots ?? {}) },
        sizes: { ...defaults.sizes, ...(parsed.sizes ?? {}) },
      };
    }
  } catch {
    // 损坏时用默认
  }
  return defaults;
}

export function saveLayout(layout: LayoutState): void {
  state.layout = layout;
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // localStorage 满时静默降级
  }
  emit();
}

/** 交换两个槽位的面板 */
export function swapSlots(a: SlotId, b: SlotId): void {
  const slots = { ...state.layout.slots };
  const tmp = slots[a];
  slots[a] = slots[b];
  slots[b] = tmp;
  saveLayout({ ...state.layout, slots });
}

export function setSlotSize(patch: Partial<LayoutState["sizes"]>): void {
  saveLayout({ ...state.layout, sizes: { ...state.layout.sizes, ...patch } });
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
  // v= 版本号：素材重制后强制浏览器放弃旧缓存。
  const V = "v=20260817";
  const assets: MediaAsset[] = [
    { id: "demo_night", kind: "video", name: "night.mp4", durationUs: 15_000_000, url: `/demo/night.mp4?${V}`, meta: { thumb: `/demo/thumbs/night.jpg?${V}` } },
    { id: "demo_mia", kind: "video", name: "mia.mp4", durationUs: 12_000_000, url: `/demo/mia.mp4?${V}`, meta: { thumb: `/demo/thumbs/mia.jpg?${V}` } },
    { id: "demo_bottle", kind: "video", name: "bottle.mp4", durationUs: 15_000_000, url: `/demo/bottle.mp4?${V}`, meta: { thumb: `/demo/thumbs/bottle.jpg?${V}` } },
    { id: "demo_music", kind: "audio", name: "music.mp3", durationUs: 15_000_000, url: `/demo/music.mp3?${V}` },
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

/**
 * 智能编译：配置了 LLM 时走模型解析（失败自动回退确定性解析器）。
 * parseMode=deterministic 或未配置 key 时直接走确定性路径。
 */
export async function compileIntentSmart(text: string, scopeOverride?: Scope): Promise<EditTransaction> {
  const ctx = {
    playheadUs: state.playheadUs,
    selectedEntityId: state.selectedEntityId ?? undefined,
  };
  let intent: Intent;
  if (state.parseMode === "llm" && state.modelConfig.llm.enabled && state.modelConfig.llm.apiKey) {
    state.parsing = true;
    emit();
    try {
      intent = await llmParseIntent(state.modelConfig.llm, text, {
        playheadUs: state.playheadUs,
        entities: Object.values(state.semantic.entities).map((e) => ({
          id: e.id,
          name: e.name,
          reference: e.reference,
        })),
      });
      setToast(`已用 ${state.modelConfig.llm.model} 解析意图`);
    } catch (err) {
      setToast(`模型解析失败，回退本地解析：${err instanceof Error ? err.message.slice(0, 80) : "未知错误"}`);
      intent = parseIntent(text, ctx);
    } finally {
      state.parsing = false;
      emit();
    }
  } else {
    intent = parseIntent(text, ctx);
  }
  if (scopeOverride) intent.scope = scopeOverride;
  const tx = state.harness.compileFromIntent(intent, ctx);
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

export interface Keyframe {
  /** 相对 clip 入点的时间（µs） */
  tUs: TimeUs;
}

/** 在播放头处给所选片段 加/删 关键帧（0.5s 吸附，可撤销） */
export function toggleKeyframe(clipId: ClipId): void {
  const project = state.adapter.getProject();
  let clip: { startUs: TimeUs; endUs: TimeUs; attrs: Record<string, unknown> } | null = null;
  for (const track of project.tracks) {
    const c = track.clips.find((x) => x.id === clipId);
    if (c) clip = c;
  }
  if (!clip) return;
  const rel = Math.max(0, Math.min(clip.endUs - clip.startUs - 1, state.playheadUs - clip.startUs));
  const snapped = Math.round(rel / 500_000) * 500_000;
  const kfs: Keyframe[] = Array.isArray(clip.attrs.keyframes)
    ? (clip.attrs.keyframes as Keyframe[])
    : [];
  const idx = kfs.findIndex((k) => Math.abs(k.tUs - snapped) <= 250_000);
  if (idx >= 0) {
    kfs.splice(idx, 1);
    setToast("已删除关键帧");
  } else {
    kfs.push({ tUs: snapped });
    kfs.sort((a, b) => a.tUs - b.tUs);
    setToast(`已标记关键帧 @${(snapped / 1e6).toFixed(1)}s`);
  }
  state.adapter.applyCommands([setClipAttrsCmd(clipId, { keyframes: kfs })]);
  autosave();
}

export function hasKeyframeAtPlayhead(clipId: ClipId): boolean {
  const project = state.adapter.getProject();
  for (const track of project.tracks) {
    const c = track.clips.find((x) => x.id === clipId);
    if (!c) continue;
    if (!Array.isArray(c.attrs.keyframes)) return false;
    const rel = state.playheadUs - c.startUs;
    const snapped = Math.round(rel / 500_000) * 500_000;
    return (c.attrs.keyframes as Keyframe[]).some((k) => Math.abs(k.tUs - snapped) <= 250_000);
  }
  return false;
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
