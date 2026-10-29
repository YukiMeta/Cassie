import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { planDocumentEdit, applyDocumentEdit, parseWorkspace, resolveEvents, rollbackAction } from '@cassie/harness';
import { compileScene } from '@cassie/runtime';
import type { SubjectRegion } from '@cassie/spec';

const fixture = () => parseWorkspace(readFileSync(new URL('../examples/film-regions/project.cassie.json', import.meta.url), 'utf8'));
const held = (): SubjectRegion => JSON.parse(readFileSync(new URL('../examples/film-regions/region-s4-held.json', import.meta.url), 'utf8'));
const track = (ws: ReturnType<typeof fixture>, region = held()) => applyDocumentEdit(ws, planDocumentEdit(ws.document, { kind: 'track-region', region, name: 'VR 头显' }));

describe('tracked part-of-shot regions', () => {
  it('puts the tracked lifecycle on the timeline, anchored to its shot', () => {
    const ws = track(fixture());
    const event = resolveEvents(ws.document).find(e => e.id === 'region-s4-held')!;
    expect([event.startFrame, event.endFrame]).toEqual([945, 1002]);
    expect(ws.document.events.find(e => e.id === 'region-s4-held')!.start).toEqual({ eventId: 's4', edge: 'start', offsetFrames: 57 });
    expect(ws.document.semantic.entities.product!.attributes.regions).toEqual(['s4-held']);
  });
  it('follows the shot when the shot is moved on the timeline', () => {
    const ws = track(fixture());
    const moved = applyDocumentEdit(ws, planDocumentEdit(ws.document, { kind: 'set-event-timing', eventId: 's4', startFrame: 900, durationFrames: 192 }));
    const event = resolveEvents(moved.document).find(e => e.id === 'region-s4-held')!;
    expect([event.startFrame, event.endFrame]).toEqual([957, 1014]);
  });
  it('one entity owns regions in several shots, and a look edit is one undoable transaction', () => {
    let ws = track(fixture());
    const other = { ...held(), id: 's4-copy', eventId: 'region-s4-copy' };
    ws = track(ws, other);
    expect(ws.document.semantic.entities.product!.attributes.regions).toEqual(['s4-held', 's4-copy']);
    const plan = planDocumentEdit(ws.document, { kind: 'set-region-look', regionId: 's4-held', patch: { color: '#ff2d55', tint: 0.5 } });
    const next = applyDocumentEdit(ws, plan);
    expect(next.document.regions!['s4-held']!.look).toMatchObject({ color: '#ff2d55', tint: 0.5 });
    expect(rollbackAction(next, plan.id).document.regions).toEqual(ws.document.regions);
  });
  it('rejects regions on non-video layers, broken boxes and bad looks', () => {
    const ws = fixture();
    expect(() => planDocumentEdit(ws.document, { kind: 'track-region', region: { ...held(), layerId: 'layer-card-0' } })).toThrow(/video layer/);
    expect(() => planDocumentEdit(ws.document, { kind: 'track-region', region: { ...held(), boxes: held().boxes.map(() => []) } })).toThrow(/no frames/);
    const tracked = track(ws);
    expect(() => planDocumentEdit(tracked.document, { kind: 'set-region-look', regionId: 's4-held', patch: { tint: 3 } })).toThrow();
    expect(() => planDocumentEdit(tracked.document, { kind: 'set-region-look', regionId: 's4-held', patch: { x: 1 } as never })).toThrow(/color\/tint\/feather/);
  });
  it('compiles a per-frame box for the region inside its video layer', () => {
    const ws = track(fixture()), urls = Object.fromEntries(Object.keys(ws.document.media).map(id => [id, `media/${id}.mp4`]));
    const html = compileScene(ws.document, urls);
    expect(html).toContain('id="region-s4-held"');
    expect(html).toContain('"shotEventId":"s4"');
    expect(html).toContain('mix-blend-mode:color');
  });
});
