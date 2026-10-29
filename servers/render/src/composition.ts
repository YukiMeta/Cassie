import type { Clip, MediaAsset, Project } from "../../../packages/editor-core/src/project";

/**
 * 项目文档 → HyperFrames HTML composition（纯函数）。
 *
 * 合成规则与 editor-core 的 buildExportPlan 保持一致，保证本地导出与服务端渲染画面同源：
 * - 第一条 video 轨道的第一个片段是底，之后的画面片段按轨道/片段顺序叠加（z-index 递增）
 * - 画面片段铺满画布（cover），叠加片段按 attrs.x / attrs.y 平移，attrs.opacity 生效
 * - text 轨道：左上角锚定在 (x, y)，字号按 1080 高度基准缩放
 * - audio 轨道：source 入点 + 时间线位置；画面片段的原声不进混音
 *
 * 动画运行时只允许原生 CSS / Web Animations：输出里不得出现 GSAP（许可证限制，见 docs/adr/002）。
 */
export interface CompositionAsset {
  assetId: string;
  /** 相对 composition 根目录的路径 */
  file: string;
}

export interface Composition {
  html: string;
  assets: CompositionAsset[];
  durationSec: number;
}

const COMPOSITION_ID = "cassie";

export function assetFileName(asset: MediaAsset): string {
  const ext = asset.name.includes(".") ? asset.name.split(".").pop()!.toLowerCase() : defaultExt(asset.kind);
  return `assets/${asset.id}.${ext.replace(/[^a-z0-9]/g, "") || defaultExt(asset.kind)}`;
}

function defaultExt(kind: MediaAsset["kind"]): string {
  return kind === "audio" ? "mp3" : kind === "image" ? "png" : "mp4";
}

const sec = (us: number) => Number((us / 1_000_000).toFixed(6));

export function buildComposition(project: Project): Composition {
  const { width, height, durationUs } = project.settings;
  const used = new Map<string, CompositionAsset>();
  const nodes: string[] = [];
  let z = 0;
  let hasBase = false;

  const fileOf = (clip: Clip): string | null => {
    if (!clip.assetId) return null;
    const asset = project.assets[clip.assetId];
    if (!asset) throw new Error(`clip ${clip.id} 引用缺失资产`);
    if (!used.has(asset.id)) used.set(asset.id, { assetId: asset.id, file: assetFileName(asset) });
    return used.get(asset.id)!.file;
  };

  for (const track of project.tracks.filter((t) => t.kind === "video")) {
    for (const clip of track.clips) {
      if (clip.endUs <= 0 || clip.endUs <= clip.startUs) continue;
      const file = fileOf(clip);
      if (!file) continue;
      const asset = project.assets[clip.assetId!]!;
      const style = [
        `z-index:${++z}`,
        hasBase ? `left:${px(clip.attrs.x, width)}px;top:${px(clip.attrs.y, height)}px` : "left:0;top:0",
        `width:${width}px;height:${height}px;object-fit:cover`,
        opacityCss(clip.attrs.opacity),
      ].filter(Boolean).join(";");
      hasBase = true;
      const timing = `data-start="${sec(clip.startUs)}" data-duration="${sec(clip.endUs - clip.startUs)}"`;
      if (asset.kind === "image") {
        nodes.push(`<img id="${domId(clip)}" class="clip media" src="${file}" ${timing} style="${style}" alt="" />`);
      } else {
        nodes.push(
          `<video id="${domId(clip)}" class="media" src="${file}" ${timing} data-media-start="${sec(clip.sourceInUs)}" muted playsinline style="${style}"></video>`,
        );
      }
    }
  }

  for (const track of project.tracks.filter((t) => t.kind === "text")) {
    for (const clip of track.clips) {
      const text = String(clip.attrs.text ?? "");
      if (!text || clip.endUs <= clip.startUs) continue;
      const fontSize = Math.round((clip.attrs.fontSize ?? 48) * (height / 1080));
      const style = [
        `z-index:${++z}`,
        `left:${px(clip.attrs.x ?? 0.5, width)}px;top:${px(clip.attrs.y ?? 0.5, height)}px`,
        `font-size:${fontSize}px`,
        `color:${cssValue(String(clip.attrs.color ?? "white"))}`,
        clip.attrs.fontFamily ? `font-family:${cssValue(String(clip.attrs.fontFamily))}` : "",
        opacityCss(clip.attrs.opacity),
      ].filter(Boolean).join(";");
      nodes.push(
        `<div id="${domId(clip)}" class="clip text" data-start="${sec(clip.startUs)}" data-duration="${sec(clip.endUs - clip.startUs)}" style="${style}">${escapeHtml(text)}</div>`,
      );
    }
  }

  for (const track of project.tracks.filter((t) => t.kind === "audio")) {
    for (const clip of track.clips) {
      const file = fileOf(clip);
      if (!file || clip.endUs <= clip.startUs) continue;
      const volume = typeof clip.attrs.volume === "number" ? ` data-volume="${clip.attrs.volume}"` : "";
      nodes.push(
        `<audio id="${domId(clip)}" src="${file}" data-start="${sec(clip.startUs)}" data-duration="${sec(clip.endUs - clip.startUs)}" data-media-start="${sec(clip.sourceInUs)}"${volume}></audio>`,
      );
    }
  }

  const durationSec = sec(durationUs);
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${width}, height=${height}" />
<style>
  html, body { margin: 0; background: #000; }
  #root { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; background: #000; }
  .media, .clip { position: absolute; }
  .text { white-space: pre; line-height: 1; font-family: "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif; }
</style>
</head>
<body>
<div id="root" data-composition-id="${COMPOSITION_ID}" data-start="0" data-duration="${durationSec}" data-width="${width}" data-height="${height}" data-no-timeline>
${nodes.map((n) => `  ${n}`).join("\n")}
</div>
</body>
</html>
`;
  if (/gsap/i.test(html)) throw new Error("composition 不允许引用 GSAP");
  return { html, assets: [...used.values()], durationSec };
}

function domId(clip: Clip): string {
  return `c_${clip.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function px(v: unknown, size: number): number {
  return Math.round(Number(v ?? 0) * size);
}

function opacityCss(v: unknown): string {
  const o = Number(v ?? 1);
  return o < 1 ? `opacity:${Math.max(0, o).toFixed(3)}` : "";
}

function cssValue(v: string): string {
  return v.replace(/[;"<>{}]/g, "");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
