/** Real ffmpeg + HTTP + disk, with an explicitly mocked vision provider. This is not a model-quality benchmark. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveWorkspace, runProcess, writeJson, readWorkspace, importVideoWorkspace, loadAnalysis, renderVideo, probeVideo } from '../packages/runtime/src/index';
import { canonical, planDocumentEdit, applyDocumentEdit, rollbackAction } from '../packages/harness/src/index';

const dir=await mkdtemp(join(tmpdir(),'cassie-analysis-test-'));
let runtime:Awaited<ReturnType<typeof serveWorkspace>>|undefined;
let modelCalls=0, seenImages=0;
const fakeKey='test-key-must-not-be-written';
const provider=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);
  const body=JSON.parse(Buffer.concat(chunks).toString()); modelCalls++;
  const blocks=body.messages[1].content;
  const images=blocks.filter((c:any)=>c.type==='image_url');seenImages+=images.length;
  for(const image of images)assert.match(image.image_url.url,/^data:image\/jpeg;base64,\/9j\//);
  const prompt=JSON.parse(blocks[0].text);
  const frameLabels=blocks.filter((c:any)=>c.type==='text'&&c.text.startsWith('SOURCE_FRAME')).map((c:any)=>Number(c.text.split(' ')[1]));
  if(images.length)assert.equal(images.length,frameLabels.length);
  const answer=prompt.query
    ? {status:'resolved',explanation:'测试桩：第二次转头',candidates:[{eventId:'turn-02',entityIds:['person-01'],range:{startFrame:48,endFrame:72},evidenceFrames:images.length?[frameLabels.find((f:number)=>f>=48&&f<72)]:[48],reason:'测试桩绑定，不代表真实视觉识别'}]}
    : {summary:'测试桩描述：两次转头',entities:[{id:'person-01',name:'测试人物',description:'仅测试契约',visibleRanges:[{startFrame:0,endFrame:96}],evidenceFrames:[0]}],events:[{id:'turn-01',entityIds:['person-01'],description:'第一次',range:{startFrame:0,endFrame:24},evidenceFrames:[12],uncertainty:'测试数据'},{id:'turn-02',entityIds:['person-01'],description:'第二次',range:{startFrame:48,endFrame:72},evidenceFrames:[48],uncertainty:'测试数据'}],uncertainties:['此内容来自 mock，不能用于模型质量评价']};
  res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({choices:[{message:{content:JSON.stringify(answer)}}]}));
});
try {
  await new Promise<void>((r,reject)=>{provider.once('error',reject);provider.listen(0,'127.0.0.1',r);});
  const addr=provider.address() as {port:number};
  const source=join(dir,'source.mp4'),file=join(dir,'project.json');
  await runProcess('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x120:rate=24:duration=4','-c:v','libx264','-pix_fmt','yuv420p',source]);
  const ws=await importVideoWorkspace(source,file,{entity:'fixture',instruction:'fixture'});await writeJson(file,ws);
  runtime=await serveWorkspace(file,0);
  const initial=await(await fetch(runtime.url+'/api/project')).json() as any;
  const post=(path:string,body:unknown,token=initial.token)=>fetch(runtime!.url+path,{method:'POST',headers:{'Content-Type':'application/json','X-Cassie-Token':token},body:JSON.stringify(body)});
  const cfg={baseUrl:`http://127.0.0.1:${addr.port}/v1`,model:'mock-vision',apiKey:fakeKey};
  const wait=async(id:string)=>{
    for(let i=0;i<200;i++){
      const job=await(await fetch(runtime!.url+'/api/render/'+id)).json() as any;
      if(job.status==='failed')throw new Error(job.message);
      if(job.status==='complete')return job.result;
      await new Promise(r=>setTimeout(r,50));
    }throw new Error('Job timeout');
  };
  assert.equal((await post('/api/analysis',{assetId:'source',cfg},'bad')).status,403);
  const before=canonical(await readWorkspace(file));
  const started=await post('/api/analysis',{assetId:'source',cfg});assert.equal(started.status,202);
  const a=await wait(((await started.json()) as any).id);
  assert.equal(a.events.length,2);assert.equal(a.source.frames,96);assert.equal(a.status,'proposed');
  assert.equal((await loadAnalysis(file,'source'))?.id,a.id);
  assert.equal(canonical(await readWorkspace(file)),before,'Caption must not edit the workspace or undo history');
  const locate=await post('/api/analysis/ground',{assetId:'source',analysisId:a.id,query:'第二次转头',cfg});
  const g=await wait(((await locate.json()) as any).id);
  assert.equal(g.candidates[0].eventId,'turn-02');assert.ok(g.sampling.frameNumbers.length>0);assert.equal(modelCalls,3);
  assert.ok(seenImages>9,'Grounding must actually re-read candidate images');
  const jpeg=await fetch(runtime.url+'/api/analysis/frame?assetId=source&frame=48');
  assert.equal(jpeg.status,200);assert.equal(jpeg.headers.get('content-type'),'image/jpeg');
  assert.equal(Buffer.from(await jpeg.arrayBuffer()).subarray(0,2).toString('hex'),'ffd8');
  assert.equal((await fetch(runtime.url+'/api/analysis/frame?assetId=source&frame=96')).status,400);
  const upload=await fetch(runtime.url+'/api/analysis/import',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Cassie-Token':initial.token,'X-Cassie-Filename':'fixture.mp4'},body:await readFile(source)});
  assert.equal(upload.status,200);const uploaded=await upload.json() as any;
  const imported=await readWorkspace(file);assert.ok(imported.document.media[uploaded.assetId]);
  assert.equal(canonical(imported.document.events),canonical(ws.document.events),'Library import must not change the timeline');
  const undone=rollbackAction(imported,imported.transactions.at(-1)!.id);
  assert.equal(undone.document.media[uploaded.assetId],undefined);
  const edit=planDocumentEdit(undone.document,{kind:'set-layer',layerId:'video-1',patch:{x:12}});
  const changed=applyDocumentEdit(undone,edit),restored=rollbackAction(changed,edit.id);
  assert.equal(restored.document.scene.layers[0]!.x,ws.document.scene.layers[0]!.x);
  await writeJson(file,restored);
  const report=await(await post('/api/tools/call',{name:'read_video_analysis',args:{assetId:'source'}})).json() as any;
  assert.equal(JSON.parse(report.text).grounding.id,g.id);
  const old=await post('/api/analysis/ground',{assetId:'source',analysisId:'stale',query:'第二次',cfg});
  const staleJob=(await old.json()) as any;
  await assert.rejects(()=>wait(staleJob.id),/版本已改变/);
  const tooLong=join(dir,'long.mp4');
  await runProcess('ffmpeg',['-v','error','-f','lavfi','-i','color=black:size=32x32:rate=1:duration=16','-c:v','libx264','-pix_fmt','yuv420p',tooLong]);
  const rejected=await fetch(runtime.url+'/api/analysis/import',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Cassie-Token':initial.token},body:await readFile(tooLong)});
  assert.equal(rejected.status,400);assert.match((await rejected.json() as any).message,/15/);
  const artifact=await readFile(join(dir,'.cassie-cache','analysis',a.source.sha256,'latest.json'),'utf8');
  assert.ok(!artifact.includes(fakeKey));
  const groundArtifact=await readFile(join(dir,'.cassie-cache','analysis',a.source.sha256,'latest-grounding.json'),'utf8');assert.ok(!groundArtifact.includes(fakeKey));
  console.log('PASS: real video sampling → mock vision transport → validated observations → query re-inspection → source JPEG → durable analysis → agent readback.');
  console.log('PASS: auth, duration limit, stale analysis rejection, no caption mutation, undoable library import, ordinary edit/undo preserved; no credentials persisted.');
  if(process.env.CASSIE_TEST_EXPORT){
    const output=join(dir,'export.mp4');
    await renderVideo(restored.document,dir,output,message=>console.log('Export:',message));
    const exported=await probeVideo(output);assert.equal(exported.frames,96);assert.equal(exported.width,160);assert.equal(exported.height,120);
    console.log('PASS: existing Hyperframes export produced a decodable 96-frame MP4 after analysis and undo.');
  }
  if(process.env.CASSIE_ANALYSIS_KEEP){
    const { createServer:createVite }=await import('vite');
    process.env.CASSIE_RUNTIME=runtime.url;
    const vite=await createVite({root:new URL('../apps/web',import.meta.url).pathname,configFile:new URL('../apps/web/vite.config.ts',import.meta.url).pathname,server:{host:'127.0.0.1',port:5176,strictPort:true},logLevel:'warn'});
    await vite.listen();
    console.log('Review UI: http://127.0.0.1:5176');console.log('Review project:',file);console.log('Mock provider:',cfg.baseUrl);
    await new Promise<void>(resolve=>process.once('SIGINT',resolve));await vite.close();
  }
}finally{
  await runtime?.close();provider.closeAllConnections();if(provider.listening)await new Promise<void>(r=>provider.close(()=>r()));
  if(!process.env.CASSIE_ANALYSIS_KEEP)await rm(dir,{recursive:true,force:true});
}
