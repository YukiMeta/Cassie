import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@cassie/editor-core": fileURLToPath(new URL("../../packages/editor-core/src/index.ts", import.meta.url)),
      "@cassie/spec": fileURLToPath(new URL("../../packages/spec/src/index.ts", import.meta.url)),
      "@cassie/harness": fileURLToPath(new URL("../../packages/harness/src/index.ts", import.meta.url)),
    },
  },
  optimizeDeps: {
    exclude: ["@cassie/editor-core", "@cassie/spec", "@cassie/harness", "@ffmpeg/ffmpeg", "@ffmpeg/util"],
  },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
