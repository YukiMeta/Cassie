/// <reference lib="webworker" />
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

/**
 * 导出 worker：ffmpeg.wasm 本地执行，素材与产物都不离开浏览器。
 * 主线程发 run → 这里写文件、跑 filter_complex、回传 MP4 字节。
 */
interface RunPayload {
  requestId: number;
  inputs: { path: string; url: string }[];
  filterComplex: string;
  outputArgs: string[];
  fontFile?: string;
}

let ffmpeg: FFmpeg | null = null;

async function ensureLoaded(): Promise<FFmpeg> {
  if (ffmpeg && (ffmpeg as unknown as { loaded?: boolean }).loaded) return ffmpeg;
  if (!ffmpeg) {
    ffmpeg = new FFmpeg();
    ffmpeg.on("log", ({ message }) => self.postMessage({ type: "log", message }));
    ffmpeg.on("progress", ({ progress }) => self.postMessage({ type: "progress", progress }));
  }
  const base = "/ffmpeg";
  await ffmpeg.load({
    coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
  });
  (ffmpeg as unknown as { loaded?: boolean }).loaded = true;
  return ffmpeg;
}

self.onmessage = async (e: MessageEvent<{ type: string; payload: RunPayload }>) => {
  const { type, payload } = e.data;
  if (type !== "run") return;
  const { requestId, inputs, filterComplex, outputArgs, fontFile } = payload;
  try {
    const f = await ensureLoaded();
    self.postMessage({ type: "status", requestId, message: "写入素材…" });
    for (const input of inputs) {
      const data = await fetchFile(input.url);
      await f.writeFile(input.path, data);
    }
    if (fontFile) {
      const font = await fetchFile("/fonts/ARIALUNI.ttf");
      await f.writeFile(fontFile, font);
    }
    const args = [
      "-y",
      ...inputs.flatMap((i) => ["-i", i.path]),
      "-filter_complex",
      filterComplex,
      ...outputArgs,
      "/out.mp4",
    ];
    self.postMessage({ type: "status", requestId, message: "渲染中…" });
    await f.exec(args);
    const data = await f.readFile("/out.mp4");
    self.postMessage({ type: "done", requestId, data });
  } catch (err) {
    self.postMessage({
      type: "error",
      requestId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
