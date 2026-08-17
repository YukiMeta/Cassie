import { useState } from "react";
import { llmChat, type LlmConfig, type VisionConfig } from "../lib/model-client";
import { saveModelConfig, setSettingsOpen, setToast, useAppState, type ModelConfigState } from "../store";

/**
 * 模型设置 —— 全站模型能力全部 BYOK：
 * 语义 LLM（OpenAI 兼容 / Anthropic 格式任意端点）+ SAM 3 视觉提取服务。
 * key 只保存在本机 localStorage，请求经本机代理转发，不进仓库、不出本机。
 */
export function SettingsModal() {
  const state = useAppState();
  const [draft, setDraft] = useState<ModelConfigState>(state.modelConfig);
  const [testing, setTesting] = useState<"llm" | "vision" | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const save = () => {
    saveModelConfig(draft);
    setSettingsOpen(false);
    setToast("模型配置已保存（只存在本机）");
  };

  const testLlm = async () => {
    setTesting("llm");
    setTestResult(null);
    try {
      await llmChat(draft.llm, [
        { role: "system", content: "只回复两个字：正常" },
        { role: "user", content: "连接测试" },
      ]);
      setTestResult({ ok: true, message: `LLM 连接正常（${draft.llm.model}）` });
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(null);
    }
  };

  const testVision = async () => {
    setTesting("vision");
    setTestResult(null);
    try {
      const r = await fetch(`${draft.vision.baseUrl.replace(/\/$/, "")}/health`);
      if (!r.ok) throw new Error(`服务返回 ${r.status}`);
      setTestResult({ ok: true, message: "SAM 3 服务在线" });
    } catch (err) {
      setTestResult({ ok: false, message: `无法连接 ${draft.vision.baseUrl}：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setTesting(null);
    }
  };

  const llm = draft.llm;
  const vision = draft.vision;
  const setLlm = (patch: Partial<LlmConfig>) => setDraft((d) => ({ ...d, llm: { ...d.llm, ...patch } }));
  const setVision = (patch: Partial<VisionConfig>) => setDraft((d) => ({ ...d, vision: { ...d.vision, ...patch } }));

  return (
    <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <span className="eyebrow">Model Providers</span>
            <strong>模型设置 · 全部自填（BYOK）</strong>
          </div>
          <button className="icon-btn" onClick={() => setSettingsOpen(false)} title="关闭">
            ✕
          </button>
        </div>

        <section className="settings-section">
          <div className="settings-section-head">
            <div>
              <strong>语义模型（LLM）</strong>
              <p>意图解析、主体命名与关系判定。支持 OpenAI 兼容端点与 Anthropic 格式端点。</p>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={llm.enabled}
                onChange={(e) => setLlm({ enabled: e.target.checked })}
              />
              <span />
            </label>
          </div>
          {llm.enabled && (
            <div className="settings-fields">
              <label>
                <span>Base URL</span>
                <input
                  value={llm.baseUrl}
                  placeholder="https://api.deepseek.com/v1"
                  onChange={(e) => setLlm({ baseUrl: e.target.value })}
                />
              </label>
              <label>
                <span>Model</span>
                <input value={llm.model} placeholder="deepseek-chat" onChange={(e) => setLlm({ model: e.target.value })} />
              </label>
              <label>
                <span>API Key</span>
                <input
                  type="password"
                  value={llm.apiKey}
                  placeholder="sk-…"
                  autoComplete="off"
                  onChange={(e) => setLlm({ apiKey: e.target.value })}
                />
              </label>
              <div className="settings-test">
                <button className="secondary-btn" disabled={testing !== null} onClick={() => void testLlm()}>
                  {testing === "llm" ? "测试中…" : "测试连接"}
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="settings-section">
          <div className="settings-section-head">
            <div>
              <strong>视觉提取（SAM 3）</strong>
              <p>
                视频语义主体的检测与跟踪。运行本地服务（servers/sam3），
                或填入任何实现 /extract 契约的自建端点。
              </p>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={vision.enabled}
                onChange={(e) => setVision({ enabled: e.target.checked })}
              />
              <span />
            </label>
          </div>
          {vision.enabled && (
            <div className="settings-fields">
              <label>
                <span>服务地址</span>
                <input
                  value={vision.baseUrl}
                  placeholder="http://localhost:8000"
                  onChange={(e) => setVision({ baseUrl: e.target.value })}
                />
              </label>
              <label>
                <span>API Key（可选）</span>
                <input
                  type="password"
                  value={vision.apiKey}
                  placeholder="自建服务无需"
                  autoComplete="off"
                  onChange={(e) => setVision({ apiKey: e.target.value })}
                />
              </label>
              <div className="settings-test">
                <button className="secondary-btn" disabled={testing !== null} onClick={() => void testVision()}>
                  {testing === "vision" ? "测试中…" : "测试连接"}
                </button>
              </div>
            </div>
          )}
        </section>

        {testResult && (
          <div className={`settings-test-result ${testResult.ok ? "ok" : "fail"}`}>{testResult.message}</div>
        )}

        <div className="settings-privacy">
          🔒 API Key 只保存在本机 localStorage，请求经由本机代理转发；
          未配置模型时全部能力走本地确定性实现，功能不受影响。
        </div>

        <div className="modal-actions">
          <button className="ghost-btn" onClick={() => setSettingsOpen(false)}>
            取消
          </button>
          <button className="primary-btn" onClick={save}>
            保存配置
          </button>
        </div>
      </div>
    </div>
  );
}
