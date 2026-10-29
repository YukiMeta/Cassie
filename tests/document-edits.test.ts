import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { planDocumentEdit, applyDocumentEdit, parseWorkspace, resolveEvents, rollbackAction, planAction, applyAction } from '@cassie/harness';
const fixture = () => parseWorkspace(readFileSync(new URL('../examples/action-flow/project.cassie.json', import.meta.url),'utf8'));
describe('timeline and canvas writeback',()=>{
 it('keeps semantic anchors when dragging and propagates later action changes',()=>{
  const ws=fixture();const p=planDocumentEdit(ws.document,{kind:'set-event-timing',eventId:'product-reveal',startFrame:96,durationFrames:75});
  const next=applyDocumentEdit(ws,p);
  expect(next.document.events[1]!.start).toEqual({eventId:'greeting',edge:'end',offsetFrames:21});
  expect(resolveEvents(next.document).find(e=>e.id==='title')!.startFrame).toBe(90);
  const changed=applyAction(next,planAction(next.document,{kind:'set-action-state',eventId:'greeting',state:'point'}));
  expect(resolveEvents(changed.document).find(e=>e.id==='product-reveal')!.startFrame).toBe(126);
 });
 it('retimes action duration and all dependents atomically',()=>{
  const ws=fixture();const p=planDocumentEdit(ws.document,{kind:'set-event-timing',eventId:'greeting',startFrame:15,durationFrames:120});
  const next=applyDocumentEdit(ws,p);
  expect(resolveEvents(next.document).find(e=>e.id==='product-reveal')!.startFrame).toBe(141);
  expect(next.document.editor.revision).toBe(1);
  const restored=rollbackAction(parseWorkspace(JSON.stringify(next)),p.id);
  expect({...restored.document.editor,revision:0}).toEqual(ws.document.editor);
  expect(restored.document.events).toEqual(ws.document.events);
 });
 it('persists geometry with no timing changes and reverses it',()=>{
  const ws=fixture(), id=ws.document.scene.layers[0]!.id;
  const p=planDocumentEdit(ws.document,{kind:'set-layer',layerId:id,patch:{x:210,rotation:15,width:280}});
  expect(p.changes).toEqual([]);
  const next=applyDocumentEdit(ws,p);
  expect(next.document.scene.layers[0]).toMatchObject({x:210,rotation:15,width:280});
  expect(rollbackAction(next,p.id).document.scene).toEqual(ws.document.scene);
 });
 it('rejects stale, tampered, locked and invalid geometry edits',()=>{
  const ws=fixture(), id=ws.document.scene.layers[0]!.id;
  const edit={kind:'set-layer' as const,layerId:id,patch:{x:210}};
  const p=planDocumentEdit(ws.document,edit),next=applyDocumentEdit(ws,p);
  expect(()=>applyDocumentEdit(next,p)).toThrow(/changed/);
  p.next.scene.layers[0]!.x=999;expect(()=>applyDocumentEdit(ws,p)).toThrow(/differs/);
  expect(()=>planDocumentEdit(ws.document,{...edit,patch:{width:-2}})).toThrow();
  ws.document.semantic.entities.presenter!.locked=true;
  expect(()=>planDocumentEdit(ws.document,edit)).toThrow();
 });
 it('guards dependent locked entities and inactive events',()=>{
  const ws=fixture();ws.document.semantic.entities.product!.locked=true;
  expect(()=>planDocumentEdit(ws.document,{kind:'set-event-timing',eventId:'greeting',startFrame:30,durationFrames:60})).toThrow();
  expect(()=>planDocumentEdit(fixture().document,{kind:'set-event-timing',eventId:'point-label',startFrame:90,durationFrames:30})).toThrow(/inactive/);
 });
});
