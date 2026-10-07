import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyAction, applyDocumentEdit, canonical, parseWorkspace, planAction, planDocumentEdit, resolveEvents, rollbackAction } from '@cassie/harness';
import type { EventWorkspace, DocumentEdit, GenerationReceipt } from '@cassie/spec';
import { compileScene } from '../packages/runtime/src/render';
const fixture=():EventWorkspace=>{
 const ws=parseWorkspace(readFileSync(new URL('../examples/action-flow/project.cassie.json',import.meta.url),'utf8')),d=ws.document;
 d.actions.gesture!.execution='video-edit';
 d.editor.assets.source={id:'source',kind:'video',name:'source.mp4',durationUs:10_000_000,width:960,height:540};
 d.media.source={path:'media/source.mp4',sha256:'a'.repeat(64)};
 d.editor.tracks.push({id:'footage',kind:'video',name:'Source',locked:false,clips:[{id:'shot',assetId:'source',startUs:500_000,endUs:2_500_000,sourceInUs:0,attrs:{}}]});
 d.events[0]!.clipId='shot';d.semantic.entities.presenter!.binds.push({targetType:'clip',targetId:'shot',role:'primary'});
 Object.assign(d.scene.layers[0]!,{kind:'video',assetId:'source'});
 return ws;
};
const matteEdit=():Extract<DocumentEdit,{kind:'attach-subject-matte'}>=>({kind:'attach-subject-matte',eventId:'greeting',asset:{id:'mask',kind:'video',name:'mask.mp4',durationUs:2_000_000,width:960,height:540},media:{path:'media/mask.mp4',sha256:'b'.repeat(64)},matte:{entityId:'presenter',eventId:'greeting',sourceAssetId:'source',sourceSha256:'a'.repeat(64),sourceStartFrame:0,frames:60,width:960,height:540,frameRate:{num:30,den:1},maskAssetId:'mask',backend:'test-metadata-only',quality:'draft'}});
describe('subject mask and user-authored action transactions',()=>{
 it('attaches the mask atomically, persists it and reverses it',()=>{
  const ws=fixture(),plan=planDocumentEdit(ws.document,matteEdit()),next=applyDocumentEdit(ws,plan);
  expect(parseWorkspace(JSON.stringify(next)).document.subjectMattes?.greeting).toMatchObject({sourceSha256:'a'.repeat(64),maskAssetId:'mask'});
  expect(rollbackAction(next,plan.id).document.subjectMattes).toBeUndefined();
  expect(rollbackAction(next,plan.id).document.media.mask).toBeUndefined();
 });
 it('rejects source, clock and dimension mismatch and respects subject locks',()=>{
  const ws=fixture(),edit=matteEdit();edit.matte.sourceSha256='c'.repeat(64);
  expect(()=>planDocumentEdit(ws.document,edit)).toThrow(/provenance/);
  edit.matte.sourceSha256='a'.repeat(64);edit.matte.frameRate.num=24;expect(()=>planDocumentEdit(ws.document,edit)).toThrow(/frame domain/);
  edit.matte.frameRate.num=30;edit.matte.width=720;expect(()=>planDocumentEdit(ws.document,edit)).toThrow();
  edit.matte.width=960;ws.document.semantic.entities.presenter!.locked=true;expect(()=>planDocumentEdit(ws.document,edit)).toThrow();
 });
 it('plans a new named action with its mask, propagates duration and does not mutate project',()=>{
  const ws=fixture(),withMask=applyDocumentEdit(ws,planDocumentEdit(ws.document,matteEdit())),before=canonical(withMask);
  const edit={kind:'set-action-state' as const,eventId:'greeting',state:'custom-wave',instruction:'Raise the right hand and wave once.',durationFrames:120};
  const plan=planAction(withMask.document,edit);
  expect(canonical(withMask)).toBe(before);expect(plan.status).toBe('awaiting-media');
  expect(plan.tasks[0]).toMatchObject({instruction:edit.instruction,outputFrames:120,sourceDurationUs:2_000_000,selection:{matte:{frames:60},mask:{sha256:'b'.repeat(64)}}});
  expect(plan.changes.find(c=>c.eventId==='product-reveal')!.after.startFrame).toBe(141);
  expect(()=>applyAction(withMask,plan)).toThrow(/receipt/);
  const receipt:GenerationReceipt={taskId:plan.tasks[0]!.id,assetId:'candidate',media:{path:'media/candidate.mp4',sha256:'d'.repeat(64)},frames:120,width:960,height:540,frameRate:{num:30,den:1},provider:'test-only-no-model',review:{accepted:true,note:'Synthetic contract test, not action quality evidence'}};
  const changed=applyAction(withMask,plan,[receipt]);
  expect(changed.document.actions.gesture!.states['custom-wave']).toEqual({label:edit.instruction,durationFrames:120});
  expect(resolveEvents(changed.document).find(e=>e.id==='product-reveal')!.startFrame).toBe(141);
  expect(rollbackAction(changed,plan.id).document.actions).toEqual(withMask.document.actions);
 });
 it('fails when an attached mask no longer covers the source window',()=>{
  const ws=fixture(),next=applyDocumentEdit(ws,planDocumentEdit(ws.document,matteEdit()));
  next.document.editor.tracks.at(-1)!.clips[0]!.sourceInUs=500_000;
  expect(()=>planAction(next.document,{kind:'set-action-state',eventId:'greeting',state:'point'})).toThrow(/Re-extract/);
 });
 it('rejects instruction tampering and unsafe custom state requests',()=>{
  const ws=fixture(),edit={kind:'set-action-state' as const,eventId:'greeting',state:'custom',instruction:'Wave once.',durationFrames:90};
  const plan=planAction(ws.document,edit);plan.tasks[0]!.instruction='Different action';
  expect(()=>applyAction(ws,plan)).toThrow(/compiled edit/);
  expect(()=>planAction(ws.document,{...edit,durationFrames:0})).toThrow();
  expect(()=>planAction(ws.document,{...edit,instruction:' '})).toThrow();
 });
 it('compiles actual foreground preview and preserves video at frame zero',()=>{
  const ws=fixture(),next=applyDocumentEdit(ws,planDocumentEdit(ws.document,matteEdit()));
  const html=compileScene(next.document,{source:'media/source.mp4',mask:'media/mask.mp4'},'greeting');
  expect(html).toContain('id="foreground"');expect(html).toContain('id="subject-mask"');
  expect(html).toContain("destination-in");expect(html).toContain("layer.kind!=='video'");
  expect(()=>compileScene(ws.document,{source:'media/source.mp4'},'greeting')).toThrow(/matte/);
 });
});
