import type { MediaAsset, Project } from "@cassie/editor-core";
import type { SemanticProject } from "./types";

/** Authored time is retained; resolved frame addresses are derived, never written back. */
export type EventStart = { frame: number } | { eventId: string; edge: "start" | "end"; offsetFrames: number };
export interface MotionKey { at: number; value: number }
export interface ActionState {
  label: string;
  durationFrames: number;
  /** Explicit, seek-safe normalized keyframes. No executable code in project files. */
  motion?: Record<string, MotionKey[]>;
}
export interface ActionDefinition {
  states: Record<string, ActionState>;
  execution: "keyframes" | "video-edit";
}
export interface SemanticEvent {
  id: string;
  entityId: string;
  kind: "action" | "reveal" | "caption" | "camera" | "sound" | "marker";
  start: EventStart;
  durationFrames: number;
  action?: { definitionId: string; state: string };
  /** Per-event retiming; never mutates a shared action preset. */
  durationOverrideFrames?: number;
  when?: { eventId: string; state: string };
  /** Disabled dependencies disable their consumers; they are never silently replaced with clock time. */
  clipId?: string;
  label: string;
  text?: string;
}
export interface ResolvedEvent {
  id: string;
  entityId: string;
  kind: SemanticEvent["kind"];
  startFrame: number;
  endFrame: number;
  active: boolean;
  state?: string;
  text?: string;
  disabledReason?: string;
}
export interface VisualLayer {
  id: string;
  entityId: string;
  kind: "person" | "card" | "text" | "video";
  eventId?: string;
  assetId?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  rotation?: number;
  text?: string;
  /** Source-pixel window of a video layer; lets one stacked/grid source become several independent panels. */
  crop?: { x: number; y: number; width: number; height: number };
  /** 0..1 strength of `color` applied as a hue/saturation grade on a video layer; luminance is kept. */
  tint?: number;
  /** Composition variables this layer reads; values come from the variant, then its axis values, then the default. */
  bind?: { text?: string; color?: string };
}
/** A value the master leaves open for each variant, like a HyperFrames composition variable. */
export interface CompositionVariable {
  id: string;
  label: string;
  type: "text" | "color";
  default: string;
}
/**
 * What a subject should look like in every variant: a reference image plus the concept prompt a
 * segmenter (SAM 3) uses to find the subject in each take. Changing it makes takes stale.
 */
export interface SubjectReference {
  entityId: string;
  /**
   * Axis id → value id this reference applies to; absent means every variant. A product swap is
   * global, a host is per market. The most specific matching reference wins.
   */
  scope?: Record<string, string>;
  assetId: string;
  sha256: string;
  prompt: string;
  instruction: string;
}
export interface MediaReference {
  /** Portable project-relative path; no credentials or network URLs. */
  path: string;
  sha256: string;
}
/** Grayscale white=foreground mask for one confirmed single-person source window. */
export interface SubjectMatte {
  entityId: string;
  eventId: string;
  sourceAssetId: string;
  sourceSha256: string;
  sourceStartFrame: number;
  frames: number;
  width: number;
  height: number;
  frameRate: { num: number; den: number };
  maskAssetId: string;
  backend: string;
  quality: "draft" | "reviewed";
}
/** User-confirmed key box; source pixels, top-left origin. */
export interface RegionKey { sourceFrame: number; box: [number, number, number, number] }
/**
 * A tracked part of a shot (e.g. one prop or vehicle) as its minimal bounding box on every source frame.
 * Boxes are keyed by source frame, so retiming or trimming the shot keeps the region on the same pixels.
 */
export interface SubjectRegion {
  id: string;
  entityId: string;
  /** Timeline event spanning the tracked lifecycle; anchored to the shot event. */
  eventId: string;
  layerId: string;
  sourceAssetId: string;
  sourceSha256: string;
  /** First source frame of `boxes`. */
  sourceStartFrame: number;
  keys: RegionKey[];
  /** One entry per source frame from `sourceStartFrame`; empty where the subject is absent. */
  boxes: number[][];
  confidence: number[];
  backend: string;
  /** Applied on every frame of the lifecycle. `tint` 0..1 recolours the box content keeping luminance. */
  look: { color: string; tint: number; feather: number };
  /**
   * Reviewed regenerated shot whose pixels replace the source only inside the tracked box (grown by
   * `pad` source px, edge-feathered by `look.feather`). Outside the box the original stays untouched.
   */
  replacement?: {
    assetId: string; sha256: string; pad: number; provider: string; review: string; instruction: string;
    /**
     * The new object tracked in the candidate (candidate pixels, one entry per candidate frame). Each
     * frame the candidate is moved so its box centre meets the source box centre, at uniform `scale`.
     * Without it the candidate is assumed pixel-aligned with the source.
     */
    align?: { boxes: number[][]; fps: number; width: number; height: number; scale: number };
  };
}
/** One dimension a family of variants differs along: market, aspect ratio, location… */
export interface VariantAxis {
  id: string;
  label: string;
  /** `attrs` carries what the value means to a generator, e.g. `{ language: "日本語" }` or `{ aspect: "9x16" }`. */
  values: { id: string; label: string; attrs?: Record<string, string> }[];
}
/** A rendered deliverable for one variant. Durations and canvas are its own, not the master's. */
export interface VariantTake {
  assetId: string;
  sha256: string;
  width: number;
  height: number;
  durationUs: number;
  provider: string;
  /** Subject entity → sha256 of the reference this take was made with. Absent means the master's original look. */
  basis?: Record<string, string>;
}
export interface Variant {
  id: string;
  /** Axis id → value id. Each combination exists at most once. */
  coords: Record<string, string>;
  /** Direction for this variant only, layered over the set's shared brief. */
  brief?: string;
  /** Variable id → value for this variant only. */
  values?: Record<string, string>;
  take?: VariantTake;
  review: "pending" | "approved" | "rejected";
  note?: string;
}
/** Everything derived from one original: what stays, what changes per axis, and each variant's take. */
export interface VariantSet {
  masterAssetId: string;
  /** Story facts every variant must keep from the master (beats, product, call to action…). */
  keep: string[];
  brief: string;
  axes: VariantAxis[];
  items: Record<string, Variant>;
}
export interface EventDocument {
  editor: Project;
  semantic: SemanticProject;
  frameRate: { num: number; den: number };
  actions: Record<string, ActionDefinition>;
  events: SemanticEvent[];
  scene: { background: string; layers: VisualLayer[] };
  media: Record<string, MediaReference>;
  subjectMattes?: Record<string, SubjectMatte>;
  regions?: Record<string, SubjectRegion>;
  variants?: VariantSet;
  variables?: Record<string, CompositionVariable>;
  /** Keyed by `subjectRefKey(entityId, scope)`. */
  subjectRefs?: Record<string, SubjectReference>;
}
export interface ActionEdit {
  kind: "set-action-state";
  eventId: string;
  state: string;
  /** User-authored video-edit state; compiled and committed with the action transaction. */
  instruction?: string;
  durationFrames?: number;
}
export type DocumentEdit =
  | { kind: "attach-subject-matte"; eventId: string; matte: SubjectMatte; asset: MediaAsset; media: MediaReference }
  | { kind: "track-region"; region: SubjectRegion; name?: string }
  | { kind: "set-region-replacement"; regionId: string; replacement: NonNullable<SubjectRegion["replacement"]> | null; asset?: MediaAsset; media?: MediaReference }
  | { kind: "set-region-look"; regionId: string; patch: Partial<SubjectRegion["look"]> }
  | { kind: "set-event-timing"; eventId: string; startFrame: number; durationFrames: number }
  | { kind: "set-layer"; layerId: string; patch: Partial<Pick<VisualLayer, "x" | "y" | "width" | "height" | "rotation" | "color" | "text" | "tint">> }
  | { kind: "set-variant-set"; set: Omit<VariantSet, "items"> }
  | { kind: "add-variants"; items: Variant[] }
  | { kind: "remove-variants"; ids: string[] }
  | { kind: "attach-variant-take"; variantId: string; take: VariantTake; asset: MediaAsset; media: MediaReference }
  | { kind: "review-variant"; variantId: string; review: Variant["review"]; note?: string; brief?: string }
  | { kind: "set-variable"; variable: CompositionVariable }
  /** Box is a 0..1 fraction of the canvas so the overlay can be placed on any variant aspect. */
  /** `anchor: "end"` keeps an end card the same distance from the end in variants of another length. */
  | { kind: "add-overlay-text"; layerId: string; label: string; text?: string; bind?: string; color: string; startFrame: number; durationFrames: number; box: { x: number; y: number; width: number; height: number }; anchor?: "start" | "end" }
  | { kind: "set-variant-values"; variantId: string; values: Record<string, string> }
  | { kind: "set-subject-reference"; entityId: string; name?: string; scope?: Record<string, string>; reference: SubjectReference | null; asset?: MediaAsset; media?: MediaReference };
export interface DocumentEditPlan {
  id: string;
  status: "ready";
  baseRevision: number;
  base: EventDocument;
  edit: DocumentEdit;
  changes: EventChange[];
  next: EventDocument;
}
export interface EventChange {
  eventId: string;
  before: ResolvedEvent;
  after: ResolvedEvent;
  cause: string;
}
export interface GenerationTask {
  id: string;
  capability: "video-edit";
  eventId: string;
  entityId: string;
  sourceAssetId: string;
  source: MediaReference;
  sourceInUs: number;
  sourceDurationUs: number;
  outputFrames: number;
  frameRate: { num: number; den: number };
  requestedState: string;
  instruction: string;
  preserveEntityIds: string[];
  /** A flattened source requires a shot edit, not a guaranteed isolated pixel edit. */
  scope: "shot";
  /** Optional subject selection guidance. Output remains a full composited shot. */
  selection?: { matte: SubjectMatte; mask: MediaReference };
}
export interface GenerationReceipt {
  taskId: string;
  assetId: string;
  media: MediaReference;
  frames: number;
  width: number;
  height: number;
  frameRate: { num: number; den: number };
  provider: string;
  /** Human review is explicit; file validity alone cannot prove identity/action quality. */
  review: { accepted: true; note: string };
}
export interface ActionPlan {
  id: string;
  status: "ready" | "awaiting-media";
  baseRevision: number;
  /** Exact optimistic concurrency check, including semantics and asset provenance. */
  base: EventDocument;
  edit: ActionEdit;
  changes: EventChange[];
  tasks: GenerationTask[];
}
export type PatchOp =
  | { op: "set"; path: (string | number)[]; value: unknown }
  | { op: "del"; path: (string | number)[] };
/** History stores what changed, never whole documents. Revision is excluded from both patches. */
export interface EventTransaction {
  id: string;
  status: "committed" | "rolled-back";
  edit: ActionEdit | DocumentEdit;
  baseRevision: number;
  changes: EventChange[];
  tasks?: GenerationTask[];
  patch: PatchOp[];
  inverse: PatchOp[];
  /** Digest of the committed document, so rollback can tell whether later content exists. */
  afterDigest: string;
  receipts: GenerationReceipt[];
  journal: { type: string; revision: number; detail: string }[];
}
export interface EventWorkspace {
  schema: "cassie/events@1";
  document: EventDocument;
  transactions: EventTransaction[];
}
