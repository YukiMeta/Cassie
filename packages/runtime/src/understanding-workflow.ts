import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import type { AnalysisSource, FrameRange, SemanticGrounding, VideoAnalysis } from '@cassie/spec';
import { EventError, applyDocumentEdit, planDocumentEdit } from '@cassie/harness';
import { analysisSource, ANALYSIS_PROMPT_VERSION, loadAnalysis, sampleImages, samplingFrames } from './analyze';
import { checkUnderstandingConfig, type UnderstandingConfig } from './analysis-model';
import { parseGrounding, parseObservation } from './analysis-validation';
import { importVideo, probeVideo, verifiedMedia } from './media';
import { readWorkspace, updateWorkspace, writeJson } from './store';

/** Native agents use local evidence + their own vision; a second paid model and a browser are optional. */
export interface EvidenceBundle {
  schema: 'cassie/evidence@1';
  id: string;
  source: AnalysisSource;
  sourcePath: string;
  range: FrameRange;
  frames: { sourceFrame: number; path: string }[];
  manifestPath: string;
}
const analysisFolder=(project:string,sha:string)=>join(dirname(resolve(project)),'.cassie-cache','analysis',sha);
const bundleFolder=(project:string,id:string)=>{
  if(!/^[a-f0-9-]{36}$/.test(id))throw new EventError('INVALID_BUNDLE','Invalid evidence bundle id');
  return join(dirname(resolve(project)),'.cassie-cache','evidence',id);
};
export async function addVideoSource(project:string, sourcePath:string) {
  if(!isAbsolute(sourcePath))throw new EventError('INVALID_PATH','Use an absolute local video path');
  const input=resolve(sourcePath),info=await probeVideo(input);
  const durationUs=Math.round(info.frames*1e6*info.frameRate.den/info.frameRate.num);
  if(durationUs>15_001_000 || !Number.isFinite(info.duration) || info.duration>15.001)throw new EventError('VIDEO_TOO_LONG','Only source videos up to 15 seconds are supported');
  const {media}=await importVideo(dirname(resolve(project)),input);
  const assetId=`analysis-${crypto.randomUUID()}`;
  const edit={kind:'attach-analysis-source' as const,asset:{id:assetId,kind:'video' as const,name:input.split(/[\\/]/).at(-1)!,durationUs,width:info.width,height:info.height},media};
  const ws=await updateWorkspace(project,ws=>applyDocumentEdit(ws,planDocumentEdit(ws.document,edit)));
  return {assetId,revision:ws.document.editor.revision,transactionId:ws.transactions.at(-1)!.id,note:'Source library only; authored timeline is unchanged.'};
}
export async function prepareVideoEvidence(project:string,assetId:string,requestedRange?:FrameRange,targetFps=2):Promise<EvidenceBundle> {
  const {source,file}=await analysisSource((await readWorkspace(project)).document,dirname(resolve(project)),assetId);
  const range=requestedRange ?? {startFrame:0,endFrame:source.frames};
  if(!Number.isSafeInteger(range.startFrame)||!Number.isSafeInteger(range.endFrame)||range.startFrame<0||range.endFrame>source.frames||range.startFrame>=range.endFrame||!Number.isFinite(targetFps)||targetFps<1||targetFps>12)throw new EventError('INVALID_RANGE','Evidence needs a bounded source-frame range and fps from 1 to 12');
  const id=crypto.randomUUID(),directory=bundleFolder(project,id);
  await mkdir(directory,{recursive:true});
  const images=await sampleImages(file,samplingFrames(source,[range],targetFps,targetFps>2?64:32));
  const frames=[];
  for(const image of images){
    const path=join(directory,`frame-${image.frame}.jpg`);
    await writeFile(path,Buffer.from(image.data,'base64'),{mode:0o600});
    frames.push({sourceFrame:image.frame,path});
  }
  const bundle:EvidenceBundle={schema:'cassie/evidence@1',id,source,sourcePath:file,range,frames,manifestPath:join(directory,'manifest.json')};
  await writeJson(bundle.manifestPath,bundle);
  return bundle;
}
async function readBundle(project:string,id:string):Promise<EvidenceBundle> {
  const bundle=JSON.parse(await readFile(join(bundleFolder(project,id),'manifest.json'),'utf8')) as EvidenceBundle;
  if(bundle.schema!=='cassie/evidence@1'||bundle.id!==id)throw new EventError('INVALID_BUNDLE','Evidence manifest does not match requested id');
  const d=(await readWorkspace(project)).document,ref=d.media[bundle.source.assetId];
  if(!ref || ref.sha256!==bundle.source.sha256)throw new EventError('STALE_ANALYSIS','Evidence source changed or was removed');
  await verifiedMedia(dirname(resolve(project)),ref);
  return bundle;
}
export async function readEvidenceFrame(project:string,bundleId:string,sourceFrame:number) {
  const bundle=await readBundle(project,bundleId);
  if(!bundle.frames.some(f=>f.sourceFrame===sourceFrame))throw new EventError('INVALID_FRAME','Frame was not prepared in this evidence bundle');
  const path=join(bundleFolder(project,bundleId),`frame-${sourceFrame}.jpg`);
  return {sourceFrame,source:bundle.source,data:(await readFile(path)).toString('base64'),mimeType:'image/jpeg' as const};
}
export async function submitVideoAnalysis(project:string,bundleId:string,observations:unknown,model='external-agent'):Promise<VideoAnalysis> {
  const bundle=await readBundle(project,bundleId);
  if(bundle.range.startFrame!==0||bundle.range.endFrame!==bundle.source.frames)throw new EventError('INCOMPLETE_EVIDENCE','A full-source evidence bundle is required for initial analysis');
  const frames=bundle.frames.map(f=>f.sourceFrame);
  const observed=parseObservation(observations,bundle.source,frames);
  const result:VideoAnalysis={schema:'cassie/analysis@1',id:crypto.randomUUID(),source:bundle.source,createdAt:new Date().toISOString(),model:String(model).slice(0,200),promptVersion:`${ANALYSIS_PROMPT_VERSION}/agent-authored`,sampling:{frameNumbers:frames,strategy:`native-agent-evidence:${bundle.id}`},status:'proposed',...observed};
  // Recheck after validation; external observations never bypass source provenance.
  await readBundle(project,bundleId);
  const dir=analysisFolder(project,bundle.source.sha256);
  await writeJson(join(dir,`${result.id}.json`),result);await writeJson(join(dir,'latest.json'),result);
  return result;
}
export async function submitVideoGrounding(project:string,bundleId:string,analysisId:string,query:string,value:unknown):Promise<SemanticGrounding> {
  if(!query.trim()||query.length>2000)throw new EventError('INVALID_QUERY','Expected a bounded original query');
  const bundle=await readBundle(project,bundleId),analysis=await loadAnalysis(project,bundle.source.assetId);
  if(!analysis||analysis.id!==analysisId)throw new EventError('STALE_ANALYSIS','Analysis changed; re-read observations before binding a target');
  const frameNumbers=bundle.frames.map(f=>f.sourceFrame),parsed=parseGrounding(value,analysis,frameNumbers);
  const result:SemanticGrounding={schema:'cassie/grounding@1',id:crypto.randomUUID(),analysisId,sourceSha256:bundle.source.sha256,query,...parsed,sampling:{frameNumbers,strategy:`native-agent-evidence:${bundle.id}`}};
  const dir=analysisFolder(project,bundle.source.sha256);
  await writeJson(join(dir,'groundings',`${result.id}.json`),result);await writeJson(join(dir,'latest-grounding.json'),result);
  return result;
}
/** Headless adapters read configuration on the host, never from browser localStorage or tool arguments. */
export async function loadUnderstandingConfig(configPath=process.env.CASSIE_UNDERSTANDING_CONFIG):Promise<UnderstandingConfig> {
  if(configPath)return checkUnderstandingConfig(JSON.parse(await readFile(resolve(configPath),'utf8')));
  return checkUnderstandingConfig({baseUrl:process.env.CASSIE_VISION_BASE_URL,model:process.env.CASSIE_VISION_MODEL,apiKey:process.env.CASSIE_VISION_API_KEY});
}
