/** Headless contract test: no web server, browser, provider config or API key. Observations are explicit fixtures. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {runProcess,readWorkspace} from '../packages/runtime/src/index';
import {canonical} from '../packages/harness/src/index';

const root=resolve(new URL('..',import.meta.url).pathname),cli=join(root,'packages/cli/src/main.ts');
const dir=await mkdtemp(join(tmpdir(),'cassie-native-agent-'));
const env={...process.env,CASSIE_VISION_API_KEY:'',CASSIE_VISION_BASE_URL:'',CASSIE_VISION_MODEL:'',CASSIE_UNDERSTANDING_CONFIG:''};
let child:ReturnType<typeof spawn>|undefined;
const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();let next=0;
let errors='';
try{
 const source=join(dir,'source.mp4'),project=join(dir,'project.json');
 await runProcess('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x120:rate=24:duration=4','-c:v','libx264','-pix_fmt','yuv420p',source]);
 const imported=JSON.parse(await runProcess(process.execPath,['--import','tsx',cli,'import-video',source,'--out',project]));assert.equal(imported.project,project);
 child=spawn(process.execPath,['--import','tsx',cli,'mcp',project],{cwd:root,env,stdio:['pipe','pipe','pipe']});
 child.stderr!.on('data',c=>{errors=(errors+c).slice(-10000);});
 createInterface({input:child.stdout!}).on('line',line=>{
   try{const response=JSON.parse(line),waiting=pending.get(response.id);if(!waiting)return;pending.delete(response.id);if(response.error)waiting.reject(new Error(response.error.message));else waiting.resolve(response.result);}
   catch(e){for(const w of pending.values())w.reject(new Error(`Invalid MCP stdout: ${line}`));}
 });
 child.on('exit',()=>{for(const w of pending.values())w.reject(new Error(`MCP exited: ${errors}`));pending.clear();});
 const rpc=(method:string,params:unknown={})=>new Promise<any>((resolve,reject)=>{
   const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP timeout'));},30000);
   pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});
   child!.stdin!.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
 });
 const tool=async(name:string,args:unknown)=>{
   const r=await rpc('tools/call',{name,arguments:args});assert.ok(!r.isError,JSON.stringify(r));return r;
 };
 const value=async(name:string,args:unknown)=>JSON.parse((await tool(name,args)).content[0].text);
 const initialized=await rpc('initialize');assert.match(initialized.instructions,/No browser/);
 const manifest=await rpc('tools/list');assert.ok(manifest.tools.some((t:any)=>t.name==='prepare_video_evidence'));assert.ok(!manifest.tools.some((t:any)=>t.name==='list_variants'));
 const overview=await value('project_overview',{}),assetId=overview.videoSources[0].id;
 const before=canonical(await readWorkspace(project));
 const bundle=await value('prepare_video_evidence',{assetId});assert.equal(bundle.source.frames,96);assert.ok(bundle.frames.length>=8);
 const image=await tool('read_evidence_frame',{bundleId:bundle.id,sourceFrame:48});assert.equal(image.content[1].type,'image');assert.equal(image.content[1].mimeType,'image/jpeg');
 const observations={summary:'Fixture only: two turns',entities:[{id:'person-01',name:'fixture person',description:'contract fixture',visibleRanges:[{startFrame:0,endFrame:96}],evidenceFrames:[0]}],events:[{id:'turn-01',entityIds:['person-01'],description:'first turn',range:{startFrame:0,endFrame:24},evidenceFrames:[12],uncertainty:'fixture'},{id:'turn-02',entityIds:['person-01'],description:'second turn',range:{startFrame:48,endFrame:72},evidenceFrames:[48],uncertainty:'fixture'}],uncertainties:['Not a model-quality test']};
 const a=await value('submit_video_analysis',{bundleId:bundle.id,observations,model:'test-agent-fixture'});
 const focused=await value('prepare_video_evidence',{assetId,startFrame:48,endFrame:72,fps:8});
 const binding={status:'resolved',explanation:'fixture second turn',candidates:[{eventId:'turn-02',entityIds:['person-01'],range:{startFrame:48,endFrame:72},evidenceFrames:[48],reason:'fixture'}]};
 const g=await value('submit_video_grounding',{bundleId:focused.id,analysisId:a.id,query:'第二次转头',result:binding});assert.equal(g.analysisId,a.id);
 assert.equal((await value('read_video_analysis',{assetId})).grounding.id,g.id);
 assert.equal(canonical(await readWorkspace(project)),before,'Native observations and grounding are not edit transactions');
 const added=await value('add_video_source',{sourcePath:source});assert.ok(added.transactionId);
 await value('rollback',{transactionId:added.transactionId});
 const current=await readWorkspace(project);assert.equal(current.document.media[added.assetId],undefined);
 const data=join(dir,'observations.json');await writeFile(data,JSON.stringify(observations));
 const cliBundle=JSON.parse(await runProcess(process.execPath,['--import','tsx',cli,'evidence',project,'--asset',assetId]));
 const cliAnalysis=JSON.parse(await runProcess(process.execPath,['--import','tsx',cli,'record-analysis',project,'--bundle',cliBundle.id,'--data',data]));assert.equal(cliAnalysis.source.sha256,a.source.sha256);
 const exportedFrame=join(dir,'evidence.jpg');
 await runProcess(process.execPath,['--import','tsx',cli,'evidence-frame',project,'--bundle',cliBundle.id,'--frame','48','--out',exportedFrame]);assert.equal((await readFile(exportedFrame)).subarray(0,2).toString('hex'),'ffd8');
 console.log('PASS: CLI imports local video; MCP prepares evidence/images, records native-agent observations and grounding, reads durable results, imports source and rolls back.');
 console.log('PASS: CLI evidence/record-analysis/evidence-frame work without a browser, HTTP server, model config or API key. Fixtures do not measure actual vision quality.');
}finally{
 child?.stdin?.end();
 if(child && child.exitCode===null)await new Promise<void>(resolve=>{const timer=setTimeout(()=>{child!.kill('SIGKILL');resolve();},3000);child!.once('exit',()=>{clearTimeout(timer);resolve();});});
 await rm(dir,{recursive:true,force:true});
}
