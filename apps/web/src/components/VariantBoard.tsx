import { useMemo, useState } from "react";
import type { EventDocument, Variant, VariantAxis, VariantSet } from "@cassie/spec";
import { staleSubjects, subjectRefsFor, variableValues } from "@cassie/harness";
import { renderVariant, reviewVariant, selectVariant, setStageView, setVariantValue, syncVariantSubject, uploadSubjectReference, useAppState } from "../store";
import { mediaUrl, posterUrl } from "../lib/runtime";
import { PanelGrip } from "./PanelGrip";

const REVIEW_LABEL: Record<Variant["review"], string> = { pending: "待审", approved: "通过", rejected: "打回" };

/** 母版 / 变体 切换；只有工程里定义了变体集时才出现。 */
export function StageViewSwitch() {
  const state = useAppState();
  const set = state.runtime?.document.variants;
  if (!set) return null;
  const count = Object.keys(set.items).length;
  return (
    <div className="view-switch" role="tablist">
      <button className={state.stageView === "master" ? "active" : ""} onClick={() => setStageView("master")}>母版</button>
      <button className={state.stageView === "variants" ? "active" : ""} onClick={() => setStageView("variants")}>变体 {count}</button>
    </div>
  );
}

/** Columns are the axis that pins the canvas (aspect); rows are every other-axis combination that exists. */
function layout(set: VariantSet) {
  const colAxis = set.axes.find((a) => a.values.some((v) => v.attrs?.aspect)) ?? set.axes.at(-1)!;
  const rowAxes = set.axes.filter((a) => a !== colAxis);
  const items = Object.values(set.items);
  const rowKey = (v: Variant) => rowAxes.map((a) => v.coords[a.id]).join("|");
  const order = (axis: VariantAxis, id: string) => axis.values.findIndex((v) => v.id === id);
  const rows = [...new Map(items.map((v) => [rowKey(v), v.coords])).entries()]
    .sort(([, a], [, b]) => rowAxes.reduce((d, axis) => d || order(axis, a[axis.id]!) - order(axis, b[axis.id]!), 0))
    .map(([key, coords]) => ({ key, coords }));
  const cell = new Map(items.map((v) => [`${rowKey(v)}#${v.coords[colAxis.id]}`, v]));
  return { colAxis, rowAxes, rows, cell };
}

const label = (set: VariantSet, axisId: string, valueId: string) => set.axes.find((a) => a.id === axisId)?.values.find((v) => v.id === valueId);

function Tabs<T extends string>({ tabs, value, onChange }: { tabs: [T, string, number?][]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="vb-tabs" role="tablist">
      {tabs.map(([id, text, badge]) => (
        <button key={id} role="tab" className={value === id ? "active" : ""} onClick={() => onChange(id)}>
          {text}
          {badge ? <i>{badge}</i> : null}
        </button>
      ))}
    </div>
  );
}

export function VariantBoard() {
  const state = useAppState();
  const doc = state.runtime!.document;
  const set = doc.variants!;
  const { colAxis, rowAxes, rows, cell } = useMemo(() => layout(set), [set]);
  const [filter, setFilter] = useState<Variant["review"] | "stale" | "all">("all");
  const items = Object.values(set.items);
  const counts = { approved: 0, rejected: 0, pending: 0 } as Record<Variant["review"], number>;
  for (const v of items) counts[v.review]++;
  const staleCount = items.filter((v) => staleSubjects(doc, v).length).length;
  const selected = state.selectedVariantId ? set.items[state.selectedVariantId] : undefined;
  const master = doc.editor.assets[set.masterAssetId];
  const pct = (n: number) => `${(n / Math.max(1, items.length)) * 100}%`;

  return (
    <section className="stage-panel variant-board">
      <div className="stage-toolbar">
        <div className="tool-group">
          <PanelGrip panel="stage" />
          <StageViewSwitch />
          <div className="vb-progress" title={`${counts.approved} 通过 · ${counts.rejected} 打回 · ${counts.pending} 待审`}>
            <span className="ok" style={{ width: pct(counts.approved) }} />
            <span className="bad" style={{ width: pct(counts.rejected) }} />
          </div>
          <span className="vb-count"><b>{counts.approved}</b>/{items.length} 通过</span>
          {state.busy && <span className="stage-busy">{state.busy}</span>}
        </div>
        <div className="vb-filter">
          {([["all", "全部"], ["pending", `待审 ${counts.pending}`], ["rejected", `打回 ${counts.rejected}`], ["stale", `待同步 ${staleCount}`]] as const).map(([f, text]) => (
            <button key={f} className={filter === f ? "active" : ""} disabled={f === "stale" && !staleCount} onClick={() => setFilter(f)}>{text}</button>
          ))}
        </div>
      </div>
      <div className="variant-body">
        <div className="variant-grid" style={{ gridTemplateColumns: `minmax(112px,auto) repeat(${colAxis.values.length}, minmax(96px,1fr))` }}>
          <div className="variant-corner">{rowAxes.map((a) => a.label).join(" / ")}</div>
          {colAxis.values.map((v) => <div key={v.id} className="variant-col"><AspectGlyph ratio={v.attrs?.aspect ?? v.id} />{v.label}</div>)}
          {rows.map(({ key, coords }) => (
            <Row key={key} rowKey={key} coords={coords} set={set} colAxis={colAxis} rowAxes={rowAxes} cell={cell} filter={filter} selectedId={state.selectedVariantId} doc={doc} />
          ))}
        </div>
        <aside className="variant-detail">
          {selected ? (
            <Detail key={selected.id} variant={selected} set={set} doc={doc} masterName={master?.name ?? set.masterAssetId} busy={Boolean(state.busy)} />
          ) : (
            <MasterPanel doc={doc} set={set} busy={Boolean(state.busy)} />
          )}
        </aside>
      </div>
    </section>
  );
}

function AspectGlyph({ ratio }: { ratio: string }) {
  const [w, h] = ratio.split(/x|:/).map(Number);
  if (!w || !h) return null;
  const s = 12 / Math.max(w, h);
  return <i className="aspect-glyph" style={{ width: w * s, height: h * s }} />;
}

/** 母版这一级：变量默认值（代码路，自动跟随）、主体参考图（SAM 3 路，需要同步）和共享规则。 */
function MasterPanel({ doc, set, busy }: { doc: EventDocument; set: VariantSet; busy: boolean }) {
  const [tab, setTab] = useState<"vars" | "subjects" | "rules">("vars");
  const vars = Object.values(doc.variables ?? {});
  const refs = Object.values(doc.subjectRefs ?? {});
  return (
    <div className="variant-detail-body">
      <header className="vb-head">
        <div className="vb-title"><small>母版</small><b>{doc.editor.assets[set.masterAssetId]?.name ?? set.masterAssetId}</b></div>
      </header>
      <video className="vb-master" src={mediaUrl(set.masterAssetId)} poster={posterUrl(set.masterAssetId, 1)} controls muted playsInline preload="none" />
      <Tabs tabs={[["vars", "文字变量", vars.length], ["subjects", "主体参考", refs.length], ["rules", "共享规则"]]} value={tab} onChange={setTab} />
      {tab === "vars" && (vars.length ? (
        <ul className="vb-list">{vars.map((v) => <li key={v.id}><span>{v.label}</span><code>{v.id}</code><em>{v.default}</em></li>)}</ul>
      ) : (
        <p className="vb-note">还没有变量。</p>
      ))}
      {tab === "vars" && <p className="vb-hint">改默认值，所有没单独填写的变体立即跟随。</p>}
      {tab === "subjects" && <SubjectRefs doc={doc} busy={busy} />}
      {tab === "rules" && (
        <>
          <h4>每条必须保留</h4>
          <ul className="vb-bullets">{set.keep.map((k) => <li key={k}>{k}</li>)}</ul>
          <h4>改编说明</h4>
          <p className="variant-brief">{set.brief || "—"}</p>
        </>
      )}
    </div>
  );
}

function SubjectRefs({ doc, busy }: { doc: EventDocument; busy: boolean }) {
  const refs = Object.values(doc.subjectRefs ?? {});
  const axes = doc.variants?.axes ?? [];
  const scopeLabel = (scope?: Record<string, string>) => Object.entries(scope ?? {}).map(([a, v]) => axes.find((x) => x.id === a)?.values.find((x) => x.id === v)?.label ?? v).join(" · ") || "全部变体";
  const [form, setForm] = useState({ entityId: "", name: "", prompt: "", instruction: "", scope: "" });
  const [file, setFile] = useState<File | null>(null);
  const [adding, setAdding] = useState(false);
  const subjects = Object.values(doc.semantic.entities).filter((e) => e.kind === "subject");
  const isNew = !doc.semantic.entities[form.entityId];
  const ready = file && /^[a-z0-9-]+$/.test(form.entityId) && form.prompt.trim() && (!isNew || form.name.trim());
  return (
    <>
      {refs.map((r) => (
        <div key={`${r.entityId}@${scopeLabel(r.scope)}`} className="subject-ref">
          <img src={mediaUrl(r.assetId)} alt="" />
          <div>
            <b>{doc.semantic.entities[r.entityId]?.name}</b>
            <span className="vb-scope">{scopeLabel(r.scope)}</span>
            <small title={r.instruction}>{r.prompt}</small>
          </div>
        </div>
      ))}
      {!refs.length && !adding && <p className="vb-note">还没有主体参考图。</p>}
      {adding ? (
        <div className="subject-form">
          <input list="subject-ids" placeholder="主体 id，如 phone" value={form.entityId} onChange={(e) => setForm({ ...form, entityId: e.target.value.trim() })} />
          <datalist id="subject-ids">{subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</datalist>
          {isNew && <input placeholder="名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}
          <select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })}>
            <option value="">全部变体</option>
            {axes.map((a) => <optgroup key={a.id} label={a.label}>{a.values.map((v) => <option key={v.id} value={`${a.id}=${v.id}`}>{v.label}</option>)}</optgroup>)}
          </select>
          <input placeholder="分割提示词（英文）" value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} />
          <input placeholder="替换要求" value={form.instruction} onChange={(e) => setForm({ ...form, instruction: e.target.value })} />
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <div className="variant-actions">
            <button className="primary-btn" disabled={busy || !ready} onClick={() => void uploadSubjectReference({ entityId: form.entityId, prompt: form.prompt, instruction: form.instruction, name: form.name || undefined, scope: form.scope ? Object.fromEntries([form.scope.split("=") as [string, string]]) : undefined, file: file! }).then(() => setAdding(false))}>保存</button>
            <button className="tool-btn" onClick={() => setAdding(false)}>取消</button>
          </div>
        </div>
      ) : (
        <button className="tool-btn vb-add" onClick={() => setAdding(true)}>添加参考图</button>
      )}
      <p className="vb-hint">换参考图后，受影响的变体标为待同步，由 SAM 3 分割并替换主体。</p>
    </>
  );
}

function Row(props: { rowKey: string; coords: Record<string, string>; set: VariantSet; colAxis: VariantAxis; rowAxes: VariantAxis[]; cell: Map<string, Variant>; filter: Variant["review"] | "stale" | "all"; selectedId: string | null; doc: EventDocument }) {
  const { set, colAxis, rowAxes, coords } = props;
  return (
    <>
      <div className="variant-row">
        {rowAxes.map((a, i) => {
          const v = label(set, a.id, coords[a.id]!);
          return <span key={a.id} className={i === 0 ? "primary" : ""}>{v?.label}{i === 0 && v?.attrs?.language ? <em>{v.attrs.language}</em> : null}</span>;
        })}
      </div>
      {colAxis.values.map((c) => {
        const v = props.cell.get(`${props.rowKey}#${c.id}`);
        const stale = v ? staleSubjects(props.doc, v).length > 0 : false;
        const hidden = v && props.filter !== "all" && (props.filter === "stale" ? !stale : v.review !== props.filter);
        if (!v || hidden) return <div key={c.id} className={`variant-cell empty ${hidden ? "filtered" : ""}`} />;
        return (
          <button key={c.id} className={`variant-cell ${v.review} ${props.selectedId === v.id ? "selected" : ""}`} onClick={() => selectVariant(v.id)} title={`${v.id} · ${REVIEW_LABEL[v.review]}`}>
            {v.take ? <HoverPreview assetId={v.take.assetId} ratio={`${v.take.width} / ${v.take.height}`} /> : <span className="variant-missing">未生成</span>}
            {stale && <span className="variant-stale">待同步</span>}
          </button>
        );
      })}
    </>
  );
}

/** A poster frame until hovered; only then is a video element mounted, so a 30-cell board stays light. */
function HoverPreview({ assetId, ratio }: { assetId: string; ratio: string }) {
  const [live, setLive] = useState(false);
  return (
    <span className="vb-frame" style={{ aspectRatio: ratio }} onMouseEnter={() => setLive(true)} onMouseLeave={() => setLive(false)}>
      <img src={posterUrl(assetId, 2)} alt="" loading="lazy" />
      {live && <video src={mediaUrl(assetId)} autoPlay muted playsInline loop />}
    </span>
  );
}

function Detail({ variant, set, doc, masterName, busy }: { variant: Variant; set: VariantSet; doc: EventDocument; masterName: string; busy: boolean }) {
  const stale = staleSubjects(doc, variant);
  const hasVars = Object.keys(doc.variables ?? {}).length > 0;
  const [tab, setTab] = useState<"review" | "text" | "subject" | "brief">(stale.length ? "subject" : "review");
  const [note, setNote] = useState(variant.note ?? "");
  const [download, setDownload] = useState<string | null>(null);
  const brief = [set.brief, variant.brief].filter(Boolean).join("\n");
  const values = variableValues(doc, variant.id);
  const tabs: ["review" | "text" | "subject" | "brief", string, number?][] = [["review", "审核"]];
  if (hasVars) tabs.push(["text", "文字"]);
  tabs.push(["subject", "主体", stale.length], ["brief", "说明"]);
  return (
    <div className="variant-detail-body">
      <header className="vb-head">
        <div className="vb-coords">
          {set.axes.map((a) => {
            const v = label(set, a.id, variant.coords[a.id]!);
            return <span key={a.id}><small>{a.label}</small>{v?.label}</span>;
          })}
        </div>
        <span className={`variant-status ${variant.review}`}>{REVIEW_LABEL[variant.review]}</span>
        <button className="vb-close" aria-label="回到母版" onClick={() => selectVariant(null)}>×</button>
      </header>
      <div className="variant-compare">
        <figure>
          <video src={mediaUrl(set.masterAssetId)} poster={posterUrl(set.masterAssetId, 2)} controls muted playsInline preload="none" />
          <figcaption>母版</figcaption>
        </figure>
        <figure>
          {variant.take ? <video src={mediaUrl(variant.take.assetId)} poster={posterUrl(variant.take.assetId, 2)} controls playsInline preload="none" /> : <div className="variant-missing big">未生成</div>}
          <figcaption>{variant.take ? `${variant.take.width}×${variant.take.height} · ${(variant.take.durationUs / 1e6).toFixed(1)}s` : "变体"}</figcaption>
        </figure>
      </div>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === "review" && (
        <>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="打回原因：口型、语种、品牌露出、裁切…" rows={3} />
          <div className="variant-actions">
            <button className="primary-btn" disabled={busy || !variant.take || variant.review === "approved"} onClick={() => void reviewVariant(variant.id, "approved", note.trim() || undefined)}>通过</button>
            <button className="danger-btn" disabled={busy || !note.trim()} onClick={() => void reviewVariant(variant.id, "rejected", note.trim())}>打回</button>
            {variant.review !== "pending" && <button className="tool-btn" disabled={busy} onClick={() => void reviewVariant(variant.id, "pending")}>撤销</button>}
          </div>
          <h4>交付</h4>
          <div className="variant-actions">
            <button className="tool-btn" disabled={busy || !variant.take} onClick={() => void renderVariant(variant.id).then((url) => url && setDownload(url))}>渲染成片</button>
            {download && <a className="tool-btn active" href={download}>下载 MP4</a>}
          </div>
        </>
      )}
      {tab === "text" && (
        <>
          {Object.values(doc.variables!).map((def) => (
            <label key={def.id} className="variant-var">
              <span>{def.label}</span>
              <input
                key={`${variant.id}-${def.id}-${variant.values?.[def.id] ?? ""}`}
                defaultValue={variant.values?.[def.id] ?? ""}
                placeholder={values[def.id]}
                disabled={busy}
                onBlur={(e) => void setVariantValue(variant.id, def.id, e.currentTarget.value)}
              />
            </label>
          ))}
          <p className="vb-hint">留空则跟随母版。</p>
        </>
      )}
      {tab === "subject" && (stale.length ? (
        <>
          {stale.map((id) => {
            const r = subjectRefsFor(doc, variant)[id]!;
            return (
              <div key={id} className="subject-ref stale">
                <img src={mediaUrl(r.assetId)} alt="" />
                <div><b>{doc.semantic.entities[id]?.name}</b><small>{r.prompt}</small></div>
              </div>
            );
          })}
          <button className="primary-btn" disabled={busy} onClick={() => void syncVariantSubject(variant.id)}>同步主体</button>
          <p className="vb-hint">只替换分割出的主体，其余像素保持不变。</p>
        </>
      ) : (
        <p className="vb-note">主体与参考图一致。</p>
      ))}
      {tab === "brief" && (
        <>
          <p className="variant-brief">{brief || "—"}</p>
          <h4>必须保留</h4>
          <ul className="vb-bullets">{set.keep.map((k) => <li key={k}>{k}</li>)}</ul>
          <p className="vb-hint">{masterName}</p>
        </>
      )}
    </div>
  );
}
