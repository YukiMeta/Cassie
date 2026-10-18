import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

/**
 * 模型代理：浏览器把用户自填的 baseUrl/apiKey 随请求发给本机 dev server，
 * 由这里转发到目标模型服务。key 只在用户自己的机器上流动。
 * 生产部署时需要等价的 serverless 代理（见 docs/semantic-pipeline.md）。
 */
function modelProxy(): Plugin {
  return {
    name: "cassie-model-proxy",
    configureServer(server) {
      server.middlewares.use("/api/llm/agent", async (req, res) => {
        if (req.method !== "POST") return res.writeHead(405).end();
        try {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const { cfg, system, messages, tools, anthropic } = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          if (!cfg?.apiKey) throw new Error("未配置 API Key");
          const turn = anthropic ? await agentAnthropic(cfg, system, messages, tools) : await agentOpenAI(cfg, system, messages, tools);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(turn));
        } catch (err) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });

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

      // 渲染服务代理：/api/render/<path> → <X-Render-Base>/<path>，请求体（multipart）流式透传
      server.middlewares.use("/api/render", async (req, res) => {
        try {
          const base = String(req.headers["x-render-base"] ?? "").replace(/\/$/, "");
          if (!base) throw new Error("未配置渲染服务地址");
          const key = String(req.headers["x-render-key"] ?? "");
          const hasBody = req.method === "POST";
          const upstream = await fetch(`${base}${req.url ?? "/"}`, {
            method: req.method,
            headers: {
              ...(req.headers["content-type"] ? { "Content-Type": String(req.headers["content-type"]) } : {}),
              ...(key ? { Authorization: `Bearer ${key}` } : {}),
            },
            body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
            ...(hasBody ? { duplex: "half" } : {}),
          } as RequestInit);
          res.statusCode = upstream.status;
          res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/octet-stream");
          res.end(Buffer.from(await upstream.arrayBuffer()));
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

/**
 * Agent turns use one provider-neutral history: user text, assistant text + tool calls, and tool
 * results that may carry a preview frame. These two functions translate it to each wire format.
 */
type AgentMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: { id: string; name: string; args: Record<string, unknown> }[] }
  | { role: "tool"; id: string; name: string; text: string; isError?: boolean; image?: { data: string; mimeType: string } };
type AgentToolSpec = { name: string; description: string; inputSchema: unknown };
type ModelCfg = { baseUrl: string; apiKey: string; model: string };

async function agentOpenAI(cfg: ModelCfg, system: string, history: AgentMessage[], tools: AgentToolSpec[]) {
  const messages: unknown[] = [{ role: "system", content: system }];
  let frames: unknown[] = [];
  const flush = () => {
    if (frames.length) messages.push({ role: "user", content: [{ type: "text", text: "Preview frames returned by the tools above:" }, ...frames] });
    frames = [];
  };
  for (const m of history) {
    if (m.role !== "tool") flush();
    if (m.role === "user") messages.push({ role: "user", content: m.text });
    else if (m.role === "assistant") messages.push({ role: "assistant", content: m.text || null, ...(m.toolCalls.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}) });
    else {
      messages.push({ role: "tool", tool_call_id: m.id, content: m.text });
      if (m.image) frames.push({ type: "image_url", image_url: { url: `data:${m.image.mimeType};base64,${m.image.data}` } });
    }
  }
  flush();
  const r = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages, temperature: 0.2, tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }),
  });
  if (!r.ok) throw new Error(`LLM 上游 ${r.status}: ${(await r.text().catch(() => "")).slice(0, 300)}`);
  const data = (await r.json()) as { choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments?: string } }[] } }[] };
  const msg = data.choices?.[0]?.message;
  return {
    text: msg?.content ?? "",
    toolCalls: (msg?.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, args: c.function.arguments ? JSON.parse(c.function.arguments) : {} })),
  };
}

async function agentAnthropic(cfg: ModelCfg, system: string, history: AgentMessage[], tools: AgentToolSpec[]) {
  const messages: { role: "user" | "assistant"; content: unknown }[] = [];
  for (const m of history) {
    if (m.role === "user") messages.push({ role: "user", content: m.text });
    else if (m.role === "assistant") messages.push({ role: "assistant", content: [...(m.text ? [{ type: "text", text: m.text }] : []), ...m.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.args }))] });
    else {
      const block = { type: "tool_result", tool_use_id: m.id, is_error: Boolean(m.isError), content: [{ type: "text", text: m.text }, ...(m.image ? [{ type: "image", source: { type: "base64", media_type: m.image.mimeType, data: m.image.data } }] : [])] };
      const last = messages.at(-1);
      if (last?.role === "user" && Array.isArray(last.content) && (last.content as { type: string }[])[0]?.type === "tool_result") (last.content as unknown[]).push(block);
      else messages.push({ role: "user", content: [block] });
    }
  }
  const r = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: cfg.model, max_tokens: 2048, temperature: 0.2, system, messages, tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) }),
  });
  if (!r.ok) throw new Error(`LLM 上游 ${r.status}: ${(await r.text().catch(() => "")).slice(0, 300)}`);
  const data = (await r.json()) as { content?: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[] };
  return {
    text: (data.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join(""),
    toolCalls: (data.content ?? []).filter((c) => c.type === "tool_use").map((c) => ({ id: c.id!, name: c.name!, args: c.input ?? {} })),
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

/** 运行时只接受本机同源请求：代理时改写 Origin，并补 CORP，避免 COEP 把 /scene iframe 挡掉。 */
function runtimeProxy(target: string) {
  const wire = (proxy: { on: (event: string, fn: (...args: unknown[]) => void) => void }) => {
    proxy.on("proxyReq", (...args) => {
      const req = args[0] as { setHeader: (k: string, v: string) => void; getHeader: (k: string) => unknown };
      if (req.getHeader("origin")) req.setHeader("origin", target);
    });
    proxy.on("proxyRes", (...args) => {
      const proxyRes = args[0] as { headers: Record<string, string | string[] | undefined> };
      proxyRes.headers["cross-origin-resource-policy"] = "same-origin";
    });
  };
  const rewrite = { target, changeOrigin: true, configure: wire };
  return {
    "/rt": { ...rewrite, rewrite: (path: string) => path.replace(/^\/rt/, "") },
    "/scene": rewrite,
    "/media/": rewrite,
    "/poster/": rewrite,
    "/font-400.woff2": rewrite,
    "/font-600.woff2": rewrite,
  };
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
    proxy: runtimeProxy(process.env.CASSIE_RUNTIME ?? "http://127.0.0.1:4320"),
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
