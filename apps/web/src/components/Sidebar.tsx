import { useState } from "react";
import { deriveLifecycle } from "@cassie/spec";
import { importMedia, saveToFile, loadFromFile, selectEntity, toggleEntityLock, useAppState } from "../store";

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
