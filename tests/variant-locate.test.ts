import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { planDocumentEdit, applyDocumentEdit, parseWorkspace, resolveEvents, resolveSelector, checkNoOverlap, rollbackAction, variantDocument, EventError } from '@cassie/harness';
import { applyEdits } from '@cassie/runtime';
import type { DocumentEdit, EventWorkspace, SubjectRegion, VariantTake } from '@cassie/spec';

/**
 * 变体局部编辑迁移：母版跟踪过的主体，在新成片（take）里重新定位后，
 * 区域挂在变体自己的 regions 上；派生变体文档时注入，select 与 check_layout 可用。
 */
const fixture = () => parseWorkspace(readFileSync(new URL('../examples/film-regions/project.cassie.json', import.meta.url), 'utf8'));
const sha = (n: number) => n.toString(16).padStart(64, '0');
const take = (n: number, width: number, height: number): Extract<DocumentEdit, { kind: 'attach-variant-take' }> => {
  const t: VariantTake = { assetId: `take-${n}`, sha256: sha(n), width, height, durationUs: 13_000_000, provider: 'v2v' };
  return { kind: 'attach-variant-take', variantId: '', take: t, asset: { id: t.assetId, kind: 'video', name: `${n}.mp4`, durationUs: t.durationUs, width, height }, media: { path: `media/${t.sha256}.mp4`, sha256: t.sha256 } };
};
const withMasterTrack = () => {
  const ws = applyEdits(fixture(), [
    { kind: 'track-region', region: JSON.parse(readFileSync(new URL('../examples/film-regions/region-s4-held.json', import.meta.url), 'utf8')) as SubjectRegion, name: '产品' },
  ]);
  return applyEdits(ws, [
    { kind: 'set-variant-set', set: { masterAssetId: Object.values(ws.document.editor.assets).find(a => a.kind === 'video')!.id, brief: '', keep: ['Story beats'], axes: [{ id: 'aspect', label: '画幅', values: [{ id: '16x9', label: '16:9', attrs: { aspect: '16x9' } }, { id: '9x16', label: '9:16', attrs: { aspect: '9x16' } }] }] } },
    { kind: 'add-variants', items: [{ id: 'jp-9x16', coords: { aspect: '9x16' }, review: 'pending' }] },
    { ...take(7, 720, 1280), variantId: 'jp-9x16' },
  ]);
};
/** 312 帧 take（720×1280 @24fps），100–250 帧有一个主体框。 */
const variantRegion = (y: number): SubjectRegion => ({
  id: 'product', entityId: 'product', eventId: 'region-product', layerId: 'variant-base',
  sourceAssetId: 'take-7', sourceSha256: sha(7), sourceStartFrame: 0,
  keys: [{ sourceFrame: 150, box: [300, y, 120, 90] }],
  boxes: Array.from({ length: 312 }, (_, f) => (f >= 100 && f <= 250 ? [300, y, 120, 90] : [])),
  confidence: Array.from({ length: 312 }, (_, f) => (f >= 100 && f <= 250 ? 0.9 : 0)),
  backend: 'jev+sam3', look: { color: '#2f7cf6', tint: 0.85, feather: 6 },
});
const locate = (ws: EventWorkspace, region: SubjectRegion) => applyDocumentEdit(ws, planDocumentEdit(ws.document, { kind: 'track-variant-region', variantId: 'jp-9x16', region }));

describe('track-variant-region', () => {
  it('records the located subject on the variant and injects it into the derived document', () => {
    let ws = withMasterTrack();
    ws = locate(ws, variantRegion(400));
    const v = ws.document.variants!.items['jp-9x16']!;
    expect(Object.keys(v.regions!)).toEqual(['product']);
    expect(v.regions!.product!.sourceAssetId).toBe('take-7');

    const vd = variantDocument(ws.document, 'jp-9x16');
    expect(vd.semantic.entities.product).toMatchObject({ kind: 'subject' });
    expect(vd.semantic.entities.product!.attributes.regions).toEqual(['product']);
    const event = vd.events.find(e => e.id === 'region-product')!;
    expect('frame' in event.start ? [event.start.frame, event.durationFrames] : null).toEqual([100, 151]);
    const hits = resolveSelector(vd, 'entity:product');
    expect(hits.length).toBe(1);
    expect(hits[0]!.boxes.size).toBe(151);
    expect(hits[0]!.boxes.get(150)).toEqual([300, 400, 120, 90]);
  });
it('check_layout sees the located subject on the variant canvas and suggests moving a covering CTA', () => {
    const base = withMasterTrack();
    const withCta = (y: number) => {
      let ws = base;
      if (!ws.document.variables) ws = applyEdits(ws, [
        { kind: 'set-variable', variable: { id: 'cta', label: 'CTA', type: 'text', default: 'Book now' } },
        { kind: 'add-overlay-text', layerId: 'cta', label: '片尾 CTA', bind: 'cta', color: '#ffffff', startFrame: 0, durationFrames: 312, box: { x: 0.3, y: 0.8, width: 0.4, height: 0.08 } },
      ]);
      return locate(ws, variantRegion(y));
    };
    // 变体画布上 bind 已解析成固定文字，按 id 寻址。
    // CTA 在 y 1024..1126；主体在 y 400..490 → 不重叠。
    const clear = withCta(400);
    expect(checkNoOverlap(variantDocument(clear.document, 'jp-9x16'), 'overlay#cta', 'entity:product', 16).ok).toBe(true);
    // 主体挪到 y 1050..1140 → 与 CTA 重叠，检查失败并提出建议。
    const covered = withCta(1050);
    const check = checkNoOverlap(variantDocument(covered.document, 'jp-9x16'), 'overlay#cta', 'entity:product', 16);
    expect(check.ok).toBe(false);
    expect(check.violations.some(v => v.avoid === 'product' && v.count > 0)).toBe(true);
    expect(check.suggestions.length).toBeGreaterThan(0);
    expect(check.suggestions[0]!.layerId).toBe('cta');
  });
  it('rejects locating a subject the master never tracked, and a variant without a take', () => {
    const region = variantRegion(400);
    const code = (fn: () => unknown) => { try { fn(); return null; } catch (e) { return e instanceof EventError ? e.code : (e as Error).message; } };
    expect(code(() => planDocumentEdit(fixture().document, { kind: 'track-variant-region', variantId: 'jp-9x16', region }))).toBe('MISSING_VARIANT');
    const noTake = applyEdits(fixture(), [
      { kind: 'set-variant-set', set: { masterAssetId: Object.values(fixture().document.editor.assets).find(a => a.kind === 'video')!.id, brief: '', keep: ['Story beats'], axes: [{ id: 'aspect', label: '画幅', values: [{ id: '9x16', label: '9:16', attrs: { aspect: '9x16' } }] }] } },
      { kind: 'add-variants', items: [{ id: 'jp-9x16', coords: { aspect: '9x16' }, review: 'pending' }] },
    ]);
    expect(code(() => planDocumentEdit(noTake.document, { kind: 'track-variant-region', variantId: 'jp-9x16', region }))).toBe('MISSING_TAKE');
    expect(() => planDocumentEdit(withMasterTrack().document, { kind: 'track-variant-region', variantId: 'jp-9x16', region: { ...region, boxes: region.boxes.map(() => []) } })).toThrow(new RegExp('no frames'));
  });
  it('a region whose take no longer matches is stale and stays out of the derived canvas', () => {
    let ws = withMasterTrack();
    ws = locate(ws, variantRegion(400));
    ws = applyEdits(ws, [{ ...take(8, 1080, 1920), variantId: 'jp-9x16' }]); // take 换了
    const vd = variantDocument(ws.document, 'jp-9x16');
    expect(vd.semantic.entities.product).toBeUndefined();
    expect(resolveSelector(vd, 'entity:product')).toEqual([]);
  });
  it('the locate edit rolls back like any other transaction', () => {
    const ws = withMasterTrack();
    const plan = planDocumentEdit(ws.document, { kind: 'track-variant-region', variantId: 'jp-9x16', region: variantRegion(400) });
    const next = applyDocumentEdit(ws, plan);
    expect(next.document.variants!.items['jp-9x16']!.regions!.product).toBeDefined();
    const back = rollbackAction(next, plan.id);
    expect(back.document.variants!.items['jp-9x16']!.regions).toBeUndefined();
    expect(resolveEvents(back.document).find(e => e.id === 'region-product')).toBeUndefined();
  });
});