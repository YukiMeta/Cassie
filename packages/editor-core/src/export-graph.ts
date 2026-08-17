import type { Clip, MediaAsset, Project, Track } from "./project";
import { seconds, type TimeUs } from "./time";

/**
 * 从项目文档编译 ffmpeg 执行计划（纯函数，可回归测试）。
 * 预览（video element 合成）与导出共享同一文档模型 —— 这里是确定性的一半。
 *
 * 图形规则（v1）：
 * - 第一条 video 轨道是底；其余 video 轨道按序 overlay（full-canvas，支持 x/y/scale/opacity）
 * - text 轨道 → drawtext 滤镜
 * - audio 轨道 → adelay + amix
 * - 画面裁剪用 trim=start:end + setpts 平移时间轴；出点不含
 */
export interface ExportInput {
  assetId: string;
  /** ffmpeg 输入路径（内存文件系统路径，如 `/assets/abc.mp4`） */
  path: string;
  kind: MediaAsset["kind"];
  /** image 需要 loop；video 直接读；audio 只取音频流 */
  extra?: string[];
}

export interface ExportPlan {
  inputs: ExportInput[];
  filterComplex: string;
  outputArgs: string[];
  /** 全片时长（s），供 UI 估算 */
  durationSec: number;
}

export interface ExportOptions {
  fontFile?: string; // drawtext 字体文件路径（ffmpeg 内存文件系统内）
  videoBitrate?: string;
  audioBitrate?: string;
}

export function buildExportPlan(project: Project, opts: ExportOptions = {}): ExportPlan {
  const { width, height, fps, durationUs } = project.settings;
  const inputs: ExportInput[] = [];
  const inputIndex = new Map<string, number>(); // assetId → 输入序号

  const registerInput = (clip: Clip): number | null => {
    if (clip.assetId === null) return null;
    const asset = project.assets[clip.assetId];
    if (!asset) throw new Error(`clip ${clip.id} 引用缺失资产`);
    const key = asset.id;
    if (!inputIndex.has(key)) {
      inputIndex.set(key, inputs.length);
      const ext = asset.name.includes(".") ? asset.name.split(".").pop()?.toLowerCase() : "mp4";
      inputs.push({
        assetId: asset.id,
        path: `/assets/${asset.id}.${ext ?? "mp4"}`,
        kind: asset.kind,
        extra: asset.kind === "image" ? ["-loop", "1"] : undefined,
      });
    }
    return inputIndex.get(key)!;
  };

  const videoTracks = project.tracks.filter((t) => t.kind === "video");
  const textTracks = project.tracks.filter((t) => t.kind === "text");
  const audioTracks = project.tracks.filter((t) => t.kind === "audio");

  const chains: string[] = [];
  let videoBase: string | null = null;
  const audioNodes: string[] = [];

  // --- 画面 ---
  for (const track of videoTracks) {
    for (const clip of track.clips) {
      if (clip.endUs <= 0) continue;
      const idx = registerInput(clip);
      const startSec = seconds(clip.startUs).toFixed(6);
      const durSec = seconds(clip.endUs - clip.startUs).toFixed(6);
      const label = `v${clip.id}`;
      if (clip.assetId === null || idx === null) continue;
      const asset = project.assets[clip.assetId]!;

      if (asset.kind === "image") {
        const opacitySuffix =
          Number(clip.attrs.opacity ?? 1) < 1
            ? `,format=rgba,colorchannelmixer=aa=${Number(clip.attrs.opacity).toFixed(3)}`
            : "";
        chains.push(
          `[${idx}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}${opacitySuffix}` +
            `,setpts=PTS-STARTPTS+${startSec}/TB,trim=duration=${durSec}[${label}]`,
        );
      } else {
        const srcIn = seconds(clip.sourceInUs).toFixed(6);
        const opacitySuffix =
          Number(clip.attrs.opacity ?? 1) < 1
            ? `,format=rgba,colorchannelmixer=aa=${Number(clip.attrs.opacity).toFixed(3)}`
            : "";
        chains.push(
          `[${idx}:v]trim=start=${srcIn}:duration=${durSec},setpts=PTS-STARTPTS+${startSec}/TB,` +
            `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}${opacitySuffix}[${label}]`,
        );
      }

      if (videoBase === null) {
        videoBase = label;
      } else {
        const { x, y } = overlayParams(clip, width, height);
        const merged = `m${clip.id}`;
        const enable = `enable='between(t,${startSec},${seconds(clip.endUs).toFixed(6)})'`;
        chains.push(`[${videoBase}][${label}]overlay=x=${x}:y=${y}:${enable}[${merged}]`);
        videoBase = merged;
      }
    }
  }

  // 兜底黑场（无任何画面 clip 时）
  if (videoBase === null) {
    const durSec = seconds(durationUs).toFixed(6);
    chains.push(
      `color=c=black:s=${width}x${height}:r=${fps}:d=${durSec}[vbase]`,
    );
    videoBase = "vbase";
  }

  // --- 文字 ---
  for (const track of textTracks) {
    for (const clip of track.clips) {
      const text = String(clip.attrs.text ?? "");
      if (!text) continue;
      const startSec = seconds(clip.startUs).toFixed(6);
      const endSec = seconds(clip.endUs).toFixed(6);
      const label = `t${clip.id}`;
      const fontFile = opts.fontFile ? `:fontfile='${opts.fontFile}'` : "";
      const fontSize = Math.round((clip.attrs.fontSize ?? 48) * (height / 1080));
      const px = Math.round((clip.attrs.x ?? 0.5) * width);
      const py = Math.round((clip.attrs.y ?? 0.5) * height);
      const color = clip.attrs.color ?? "white";
      const alpha = clip.attrs.opacity ?? 1;
      chains.push(
        `drawtext=text='${escapeDrawtext(text)}'${fontFile}:fontsize=${fontSize}:fontcolor=${color}@${alpha}` +
          `:x=${px}:y=${py}:enable='between(t,${startSec},${endSec})'[${label}]`,
      );
      const merged = `mt${clip.id}`;
      chains.push(`[${videoBase}][${label}]overlay=0:0[${merged}]`);
      videoBase = merged;
    }
  }

  // --- 音频 ---
  for (const track of audioTracks) {
    for (const clip of track.clips) {
      if (clip.assetId === null) continue;
      const idx = registerInput(clip);
      if (idx === null) continue;
      const startSec = seconds(clip.startUs).toFixed(6);
      const srcIn = seconds(clip.sourceInUs).toFixed(6);
      const durSec = seconds(clip.endUs - clip.startUs).toFixed(6);
      const label = `a${clip.id}`;
      chains.push(
        `[${idx}:a]atrim=start=${srcIn}:duration=${durSec},asetpts=PTS-STARTPTS,` +
          `adelay=${Math.round(clip.startUs / 1000)}:all=1[${label}]`,
      );
      audioNodes.push(label);
    }
  }

  let audioOut: string | null = null;
  if (audioNodes.length > 0) {
    const joined = audioNodes.join("[");
    chains.push(
      `[${joined}]amix=inputs=${audioNodes.length}:duration=longest:normalize=0[aout]`,
    );
    audioOut = "aout";
  }

  const durSec = seconds(durationUs).toFixed(6);
  const outputArgs = [
    "-t", durSec,
    "-r", String(fps),
    "-s", `${width}x${height}`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-b:v", opts.videoBitrate ?? "4M",
  ];
  if (audioOut) {
    outputArgs.push("-c:a", "aac", "-b:a", opts.audioBitrate ?? "192k");
  }

  const filterComplex = chains.join(";");
  return {
    inputs,
    filterComplex,
    outputArgs,
    durationSec: seconds(durationUs),
  };
}

function overlayParams(
  clip: Clip,
  width: number,
  height: number,
): { x: number; y: number; scale: number; opacity: number } {
  const x = Math.round((clip.attrs.x ?? 0) * width);
  const y = Math.round((clip.attrs.y ?? 0) * height);
  return {
    x,
    y,
    scale: Number(clip.attrs.scale ?? 1),
    opacity: Number(clip.attrs.opacity ?? 1),
  };
}

function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%")
    .replace(/,/g, "\\,");
}

/** 项目里被实际引用的资产（导出时需写入内存文件系统） */
export function usedAssets(project: Project): MediaAsset[] {
  const used = new Set<string>();
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.assetId) used.add(clip.assetId);
    }
  }
  return [...used].map((id) => project.assets[id]).filter(Boolean);
}

/** 项目总时长是否被有效内容覆盖（Golden 测试断言用） */
export function coverage(project: Project): { trackId: string; covered: [TimeUs, TimeUs][] }[] {
  return project.tracks.map((track: Track) => ({
    trackId: track.id,
    covered: track.clips
      .map((c) => [c.startUs, c.endUs] as [TimeUs, TimeUs])
      .sort((a, b) => a[0] - b[0]),
  }));
}
