import { useMemo, useState } from "react";
import type { Variant, VariantAxis, VariantSet } from "@cassie/spec";
import { reviewVariant, selectVariant, setStageView, useAppState } from "../store";
import { mediaUrl } from "../lib/runtime";
import { PanelGrip } from "./PanelGrip";

const REVIEW_LABEL: Record<Variant["review"], string> = { pending: "待审", approved: "已通过", rejected: "已打回" };

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

export function VariantBoard() {
  const state = useAppState();
  const doc = state.runtime!.document;
  const set = doc.variants!;
  const { colAxis, rowAxes, rows, cell } = useMemo(() => layout(set), [set]);
  const [filter, setFilter] = useState<Variant["review"] | "all">("all");
  const items = Object.values(set.items);
  const counts = { approved: 0, rejected: 0, pending: 0 } as Record<Variant["review"], number>;
  for (const v of items) counts[v.review]++;
  const selected = state.selectedVariantId ? set.items[state.selectedVariantId] : undefined;
  const master = doc.editor.assets[set.masterAssetId];

  return (
    <section className="stage-panel variant-board">
      <div className="stage-toolbar">
        <div className="tool-group">
          <PanelGrip panel="stage" />
          <StageViewSwitch />
          <span className="variant-summary">
            1 个母版 → {items.length} 条变体 · <b className="ok">{counts.approved}</b> 通过 · <b className="bad">{counts.rejected}</b> 打回 · {counts.pending} 待审
          </span>
          {state.busy && <span className="stage-busy">{state.busy}</span>}
        </div>
        <div className="tool-group">
          {(["all", "pending", "approved", "rejected"] as const).map((f) => (
            <button key={f} className={`tool-btn ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
              {f === "all" ? "全部" : REVIEW_LABEL[f]}
            </button>
          ))}
        </div>
      </div>
      <div className="variant-body">
        <div className="variant-grid" style={{ gridTemplateColumns: `minmax(120px,auto) repeat(${colAxis.values.length}, minmax(96px,1fr))` }}>
          <div className="variant-corner">{rowAxes.map((a) => a.label).join(" · ")}</div>
          {colAxis.values.map((v) => <div key={v.id} className="variant-col">{v.label}</div>)}
          {rows.map(({ key, coords }) => (
            <Row key={key} rowKey={key} coords={coords} set={set} colAxis={colAxis} rowAxes={rowAxes} cell={cell} filter={filter} selectedId={state.selectedVariantId} />
          ))}
        </div>
        <aside className="variant-detail">
          {selected ? (
            <Detail key={selected.id} variant={selected} set={set} masterName={master?.name ?? set.masterAssetId} busy={Boolean(state.busy)} />
          ) : (
            <div className="variant-empty">
              <p>点一个格子看这条变体：和母版对比、看它换了什么、通过或打回。</p>
              <h4>每条都必须保留</h4>
              <ul>{set.keep.map((k) => <li key={k}>{k}</li>)}</ul>
              <h4>共享改编说明</h4>
              <p className="variant-brief">{set.brief || "（未填写）"}</p>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

function Row(props: { rowKey: string; coords: Record<string, string>; set: VariantSet; colAxis: VariantAxis; rowAxes: VariantAxis[]; cell: Map<string, Variant>; filter: Variant["review"] | "all"; selectedId: string | null }) {
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
        const hidden = v && props.filter !== "all" && v.review !== props.filter;
        if (!v || hidden) return <div key={c.id} className={`variant-cell empty ${hidden ? "filtered" : ""}`} />;
        return (
          <button key={c.id} className={`variant-cell ${v.review} ${props.selectedId === v.id ? "selected" : ""}`} onClick={() => selectVariant(v.id)} title={v.id}>
            {v.take ? (
              <video
                src={`${mediaUrl(v.take.assetId)}#t=2`}
                muted
                playsInline
                preload="metadata"
                style={{ aspectRatio: `${v.take.width} / ${v.take.height}` }}
                onMouseEnter={(e) => void e.currentTarget.play().catch(() => undefined)}
                onMouseLeave={(e) => e.currentTarget.pause()}
              />
            ) : (
              <span className="variant-missing">未生成</span>
            )}
            <i className="variant-dot" aria-label={REVIEW_LABEL[v.review]} />
          </button>
        );
      })}
    </>
  );
}

function Detail({ variant, set, masterName, busy }: { variant: Variant; set: VariantSet; masterName: string; busy: boolean }) {
  const [note, setNote] = useState(variant.note ?? "");
  const brief = [set.brief, variant.brief].filter(Boolean).join("\n");
  return (
    <div className="variant-detail-body">
      <div className="variant-coords">
        {set.axes.map((a) => {
          const v = label(set, a.id, variant.coords[a.id]!);
          return (
            <span key={a.id}>
              <small>{a.label}</small>
              {v?.label}
              {v?.attrs?.language && <em>{v.attrs.language}</em>}
            </span>
          );
        })}
        <span className={`variant-status ${variant.review}`}>{REVIEW_LABEL[variant.review]}</span>
      </div>
      <div className="variant-compare">
        <figure>
          <video src={mediaUrl(set.masterAssetId)} controls muted playsInline preload="metadata" />
          <figcaption>母版 · {masterName}</figcaption>
        </figure>
        <figure>
          {variant.take ? <video src={mediaUrl(variant.take.assetId)} controls playsInline preload="metadata" /> : <div className="variant-missing big">这条还没有成片</div>}
          <figcaption>
            变体{variant.take ? ` · ${variant.take.width}×${variant.take.height} · ${(variant.take.durationUs / 1e6).toFixed(1)}s · ${variant.take.provider}` : ""}
          </figcaption>
        </figure>
      </div>
      <h4>改编说明</h4>
      <p className="variant-brief">{brief || "（未填写）"}</p>
      <h4>必须保留</h4>
      <ul>{set.keep.map((k) => <li key={k}>{k}</li>)}</ul>
      <h4>审核</h4>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="打回时写清楚哪里不对（口型、语种、品牌露出、画幅裁切…）" rows={3} />
      <div className="variant-actions">
        <button className="primary-btn" disabled={busy || !variant.take || variant.review === "approved"} onClick={() => void reviewVariant(variant.id, "approved", note.trim() || undefined)}>通过</button>
        <button className="danger-btn" disabled={busy || !note.trim()} onClick={() => void reviewVariant(variant.id, "rejected", note.trim())}>打回</button>
        {variant.review !== "pending" && <button className="tool-btn" disabled={busy} onClick={() => void reviewVariant(variant.id, "pending")}>改回待审</button>}
      </div>
    </div>
  );
}
