import { describe, expect, it } from 'vitest';
import type { AnalysisSource, VideoAnalysis } from '@cassie/spec';
import { parseGrounding, parseObservation } from '../packages/runtime/src/analysis-validation';
import { samplingFrames } from '../packages/runtime/src/analyze';
import { checkUnderstandingConfig } from '../packages/runtime/src/analysis-model';

const source: AnalysisSource = { assetId:'source',sha256:'a'.repeat(64),frames:96,frameRate:{num:24,den:1},width:160,height:120 };
const observed = () => ({ summary:'人物转头两次', entities:[{id:'person-01',name:'人物',description:'红衣人物',visibleRanges:[{startFrame:0,endFrame:96}],evidenceFrames:[0,48]}], events:[{id:'turn-01',entityIds:['person-01'],description:'第一次转头',range:{startFrame:0,endFrame:24},evidenceFrames:[12],uncertainty:'边界为稀疏采样估计'},{id:'turn-02',entityIds:['person-01'],description:'第二次转头',range:{startFrame:48,endFrame:72},evidenceFrames:[48,60],uncertainty:''}],uncertainties:['可能遗漏快速动作'] });
const samples = [0,12,24,36,48,60,72,84,95];
const analysis = ():VideoAnalysis => ({schema:'cassie/analysis@1',id:'analysis-1',source,createdAt:'2026-10-29',model:'fixture',promptVersion:'test',sampling:{frameNumbers:samples,strategy:'test'},status:'proposed',...parseObservation(observed(),source,samples)});
const target = () => ({ eventId:'turn-02',entityIds:['person-01'],range:{startFrame:48,endFrame:72},evidenceFrames:[48,60],reason:'第二次转头' });

describe('short-video observation contracts',()=>{
  it('keeps the final source frame and bounds sampling even at fractional frame rates',()=>{
    const input={...source,frames:450,frameRate:{num:30000,den:1001}};
    const frames=samplingFrames(input);
    expect(frames[0]).toBe(0); expect(frames.at(-1)).toBe(449); expect(frames.length).toBeLessThanOrEqual(32);
    expect(new Set(frames).size).toBe(frames.length);
    expect(samplingFrames(source,[{startFrame:-12,endFrame:120}],8,16).at(-1)).toBe(95);
  });
  it('preserves repeated action ids and allows uncertainty rather than merging actions',()=>{
    expect(analysis().events.map(e=>e.id)).toEqual(['turn-01','turn-02']);
    expect(analysis().status).toBe('proposed');
  });
  it('rejects invented evidence, nonexistent identities and invalid source windows',()=>{
    const invalidEvidence=observed(); invalidEvidence.events[0]!.evidenceFrames=[13];
    expect(()=>parseObservation(invalidEvidence,source,samples)).toThrow(/actually supplied/);
    const unknown=observed(); unknown.events[0]!.entityIds=['someone-else'];
    expect(()=>parseObservation(unknown,source,samples)).toThrow(/unknown entity/);
    const outside=observed(); outside.events[0]!.range.endFrame=100;
    expect(()=>parseObservation(outside,source,samples)).toThrow(/outside/);
    const duplicate=observed(); duplicate.events[1]!.id='turn-01';
    expect(()=>parseObservation(duplicate,source,samples)).toThrow(/Duplicate/);
  });
  it('only resolves one supported candidate; ambiguity and absence stay explicit',()=>{
    expect(parseGrounding({status:'resolved',explanation:'找到第二次',candidates:[target()]},analysis(),samples).status).toBe('resolved');
    expect(parseGrounding({status:'not_found',explanation:'没有第三次的证据',candidates:[]},analysis(),samples).candidates).toEqual([]);
    expect(()=>parseGrounding({status:'resolved',explanation:'不确定',candidates:[target(),target()]},analysis(),samples)).toThrow(/contradicts/);
    expect(()=>parseGrounding({status:'resolved',explanation:'虚构事件',candidates:[{...target(),eventId:'turn-03'}]},analysis(),samples)).toThrow(/Unknown target event/);
    expect(()=>parseGrounding({status:'resolved',explanation:'错误时间',candidates:[{...target(),range:{startFrame:0,endFrame:24},evidenceFrames:[12]}]},analysis(),samples)).toThrow(/overlap/);
  });
  it('does not accept credentials embedded in model URLs',()=>{
    expect(()=>checkUnderstandingConfig({baseUrl:'https://key:secret@example.com/v1',apiKey:'x',model:'fixture'})).toThrow();
  });
});
