import { useState } from "react";
import { deriveLifecycle } from "@cassie/spec";
import type { SemanticEntity } from "@cassie/spec";
import type { Project } from "@cassie/editor-core";
import {
  addSemanticEntities,
  importMedia,
  saveToFile,
  loadFromFile,
  selectEntity,
  setSettingsOpen,
  setToast,
  toggleEntityLock,
  useAppState,
} from "../store";
import { visionExtract, type ExtractedCandidate } from "../lib/model-client";

const TAB_LABELS: Record<string, [string, string]> = {
  project: ["Project Context", "剧本与分镜"],
  assets: ["Persistent Library", "长期资产与 @引用"],
  layers: ["Semantic Graph", "主体、图层与锁"],
};

export function Sidebar() {
  const state = useAppState();
  const [tab, setTab] = useState<"project" | "assets" | "layers">("layers");
  const project = state.adapter.getProject();
  const entities = Object.values(state.semantic.entities);
  const refs = new Set(
    Object.values(state.semantic.entities)
      .map((e) => e.reference)
      .filter(Boolean) as string[],
  );

  return (
    <aside className="sidebar panel">
      <div className="panel-tabs">
        {(["project", "assets", "layers"] as const).map((t) => (
          <button key={t} className={tab === t ? "active" : ""} data-tab={t} onClick={() => setTab(t)}>
            {t === "project" ? "项目" : t === "assets" ? "资产" : "图层"}
          </button>
        ))}
      </div>
      <div className="sidebar-head">
        <div>
          <span className="eyebrow">{TAB_LABELS[tab]![0]}</span>
          <strong>{TAB_LABELS[tab]![1]}</strong>
        </div>
        <label className="icon-btn" title="导入媒体">
          ＋
          <input
            type="file"
            hidden
            accept="video/*,audio/*,image/*"
            multiple
            onChange={(e) => {
              if (e.target.files?.length) void importMedia(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      <div className="asset-scroll">
        {tab === "project" && (
          <div className="tab-content active">
            <div className="section-label">
              <span>创作基线</span>
              <span>已完成</span>
            </div>
            <div className="project-card">
              <div className="project-card-head">
                <strong>剧本 · NOCTURNE 15s</strong>
                <span>LOCKED</span>
              </div>
              <p className="script-line">
                巴黎夜色中，Mia 停下脚步，拿出香水。镜头推近，商品在玻璃音效处切入 Hero Packshot。
              </p>
            </div>
            <div className="project-card">
              <div className="project-card-head">
                <strong>导演约束</strong>
                <span>{state.semantic.constraints.length} RULES</span>
              </div>
              <p className="script-line">
                人物身份不变 · 商品 Logo 可读 · 暖侧光持续 · 10.5s 玻璃音效不可移动
              </p>
            </div>
            <div className="project-card">
              <div className="project-card-head">
                <strong>项目文件</strong>
                <span>LOCAL</span>
              </div>
              <div className="file-actions">
                <button className="secondary-btn" onClick={saveToFile}>
                  保存 .cassie.json
                </button>
                <label className="secondary-btn">
                  加载项目
                  <input
                    type="file"
                    hidden
                    accept=".json,application/json"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) loadFromFile(f);
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
            </div>
          </div>
        )}

        {tab === "assets" && (
          <div className="tab-content active">
            <label className="upload-zone">
              上传长期资产或补充参考
              <input
                type="file"
                hidden
                accept="video/*,audio/*,image/*"
                multiple
                onChange={(e) => {
                  if (e.target.files?.length) void importMedia(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            <div className="section-label">
              <span>长期资产库</span>
              <span>使用 @ 引用</span>
            </div>
            {entities.map((e) => (
              <div key={e.id} className="library-card asset-ref" data-reference={e.reference}>
                <div className="ref-mosaic">
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
                <div>
                  <strong>
                    <em>{e.reference}</em> · {e.name}
                  </strong>
                  <p>{e.kind === "subject" ? "身份资产 · 跨项目可用" : e.kind === "scene" ? "场景资产" : "文字资产"}</p>
                  <div className="asset-capabilities">
                    <span>语义绑定</span>
                    <span className="bound">稳定 ID</span>
                  </div>
                </div>
              </div>
            ))}
            <div className="section-label">
              <span>本项目引用</span>
              <span>{refs.size}</span>
            </div>
            <div className="context-card">
              {[...refs].map((r) => (
                <span key={r} className="reference-token">
                  {r}
                </span>
              ))}
            </div>
          </div>
        )}

        {tab === "layers" && (
          <div className="tab-content active">
            <ExtractFlow />
            <div className="section-label">
              <span>主体与锁</span>
              <span>{entities.length}</span>
            </div>
            {entities.map((e) => {
              const lc = deriveLifecycle(e, project);
              const selected = state.selectedEntityId === e.id;
              return (
                <article
                  key={e.id}
                  className={`asset-card ${selected ? "selected" : ""}`}
                  onClick={() => selectEntity(e.id)}
                >
                  <div className={`asset-thumb ${e.id}`} />
                  <div className="asset-copy">
                    <strong>{e.name}</strong>
                    <span>
                      {(lc.enterUs / 1e6).toFixed(1)}s—{(lc.exitUs / 1e6).toFixed(1)}s · {e.reference}
                    </span>
                  </div>
                  <button
                    className={`lock-btn ${e.locked ? "locked" : ""}`}
                    title={e.locked ? "已锁定" : "锁定主体"}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      toggleEntityLock(e.id);
                    }}
                  >
                    {e.locked ? "▣" : "□"}
                  </button>
                </article>
              );
            })}
            <div className="section-label">
              <span>全局锁</span>
              <span>{state.semantic.constraints.length}</span>
            </div>
            <div className="context-card">
              {state.semantic.constraints.map((c) => (
                <span key={c.id} className="lock-chip">
                  ▣ {c.what}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

/**
 * 语义提取流程：SAM 3 分析视频 → 候选主体（概念 + 轨迹时间窗）→ 用户确认 → 绑定语义实体。
 * 未配置视觉服务时引导用户去 ⚙ 模型 设置。
 */
function ExtractFlow() {
  const state = useAppState();
  const [open, setOpen] = useState(false);
  const [prompts, setPrompts] = useState("perfume bottle, person, bottle");
  const [running, setRunning] = useState(false);
  const [candidates, setCandidates] = useState<ExtractedCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [names, setNames] = useState<Record<string, string>>({});

  const runExtract = async () => {
    const videoFile = state.adapter.getProject();
    const videoTrack = videoFile.tracks.find((t) => t.kind === "video");
    const clip = videoTrack?.clips[0];
    const asset = clip?.assetId ? videoFile.assets[clip.assetId] : null;
    if (!asset?.url) {
      setError("项目里没有视频素材：请先导入或载入演示项目");
      return;
    }
    const blob = await fetch(asset.url).then((r) => r.blob());
    const file = new File([blob], asset.name, { type: blob.type });
    setRunning(true);
    setError(null);
    try {
      const result = await visionExtract(state.modelConfig.vision, {
        file,
        prompts: prompts.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean),
      });
      setCandidates(result.candidates);
      const all = new Set<string>();
      const nameMap: Record<string, string> = {};
      result.candidates.forEach((c, i) => {
        const key = `${i}:${c.concept}`;
        all.add(key);
        nameMap[key] = c.concept;
      });
      setPicked(all);
      setNames(nameMap);
      setToast(`SAM 3 提取完成：${result.candidates.length} 个候选主体`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const bindConfirmed = () => {
    if (!candidates) return;
    const project = state.adapter.getProject();
    const videoTrack = project.tracks.find((t) => t.kind === "video");
    const newEntities: SemanticEntity[] = [];
    candidates.forEach((c, i) => {
      const key = `${i}:${c.concept}`;
      if (!picked.has(key)) return;
      const track = c.tracks[0];
      if (!track) return;
      const name = names[key]?.trim() || c.concept;
      const entityId = `entity_${Date.now().toString(36)}_${i}`;
      // 绑定覆盖该轨迹时间窗的视频片段
      const binds = (videoTrack?.clips ?? [])
        .filter((clip) => clip.startUs < track.endUs && clip.endUs > track.startUs)
        .map((clip, idx) => ({
          targetType: "clip" as const,
          targetId: clip.id,
          role: (idx === 0 ? "primary" : "supporting") as "primary" | "supporting",
        }));
      newEntities.push({
        id: entityId,
        name,
        kind: "subject",
        reference: `@${name.replace(/\s+/g, "_")}`,
        lifecycle: { enterUs: track.startUs, exitUs: track.endUs },
        attributes: { score: track.score, source: "sam3" },
        binds,
        locked: false,
      });
    });
    const bound = addSemanticEntities(newEntities);
    setCandidates(null);
    setOpen(false);
    setToast(bound > 0 ? `已绑定 ${bound} 个语义主体到时间线` : "没有确认任何主体");
  };

  return (
    <div className="extract-flow">
      <button className="extract-toggle" onClick={() => setOpen(!open)}>
        <span>✦ 从视频提取主体</span>
        <span className="extract-badge">{state.modelConfig.vision.enabled ? "SAM 3" : "未配置"}</span>
      </button>
      {open && (
        <div className="extract-body">
          {!state.modelConfig.vision.enabled ? (
            <div className="extract-hint">
              <p>需要先配置 SAM 3 视觉提取服务。</p>
              <button className="secondary-btn" onClick={() => setSettingsOpen(true)}>
                ⚙ 打开模型设置
              </button>
            </div>
          ) : candidates === null ? (
            <>
              <label className="extract-label">
                <span>概念提示（逗号分隔）</span>
                <input
                  value={prompts}
                  onChange={(e) => setPrompts(e.target.value)}
                  placeholder="perfume bottle, person, car"
                />
              </label>
              <button className="primary-btn extract-run" disabled={running} onClick={() => void runExtract()}>
                {running ? "SAM 3 分析中…" : "开始提取"}
              </button>
              {error && <div className="extract-error">{error}</div>}
            </>
          ) : (
            <div className="extract-results">
              <div className="extract-result-head">
                <strong>候选主体</strong>
                <span>勾选要绑定的</span>
              </div>
              {candidates.length === 0 && <p className="extract-hint">没有检测到匹配的概念</p>}
              {candidates.map((c, i) => {
                const key = `${i}:${c.concept}`;
                const track = c.tracks[0];
                return (
                  <label key={key} className="extract-candidate">
                    <input
                      type="checkbox"
                      checked={picked.has(key)}
                      onChange={(e) => {
                        const next = new Set(picked);
                        if (e.target.checked) next.add(key);
                        else next.delete(key);
                        setPicked(next);
                      }}
                    />
                    <input
                      className="extract-name"
                      value={names[key] ?? c.concept}
                      onChange={(e) => setNames((n) => ({ ...n, [key]: e.target.value }))}
                    />
                    <span className="extract-meta">
                      {track ? `${(track.startUs / 1e6).toFixed(1)}s—${(track.endUs / 1e6).toFixed(1)}s · ${(track.score * 100).toFixed(0)}%` : "无轨迹"}
                    </span>
                  </label>
                );
              })}
              <div className="extract-actions">
                <button className="ghost-btn" onClick={() => { setCandidates(null); setError(null); }}>
                  重来
                </button>
                <button className="primary-btn" onClick={bindConfirmed}>
                  确认绑定
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
