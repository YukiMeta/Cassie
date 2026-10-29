import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyDocumentEdit, checkNoOverlap, frameRuns, parseSelector, parseWorkspace, planDocumentEdit, resolveSelector, shots } from '@cassie/harness';
import type { SubjectRegion } from '@cassie/spec';

const fixture = () => parseWorkspace(readFileSync(new URL('../examples/film-regions/project.cassie.json', import.meta.url), 'utf8'));
const held = (): SubjectRegion => JSON.parse(readFileSync(new URL('../examples/film-regions/region-s4-held.json', import.meta.url), 'utf8'));
const tracked = () => { const ws = fixture(); return applyDocumentEdit(ws, planDocumentEdit(ws.document, { kind: 'track-region', region: held(), name: 'VR 头显' })); };
const edit = (ws: ReturnType<typeof fixture>, e: Parameters<typeof planDocumentEdit>[1]) => applyDocumentEdit(ws, planDocumentEdit(ws.document, e));

describe('selectors over entity × time × region', () => {
  it('parses targets, filters and time ranges', () => {
    expect(parseSelector('entity:Bottle#host [shot=2] t=1..2.5 ~bbox', 24)).toEqual({ target: 'entity', concept: 'bottle', id: 'host', filters: { shot: '2' }, frames: [24, 60], part: 'bbox' });
    expect(parseSelector('overlay[var=cta]', 24).filters).toEqual({ var: 'cta' });
    expect(parseSelector('entity#product sf=120..240', 24).sourceFrames).toEqual([120, 240]);
    expect(() => parseSelector('layer#x', 24)).toThrow(/Cannot parse/);
    expect(() => parseSelector('clip t=3..1', 24)).toThrow(/Empty/);
  });

  it('a tracked entity resolves to its per-frame canvas boxes inside its lifecycle', () => {
    const [m] = resolveSelector(tracked().document, 'entity#product');
    expect(m!.target).toBe('entity');
    const runs = frameRuns(m!.boxes.keys());
    expect(runs[0]![0]).toBeGreaterThanOrEqual(945);
    expect(runs.at(-1)![1]).toBeLessThanOrEqual(1002);
    const box = m!.boxes.get(runs[0]![0])!;
    const w = tracked().document.editor.settings.width;
    expect(box[0]).toBeGreaterThanOrEqual(0);
    expect(box[0] + box[2]).toBeLessThanOrEqual(w + 1);
  });

  it('source-frame addressing survives moving the shot; timeline addressing follows the cut', () => {
    const ws = tracked();
    const before = resolveSelector(ws.document, 'entity#product sf=0..100000')[0]!;
    const moved = edit(ws, { kind: 'set-event-timing', eventId: 's4', startFrame: 900, durationFrames: 192 });
    const after = resolveSelector(moved.document, 'entity#product sf=0..100000')[0]!;
    expect(after.boxes.size).toBe(before.boxes.size);
    expect(Math.min(...after.boxes.keys()) - Math.min(...before.boxes.keys())).toBe(12);
  });

  it('[shot=N] limits to one shot and names a missing shot', () => {
    const d = tracked().document, list = shots(d);
    const s4 = list.findIndex(s => s.id === 's4') + 1;
    expect(resolveSelector(d, `entity#product [shot=${s4}]`)).toHaveLength(1);
    expect(resolveSelector(d, `entity#product [shot=${s4 === 1 ? 2 : 1}]`)).toHaveLength(0);
    expect(resolveSelector(d, `clip [shot=${s4}]`)[0]!.name).toBe(`镜头 ${s4}`);
    expect(() => resolveSelector(d, `clip [shot=${list.length + 1}]`)).toThrow(/No shot/);
  });

  it('no_overlap finds the frames a CTA covers the product and suggests a clear position', () => {
    let ws = tracked();
    const d = ws.document, { width: W, height: H } = d.editor.settings;
    const product = resolveSelector(d, 'entity#product')[0]!;
    const [f0, box] = [...product.boxes][0]!;
    ws = edit(ws, { kind: 'add-overlay-text', layerId: 'cta', label: 'CTA', text: '立即购买', color: '#ffffff', startFrame: f0, durationFrames: 30, box: { x: box[0] / W, y: (box[1] + box[3] / 2) / H, width: Math.min(0.3, box[2] / W), height: 0.06 } });
    const check = checkNoOverlap(ws.document, 'overlay#cta', 'entity#product', 16);
    expect(check.ok).toBe(false);
    expect(check.violations[0]).toMatchObject({ subject: 'cta', avoid: 'product' });
    const fix = check.suggestions[0]!;
    expect(fix.layerId).toBe('cta');
    const fixed = edit(ws, { kind: 'set-layer', layerId: 'cta', patch: fix.patch });
    expect(checkNoOverlap(fixed.document, 'overlay#cta', 'entity#product', 16).ok).toBe(true);
    const nothing = checkNoOverlap(fixed.document, 'overlay#cta', 'entity:nonexistent');
    expect(nothing.ok).toBe(false);
    expect(nothing.unchecked).toMatch(/matched nothing/);
  });
});
