import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ActionPlan, EventDocument } from '@cassie/spec';
import { canonical, EventError, planAction } from '@cassie/harness';
import { probeVideo, runProcess, sha256, verifiedMedia } from './media';
import { writeJson } from './store';

/** Offline handoff to a provider: materialized source shot + subject mask + exact output contract. */
export async function bundleVideoEdit(d:EventDocument, root:string, plan:ActionPlan, directory:string) {
 const fresh=planAction(d,plan.edit);
 if(canonical(d)!==canonical(plan.base)||canonical(fresh.tasks)!==canonical(plan.tasks)||canonical(fresh.changes)!==canonical(plan.changes))throw new EventError('STALE_PLAN','Bundle requires the unchanged, compiled project');
 if(!plan.tasks.length)throw new EventError('TASK_COUNT','This plan has no video editing task');
 await mkdir(directory,{recursive:false});
 const requests=[];
 for(let i=0;i<plan.tasks.length;i++){
  const task=plan.tasks[i]!,input=await verifiedMedia(root,task.source),folder=join(directory,`task-${i+1}`);await mkdir(folder);
  const fps=task.frameRate.num/task.frameRate.den,start=Math.round(task.sourceInUs*fps/1e6),frames=Math.round(task.sourceDurationUs*fps/1e6),end=start+frames;
  const videoFile=join(folder,'source.mp4');
  await runProcess('ffmpeg',['-hide_banner','-loglevel','error','-n','-i',input,'-map','0:v:0','-map','0:a:0?','-vf',`trim=start_frame=${start}:end_frame=${end},setpts=PTS-STARTPTS`,'-af',`atrim=start=${start/fps}:end=${end/fps},asetpts=PTS-STARTPTS`,'-frames:v',String(frames),'-c:v','libx264','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',videoFile],{timeoutMs:180_000});
  if((await probeVideo(videoFile)).frames!==frames)throw new EventError('BUNDLE_DOMAIN','Extracted source shot differs from its requested frame window');
  let maskFile: string|undefined;
  if(task.selection){
   const mask=await verifiedMedia(root,task.selection.mask),maskStart=start-task.selection.matte.sourceStartFrame;maskFile='mask.mp4';
   await runProcess('ffmpeg',['-hide_banner','-loglevel','error','-n','-i',mask,'-vf',`trim=start_frame=${maskStart}:end_frame=${maskStart+frames},setpts=PTS-STARTPTS`,'-frames:v',String(frames),'-an','-c:v','libx264','-qp','0','-pix_fmt','yuv420p',join(folder,maskFile)],{timeoutMs:180_000});
   if((await probeVideo(join(folder,maskFile))).frames!==frames)throw new EventError('BUNDLE_DOMAIN','Extracted mask window differs from source');
  }
  const request={schema:'cassie/video-edit-bundle@1',status:'awaiting-provider',planId:plan.id,taskId:task.id,entityId:task.entityId,eventId:task.eventId,instruction:task.instruction,requestedState:task.requestedState,
   input:{sourceFile:'source.mp4',sourceSha256:await sha256(videoFile),sourceFrames:frames,frameRate:task.frameRate,sourceWindowPrepared:true,...(maskFile?{maskFile,maskSha256:await sha256(join(folder,maskFile)),maskConvention:'white=selected-person; black=preserve',maskQuality:task.selection!.matte.quality}:{})},
   output:{frames:task.outputFrames,frameRate:task.frameRate,width:d.editor.settings.width,height:d.editor.settings.height,scope:'full-composited-shot'},preserveEntityIds:task.preserveEntityIds,review:{required:true,checks:['requested action','same person','clothing','background','burned captions and logo','lip sync and speech','frame domain']}};
  await writeJson(join(folder,'request.json'),request);requests.push(request);
 }
 await writeJson(join(directory,'manifest.json'),{schema:'cassie/video-edit-bundle-index@1',planId:plan.id,status:'awaiting-provider',tasks:requests.map((r,i)=>({taskId:r.taskId,request:`task-${i+1}/request.json`}))});
 return {directory:resolve(directory),status:'awaiting-provider',tasks:requests.length};
}
