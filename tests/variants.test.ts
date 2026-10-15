import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { planDocumentEdit, applyDocumentEdit, parseWorkspace, rollbackAction } from '@cassie/harness';
import { applyEdits, takePattern, variantRows } from '@cassie/runtime';
import type { DocumentEdit, EventWorkspace, VariantTake } from '@cassie/spec';

const fixture = () => parseWorkspace(readFileSync(new URL('../examples/film-regions/project.cassie.json', import.meta.url), 'utf8'));
const master = (ws: EventWorkspace) => Object.values(ws.document.editor.assets).find(a => a.kind === 'video')!.id;
const sha = (n: number) => n.toString(16).padStart(64, '0');
const take = (n: number, width: number, height: number): Extract<DocumentEdit, { kind: 'attach-variant-take' }> => {
  const t: VariantTake = { assetId: `take-${n}`, sha256: sha(n), width, height, durationUs: 13_000_000, provider: 'v2v' };
  return { kind: 'attach-variant-take', variantId: '', take: t, asset: { id: t.assetId, kind: 'video', name: `${n}.mp4`, durationUs: t.durationUs, width, height }, media: { path: `media/${t.sha256}.mp4`, sha256: t.sha256 } };
};
const withSet = () => {
  const ws = fixture();
  return applyEdits(ws, [
    { kind: 'set-variant-set', set: { masterAssetId: master(ws), brief: 'Localize the host and voice', keep: ['Story beats'], axes: [
      { id: 'market', label: '市场', values: [{ id: 'jp', label: 'Japan', attrs: { language: '日本語' } }, { id: 'kr', label: 'Korea' }] },
      { id: 'aspect', label: '画幅', values: [{ id: '16x9', label: '16:9', attrs: { aspect: '16x9' } }, { id: '9x16', label: '9:16', attrs: { aspect: '9x16' } }] },
    ] } },
    { kind: 'add-variants', items: [{ id: 'jp-16x9', coords: { market: 'jp', aspect: '16x9' }, review: 'pending' }, { id: 'jp-9x16', coords: { market: 'jp', aspect: '9x16' }, review: 'pending' }] },
  ]);
};

describe('one master, many variants', () => {
  it('reads axes out of take file names', () => {
    const p = takePattern('take-{market}-{aspect}-{location}.mp4');
    expect(p.axes).toEqual(['market', 'aspect', 'location']);
    expect(p.match('take-jp-9x16-kyoto.mp4')).toEqual({ market: 'jp', aspect: '9x16', location: 'kyoto' });
    expect(p.match('original-bali-clip.mp4')).toBeNull();
  });
  it('variants are rows on the master, not copies of the project', () => {
    const ws = withSet();
    expect(Object.keys(ws.document.variants!.items)).toEqual(['jp-16x9', 'jp-9x16']);
    expect(ws.document.events).toEqual(fixture().document.events);
  });
  it('a take must match the aspect its axis pins', () => {
    const ws = withSet();
    expect(() => planDocumentEdit(ws.document, { ...take(1, 1280, 720), variantId: 'jp-9x16' })).toThrow(/expected 9x16/);
    const ok = applyDocumentEdit(ws, planDocumentEdit(ws.document, { ...take(1, 720, 1280), variantId: 'jp-9x16' }));
    expect(ok.document.variants!.items['jp-9x16']!.take!.assetId).toBe('take-1');
  });
  it('approval needs a take, rejection needs a reason, and both roll back', () => {
    let ws = withSet();
    expect(() => planDocumentEdit(ws.document, { kind: 'review-variant', variantId: 'jp-16x9', review: 'approved' })).toThrow(/without a take/);
    expect(() => planDocumentEdit(ws.document, { kind: 'review-variant', variantId: 'jp-16x9', review: 'rejected' })).toThrow(/what is wrong/);
    ws = applyDocumentEdit(ws, planDocumentEdit(ws.document, { ...take(2, 1920, 1080), variantId: 'jp-16x9' }));
    const plan = planDocumentEdit(ws.document, { kind: 'review-variant', variantId: 'jp-16x9', review: 'rejected', note: 'lip sync drifts at 0:07' });
    const rejected = applyDocumentEdit(ws, plan);
    expect(rejected.document.variants!.items['jp-16x9']).toMatchObject({ review: 'rejected', note: 'lip sync drifts at 0:07' });
    expect(rollbackAction(rejected, plan.id).document.variants!.items['jp-16x9']!.review).toBe('pending');
  });
  it('a new take resets review, and combinations stay unique', () => {
    let ws = withSet();
    ws = applyEdits(ws, [{ ...take(3, 1920, 1080), variantId: 'jp-16x9' }, { kind: 'review-variant', variantId: 'jp-16x9', review: 'approved' }, { ...take(4, 1920, 1080), variantId: 'jp-16x9' }]);
    expect(ws.document.variants!.items['jp-16x9']!.review).toBe('pending');
    expect(() => planDocumentEdit(ws.document, { kind: 'add-variants', items: [{ id: 'again', coords: { market: 'jp', aspect: '16x9' }, review: 'pending' }] })).toThrow(/share/);
  });
  it('exports flat batch rows with attributes and a naming template', () => {
    const ws = applyEdits(withSet(), [{ ...take(5, 720, 1280), variantId: 'jp-9x16' }]);
    const rows = variantRows(ws.document, 'renders/{market}_{aspect}.mp4');
    expect(rows.find(r => r.id === 'jp-9x16')).toMatchObject({ market: 'jp', marketLabel: 'Japan', language: '日本語', aspect: '9x16', output: 'renders/jp_9x16.mp4', take: `media/${sha(5)}.mp4` });
    expect(() => variantRows(ws.document, '{nope}.mp4')).toThrow(/placeholder/);
  });
});
