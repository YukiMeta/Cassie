import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { planDocumentEdit, applyDocumentEdit, parseWorkspace, rollbackAction, variantDocument, staleSubjects, subjectRefsFor, applyPatch, diff, resolveEvents, resolveFrameCount } from '@cassie/harness';
import { applyEdits, compileScene, takePattern, variantRows } from '@cassie/runtime';
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

describe('variants follow the master', () => {
  const withCta = () => applyEdits(withSet(), [
    { kind: 'set-variable', variable: { id: 'cta', label: 'CTA', type: 'text', default: 'Book now' } },
    { kind: 'add-overlay-text', layerId: 'cta', label: '片尾 CTA', bind: 'cta', color: '#ffffff', startFrame: 0, durationFrames: 48, box: { x: 0.3, y: 0.8, width: 0.4, height: 0.08 } },
    { ...take(7, 720, 1280), variantId: 'jp-9x16' },
  ]);
  it('code lane: a master text edit reaches every variant, and variant values override it', () => {
    let ws = withCta();
    const text = (id: string) => variantDocument(ws.document, id).scene.layers.find(l => l.id === 'cta')!.text;
    expect(text('jp-9x16')).toBe('Book now');
    ws = applyEdits(ws, [{ kind: 'set-variable', variable: { id: 'cta', label: 'CTA', type: 'text', default: 'Book today' } }]);
    expect(text('jp-9x16')).toBe('Book today');
    expect(text('jp-16x9')).toBe('Book today');
    ws = applyEdits(ws, [{ kind: 'set-variant-values', variantId: 'jp-9x16', values: { cta: '今すぐ予約' } }]);
    expect(text('jp-9x16')).toBe('今すぐ予約');
    expect(text('jp-16x9')).toBe('Book today');
  });
  it('the compiled variant scene keeps the variant value, not the master default', () => {
    const ws = applyEdits(withCta(), [{ kind: 'set-variant-values', variantId: 'jp-9x16', values: { cta: '今すぐ予約' } }]);
    const vd = variantDocument(ws.document, 'jp-9x16');
    const html = compileScene(vd, Object.fromEntries(Object.keys(vd.media).map(id => [id, `media/${id}.mp4`])));
    expect(html).toContain('今すぐ予約');
    expect(html).not.toContain('Book now');
    expect(ws.document.variables?.cta).toBeDefined();
  });
  it('places master overlays on the take canvas, inside the frame', () => {
    const vd = variantDocument(withCta().document, 'jp-9x16');
    expect(vd.editor.settings).toMatchObject({ width: 720, height: 1280 });
    const cta = vd.scene.layers.find(l => l.id === 'cta')!;
    expect(cta.x).toBeGreaterThanOrEqual(0);
    expect(cta.x + cta.width).toBeLessThanOrEqual(720);
    expect(cta.y + cta.height).toBeLessThanOrEqual(1280);
    expect(vd.scene.layers[0]).toMatchObject({ kind: 'video', assetId: 'take-7', width: 720, height: 1280 });
  });
  it('an end-anchored card sits at the end of a longer take', () => {
    const base = withSet(), last = resolveFrameCount(base.document);
    const ws = applyEdits(base, [
      { kind: 'add-overlay-text', layerId: 'end', label: 'End card', text: 'Fin', color: '#ffffff', startFrame: last - 24, durationFrames: 24, box: { x: 0.3, y: 0.4, width: 0.4, height: 0.1 }, anchor: 'end' },
      { ...take(9, 720, 1280), variantId: 'jp-9x16' },
    ]);
    const masterEnd = resolveEvents(ws.document).find(e => e.id === 'overlay-end')!;
    const vd = variantDocument(ws.document, 'jp-9x16'), frames = Math.floor(13 * vd.frameRate.num / vd.frameRate.den);
    const card = resolveEvents(vd).find(e => e.id === 'overlay-end')!;
    expect(card.endFrame - card.startFrame).toBe(24);
    expect(frames - card.startFrame).toBe(resolveFrameCount(ws.document) - masterEnd.startFrame);
  });
  it('subject lane: a new reference makes takes stale until a synced take arrives', () => {
    let ws = withCta();
    const ref = (n: number): DocumentEdit => ({ kind: 'set-subject-reference', entityId: 'phone', name: '手机', reference: { entityId: 'phone', assetId: `ref-${n}`, sha256: sha(100 + n), prompt: 'smartphone in hand', instruction: 'Replace with the reference phone' }, asset: { id: `ref-${n}`, kind: 'image', name: 'ref.png', durationUs: 0, width: 512, height: 512 }, media: { path: `media/${sha(100 + n)}.png`, sha256: sha(100 + n) } });
    ws = applyEdits(ws, [ref(1)]);
    expect(staleSubjects(ws.document, ws.document.variants!.items['jp-9x16']!)).toEqual(['phone']);
    const synced = { ...take(8, 720, 1280), variantId: 'jp-9x16' };
    synced.take = { ...synced.take, basis: { phone: sha(101) } };
    ws = applyEdits(ws, [synced]);
    expect(staleSubjects(ws.document, ws.document.variants!.items['jp-9x16']!)).toEqual([]);
    ws = applyEdits(ws, [ref(2)]);
    expect(staleSubjects(ws.document, ws.document.variants!.items['jp-9x16']!)).toEqual(['phone']);
  });
  it('subject lane: a scoped reference only reaches matching variants and outranks the global one', () => {
    let ws = withCta();
    const ref = (n: number, scope?: Record<string, string>): DocumentEdit => ({ kind: 'set-subject-reference', entityId: 'host', name: '主播', reference: { entityId: 'host', ...(scope ? { scope } : {}), assetId: `ref-${n}`, sha256: sha(100 + n), prompt: 'woman on camera', instruction: 'Replace the host' }, asset: { id: `ref-${n}`, kind: 'image', name: 'ref.png', durationUs: 0, width: 512, height: 512 }, media: { path: `media/${sha(100 + n)}.png`, sha256: sha(100 + n) } });
    ws = applyEdits(ws, [{ kind: 'add-variants', items: [{ id: 'kr-9x16', coords: { market: 'kr', aspect: '9x16' }, review: 'pending' }] }, { ...take(10, 720, 1280), variantId: 'kr-9x16' }, ref(3, { market: 'kr' })]);
    expect(staleSubjects(ws.document, ws.document.variants!.items['jp-9x16']!)).toEqual([]);
    expect(staleSubjects(ws.document, ws.document.variants!.items['kr-9x16']!)).toEqual(['host']);
    ws = applyEdits(ws, [ref(4)]);
    expect(Object.keys(ws.document.subjectRefs!).sort()).toEqual(['host', 'host@market=kr']);
    expect(subjectRefsFor(ws.document, ws.document.variants!.items['kr-9x16']!).host!.sha256).toBe(sha(103));
    expect(subjectRefsFor(ws.document, ws.document.variants!.items['jp-9x16']!).host!.sha256).toBe(sha(104));
    expect(() => applyEdits(ws, [ref(5, { market: 'fr' })])).toThrow();
    expect(() => variantDocument(ws.document, 'kr-9x16')).not.toThrow();
  });
});

describe('history as patches', () => {
  it('stores diffs, not documents, and still rolls back exactly', () => {
    const before = withSet();
    const plan = planDocumentEdit(before.document, { kind: 'review-variant', variantId: 'jp-16x9', review: 'rejected', note: 'wrong host' });
    const after = applyDocumentEdit(before, plan);
    const tx = after.transactions.at(-1)!;
    expect(JSON.stringify(tx).length).toBeLessThan(2000);
    expect(tx.patch.every(op => op.path[0] === 'variants')).toBe(true);
    const back = rollbackAction(after, plan.id);
    expect({ ...back.document, editor: { ...back.document.editor, revision: 0 } }).toEqual({ ...before.document, editor: { ...before.document.editor, revision: 0 } });
  });
  it('round-trips a structural diff', () => {
    const a = { x: [1, 2, 3], y: { z: 'a', gone: 1 } }, b = { x: [1, 2], y: { z: 'b', added: true } };
    expect(applyPatch(a, diff(a, b))).toEqual(b);
    expect(applyPatch(b, diff(b, a))).toEqual(a);
  });
  it('migrates old files that stored full before/after documents', () => {
    const ws = withSet(), tx = ws.transactions.at(-1)!;
    const legacy = { ...ws, transactions: [{ id: tx.id, status: tx.status, plan: { edit: tx.edit, baseRevision: tx.baseRevision, changes: tx.changes }, before: applyPatch({ ...ws.document, editor: { ...ws.document.editor, revision: 0 } }, tx.inverse), after: ws.document, receipts: [], journal: tx.journal }] };
    const migrated = parseWorkspace(JSON.stringify(legacy));
    expect(migrated.transactions[0]!.patch.length).toBeGreaterThan(0);
    expect(rollbackAction(migrated, tx.id).document.variants!.items['jp-16x9']).toBeUndefined();
  });
});

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
