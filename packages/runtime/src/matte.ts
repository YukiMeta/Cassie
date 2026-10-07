import { access, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DocumentEdit, EventDocument, SubjectMatte } from '@cassie/spec';
import { findClip } from '@cassie/editor-core';
import { EventError, canonical, frameToUs, resolveEvents } from '@cassie/harness';
import { importVideo, probeVideo, runProcess, sha256, verifiedMedia } from './media';

export async function nativeExecutable(root: string, name = 'person-matte') {
  if(process.platform!=='darwin') throw new EventError('MATTE_BACKEND','Apple Vision requires macOS. A portable mask can also be attached from another segmentation backend.');
  const source=fileURLToPath(new URL(`../native/${name}.swift`,import.meta.url));
  const cache=join(root,'.cassie-cache','native');await mkdir(cache,{recursive:true});
  const binary=join(cache,`${name}-${(await sha256(source)).slice(0,16)}`);
  try {await access(binary);return binary;} catch {}
  const args=['-O','-module-cache-path',join(cache,'modules'),source,'-o',binary];
  try {await runProcess('swiftc',args,{timeoutMs:180_000});return binary;} catch(first) {
    // CLT may have a newer default SDK than its compiler. Retry an installed older SDK, without changing system settings.
    const sdkRoot='/Library/Developer/CommandLineTools/SDKs';
    const sdks=(await readdir(sdkRoot).catch(()=>[])).filter(s=>/^MacOSX\d+\.\d+\.sdk$/.test(s)).sort((a,b)=>parseFloat(a.slice(6))-parseFloat(b.slice(6)));
    for(const sdk of sdks) {try{await runProcess('swiftc',['-sdk',join(sdkRoot,sdk),...args],{timeoutMs:180_000});return binary;}catch{}}
    throw first;
  }
}

/** Frame-aligned segmentation result; draft until a human inspects hair/hands/occlusions. */
export async function extractSubjectMatte(d: EventDocument, projectRoot: string, eventId: string, progress=(message:string)=>{}) : Promise<Extract<DocumentEdit,{kind:'attach-subject-matte'}>> {
  resolveEvents(d);
  const event=d.events.find(e=>e.id===eventId),entity=event&&d.semantic.entities[event.entityId];
  const clip=event?.clipId?findClip(d.editor,event.clipId)?.clip:undefined;
  if(!event||entity?.kind!=='subject'||!clip?.assetId||!d.media[clip.assetId]) throw new EventError('MATTE_TARGET','Select a subject event bound to actual video');
  if(entity.locked||findClip(d.editor,event.clipId!)!.track.locked) throw new EventError('ENTITY_LOCKED','Selected subject/track is locked');
  const source=await verifiedMedia(projectRoot,d.media[clip.assetId]!);
  const info=await probeVideo(source);
  if(info.width!==d.editor.settings.width||info.height!==d.editor.settings.height||canonical(info.frameRate)!==canonical(d.frameRate)) throw new EventError('MATTE_DOMAIN','Matting needs upright source video matching the project frame domain');
  const sourceStartFrame=Math.round(clip.sourceInUs*d.frameRate.num/(1e6*d.frameRate.den));
  const frames=Math.round((clip.endUs-clip.startUs)*d.frameRate.num/(1e6*d.frameRate.den));
  if(frames<1||sourceStartFrame+frames>info.frames) throw new EventError('MATTE_RANGE','Source window exceeds media');
  const scratch=await mkdtemp(join(resolve(projectRoot),'.cassie-matte-'));
  try {
    progress('编译本地人物分割后端…');const executable=await nativeExecutable(projectRoot);
    progress(`逐帧抠像：${frames} 帧，素材留在本机`);
    await runProcess(executable,[source,scratch,String(sourceStartFrame),String(frames)],{timeoutMs:900_000});
    const analysis=JSON.parse(await readFile(join(scratch,'analysis.json'),'utf8'));
    if(analysis.frames!==frames || analysis.boxes.every((b:any)=>b.coverage<0.01)) throw new EventError('NO_PERSON','No usable person matte was produced');
    progress('编码逐帧灰度遮罩…');
    const maskFile=join(scratch,'mask.mp4');
    await runProcess('ffmpeg',['-hide_banner','-loglevel','error','-n','-framerate',`${d.frameRate.num}/${d.frameRate.den}`,'-i',join(scratch,'%06d.png'),'-frames:v',String(frames),'-an','-c:v','libx264','-qp','0','-pix_fmt','yuv420p','-movflags','+faststart',maskFile],{timeoutMs:180_000});
    const imported=await importVideo(projectRoot,maskFile);
    if(imported.info.frames!==frames||imported.info.width!==info.width||imported.info.height!==info.height) throw new EventError('MATTE_DOMAIN','Encoded matte differs from source');
    const assetId=`matte_${imported.media.sha256.slice(0,16)}_${crypto.randomUUID().slice(0,8)}`;
    const matte: SubjectMatte={entityId:entity.id,eventId,sourceAssetId:clip.assetId,sourceSha256:d.media[clip.assetId]!.sha256,sourceStartFrame,frames,width:info.width,height:info.height,frameRate:{...d.frameRate},maskAssetId:assetId,backend:'apple-vision/person-segmentation',quality:'draft'};
    await mkdir(join(projectRoot,'analysis'),{recursive:true});
    await import('node:fs/promises').then(fs=>fs.writeFile(join(projectRoot,'analysis',`${assetId}.json`),JSON.stringify(analysis,null,2)));
    return {kind:'attach-subject-matte',eventId,matte,asset:{id:assetId,kind:'video',name:'人物灰度遮罩',width:info.width,height:info.height,durationUs:frameToUs(d,frames)},media:imported.media};
  } finally {await rm(scratch,{recursive:true,force:true});}
}

export async function verifyMatteEdit(d: EventDocument, root: string, edit: Extract<DocumentEdit,{kind:'attach-subject-matte'}>) {
  const source=d.media[edit.matte.sourceAssetId];
  if(!source||source.sha256!==edit.matte.sourceSha256) throw new EventError('MATTE_SOURCE','Matte references a different source');
  await verifiedMedia(root,source);
  const info=await probeVideo(await verifiedMedia(root,edit.media));
  if(info.frames!==edit.matte.frames||info.width!==edit.matte.width||info.height!==edit.matte.height||canonical(info.frameRate)!==canonical(edit.matte.frameRate)) throw new EventError('MATTE_DOMAIN','Mask file does not match matte metadata');
}

/** A transparent WebM preserves the original motion; it does not generate a new action or a clean background. */
export async function exportSubjectCutout(d: EventDocument, root: string, eventId: string, output: string) {
  const matte=d.subjectMattes?.[eventId];
  if(!matte) throw new EventError('MATTE_REQUIRED','Extract the subject matte first');
  const event=d.events.find(e=>e.id===eventId),clip=event?.clipId?findClip(d.editor,event.clipId)?.clip:undefined;
  if(clip?.assetId!==matte.sourceAssetId)throw new EventError('MATTE_SOURCE','Re-extract the matte after replacing the source');
  const start=Math.round(clip.sourceInUs*d.frameRate.num/(1e6*d.frameRate.den)),frames=Math.round((clip.endUs-clip.startUs)*d.frameRate.num/(1e6*d.frameRate.den));
  if(start<matte.sourceStartFrame||start+frames>matte.sourceStartFrame+matte.frames)throw new EventError('MATTE_RANGE','Re-extract this trimmed or extended source window');
  const source=await verifiedMedia(root,d.media[matte.sourceAssetId]!),mask=await verifiedMedia(root,d.media[matte.maskAssetId]!);
  await mkdir(dirname(resolve(output)),{recursive:true});
  await runProcess('ffmpeg',['-hide_banner','-loglevel','error','-n','-ss',String(clip.sourceInUs/1e6),'-i',source,'-ss',String(frameToUs(d,start-matte.sourceStartFrame)/1e6),'-i',mask,'-filter_complex','[0:v]format=rgba[fg];[fg][1:v]alphamerge[v]','-map','[v]','-frames:v',String(frames),'-an','-c:v','libvpx-vp9','-lossless','1','-pix_fmt','yuva420p','-auto-alt-ref','0',output],{timeoutMs:300_000});
  return {output:resolve(output),frames,alpha:true,motion:'original'};
}
