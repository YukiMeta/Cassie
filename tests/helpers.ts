import { createProject, type Clip, type Project, type Track } from "@cassie/editor-core";
import type { SemanticProject } from "@cassie/spec";

/**
 * NOCTURNE 测试夹具：15s 竖屏香水广告。
 * 所有 id 固定，保证 Golden 回归的确定性。
 */
export function makeFixtureProject(): Project {
  const p = createProject({
    name: "NOCTURNE · Director Cut",
    fps: 30,
    width: 1080,
    height: 1920,
    durationUs: 15_000_000,
  });
  p.id = "proj_nocturne";
  p.assets = {
    asset_night: { id: "asset_night", kind: "video", name: "night.mp4", durationUs: 15_000_000, width: 1080, height: 1920 },
    asset_mia: { id: "asset_mia", kind: "video", name: "mia.mp4", durationUs: 12_000_000, width: 1080, height: 1920 },
    asset_bottle: { id: "asset_bottle", kind: "video", name: "bottle.mp4", durationUs: 15_000_000, width: 1080, height: 1920 },
    asset_silver: { id: "asset_silver", kind: "video", name: "silver.mp4", durationUs: 15_000_000, width: 1080, height: 1920 },
    asset_music: { id: "asset_music", kind: "audio", name: "nocturne.mp3", durationUs: 15_000_000 },
  };
  p.tracks = [
    track("track_video", "video", "画面", [
      clip("clip_night", "asset_night", 0, 15_000_000),
      clip("clip_mia", "asset_mia", 0, 10_000_000, 0, { appearance: { identity: "locked" } }),
      clip("clip_bottle", "asset_bottle", 4_000_000, 15_000_000, 0, { appearance: { variant: "glass_violet" } }),
    ]),
    track("track_text", "text", "文字", [
      clip("clip_logo", null, 12_000_000, 15_000_000, 0, { text: "NOCTURNE", color: "white" }),
    ]),
    track("track_audio", "audio", "音乐", [clip("clip_music", "asset_music", 0, 15_000_000)]),
  ];
  return p;
}

export function makeSemanticProject(): SemanticProject {
  return {
    id: "sem_nocturne",
    editorProjectId: "proj_nocturne",
    entities: {
      product: {
        id: "product",
        name: "香水瓶 B",
        kind: "subject",
        reference: "@Nocturne_Bottle",
        lifecycle: { enterUs: 4_000_000, exitUs: 15_000_000 },
        attributes: { appearance: { variant: "glass_violet" } },
        binds: [{ targetType: "clip", targetId: "clip_bottle", role: "primary" }],
        locked: false,
      },
      character: {
        id: "character",
        name: "人物 A · Mia",
        kind: "subject",
        reference: "@Mia",
        lifecycle: { enterUs: 0, exitUs: 10_000_000 },
        attributes: { identity: "locked" },
        binds: [{ targetType: "clip", targetId: "clip_mia", role: "primary" }],
        locked: false,
      },
      scene: {
        id: "scene",
        name: "巴黎夜景",
        kind: "scene",
        reference: "@Paris_Night",
        lifecycle: { enterUs: 0, exitUs: 15_000_000 },
        attributes: {},
        binds: [{ targetType: "clip", targetId: "clip_night", role: "primary" }],
        locked: false,
      },
      logo: {
        id: "logo",
        name: "品牌文案",
        kind: "text",
        reference: "@Nocturne_Logo",
        lifecycle: { enterUs: 12_000_000, exitUs: 15_000_000 },
        attributes: {},
        binds: [{ targetType: "clip", targetId: "clip_logo", role: "primary" }],
        locked: false,
      },
    },
    relations: [
      { id: "rel_hold", type: "held_by", subjectId: "product", objectId: "character", windowUs: [4_000_000, 10_000_000] },
      { id: "rel_cut", type: "cut_to", subjectId: "product", objectId: "logo", windowUs: [10_000_000, 15_000_000] },
    ],
    constraints: [
      { id: "c_logo", kind: "preserve", what: "logo", scope: "global" },
      { id: "c_identity", kind: "preserve", what: "人物 A · Mia", scope: "global" },
      { id: "c_beat", kind: "anchor", what: "clip_music", anchorUs: 10_500_000, scope: "global" },
    ],
  };
}

function track(id: string, kind: Track["kind"], name: string, clips: Clip[]): Track {
  return { id, kind, name, locked: false, clips };
}

function clip(
  id: string,
  assetId: string | null,
  startUs: number,
  endUs: number,
  sourceInUs = 0,
  attrs: Clip["attrs"] = {},
): Clip {
  return { id, assetId, startUs, endUs, sourceInUs, attrs };
}

/**
 * Golden 归一化：把 nanoid 随机值替换为按首次出现顺序的 $1,$2…，
 * 使快照与运行环境无关。id 字段与文件名类字段都归一化。
 */
export function normalizeForGolden(value: unknown): unknown {
  const ids = new Map<string, string>();
  let counter = 0;
  const rewrite = (v: unknown, key: string | null): unknown => {
    if (v === null || v === undefined) return v;
    if (typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v === "string") {
      const isIdField = key === "id" || key === "assetId" || key === "clipId" || key === "trackId" || key === "editorProjectId";
      const looksGenerated = /^[\w-]{8,}$/.test(v) && isIdField;
      if (!looksGenerated) return v;
      if (!ids.has(v)) ids.set(v, `$${++counter}`);
      return ids.get(v);
    }
    if (Array.isArray(v)) return v.map((x) => rewrite(x, null));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = rewrite(val, k);
    return out;
  };
  return rewrite(value, null);
}
