import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

/**
 * 模型代理：浏览器把用户自填的 baseUrl/apiKey 随请求发给本机 dev server，
 * 由这里转发到目标模型服务。key 只在用户自己的机器上流动。
 * 生产部署时需要等价的 serverless 代理（见 docs/semantic-pipeline.md）。
 */
function modelProxy(): Plugin {
  return {
    name: "cassie-model-proxy",
    configureServer(server) {
      server.middlewares.use("/api/llm", async (req, res) => {
        if (req.method !== "POST") return res.writeHead(405).end();
        try {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const { cfg, messages, anthropic } = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          if (!cfg?.apiKey) throw new Error("未配置 API Key");
          const upstream = anthropic
            ? await callAnthropic(cfg, messages)
            : await callOpenAI(cfg, messages);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(upstream));
        } catch (err) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });

      server.middlewares.use("/api/vision", async (req, res) => {
        if (req.method !== "POST") return res.writeHead(405).end();
        try {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          // multipart 透传：直接转发到 SAM 3 提取服务
          const raw = Buffer.concat(chunks);
          const boundary = (req.headers["content-type"] ?? "").match(/boundary=(.+)$/)?.[1];
          if (!boundary) throw new Error("缺少 multipart boundary");
          // 从 multipart 中解析 baseUrl/apiKey 字段，其余原样转发
          const text = raw.toString("latin1");
          const field = (name: string) => {
            const m = new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]+)`).exec(text);
            return m ? m[1] : "";
          };
          const baseUrl = field("baseUrl");
          const apiKey = field("apiKey");
          if (!baseUrl) throw new Error("未配置 SAM 3 服务地址");
          const upstream = await fetch(`${baseUrl.replace(/\/$/, "")}/extract`, {
            method: "POST",
            headers: {
              "Content-Type": `multipart/form-data; boundary=${boundary}`,
              ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
            body: raw,
          });
          if (!upstream.ok) {
            const body = await upstream.text().catch(() => "");
            throw new Error(`上游提取服务 ${upstream.status}: ${body.slice(0, 200)}`);
          }
          res.setHeader("Content-Type", "application/json");
          res.end(Buffer.from(await upstream.arrayBuffer()));
        } catch (err) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });
    },
  };
}

async function callOpenAI(cfg: { baseUrl: string; apiKey: string; model: string }, messages: unknown[]) {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages, temperature: 0.1 }),
  });
  if (!r.ok) throw new Error(`LLM 上游 ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM 返回内容为空");
  return { content };
}

async function callAnthropic(cfg: { baseUrl: string; apiKey: string; model: string }, messages: unknown[]) {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/v1/messages`;
  const [system, ...rest] = messages as { role: string; content: string }[];
  const body = {
    model: cfg.model,
    max_tokens: 1024,
    temperature: 0.1,
    ...(system?.role === "system" ? { system: system.content } : {}),
    messages: (system?.role === "system" ? rest : messages).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    })),
  };
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`LLM 上游 ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const data = (await r.json()) as { content?: { type: string; text?: string }[] };
  const content = data.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  if (!content) throw new Error("LLM 返回内容为空");
  return { content };
}

export default defineConfig({
  plugins: [react(), modelProxy()],
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
