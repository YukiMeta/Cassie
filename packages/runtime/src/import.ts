import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { EventWorkspace } from '@cassie/spec';
import { EventError, frameToUs, validateWorkspace } from '@cassie/harness';
import { importVideo, runProcess, sha256 } from './media';

/** Explicit CFR conversion; original stays untouched. Pads the last video/audio sample to a whole frame. */
export async function normalizeVideo(source: string, output: string, fps = 24) {
  if (!Number.isSafeInteger(fps) || fps < 1 || fps > 120) throw new EventError('INVALID_FPS', 'Normalization fps must be 1..120');
  const original = JSON.parse(await runProcess('ffprobe', ['-v','error','-show_streams','-show_format','-of','json',source]));
  const video = original.streams?.find((s: any) => s.codec_type === 'video');
  if (!video) throw new EventError('NO_VIDEO', 'No video stream');
  const duration = Number(original.format.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new EventError('INVALID_VIDEO', 'Unreadable media duration');
  const frames = Math.ceil(duration * fps), hasAudio = original.streams.some((s: any) => s.codec_type === 'audio');
  await mkdir(dirname(resolve(output)), { recursive: true });
  const args = ['-hide_banner','-loglevel','error','-n','-i',source,'-map','0:v:0','-map','0:a:0?', '-vf',`tpad=stop_mode=clone:stop_duration=1,fps=${fps}`,'-frames:v',String(frames),'-c:v','libx264','-crf','18','-pix_fmt','yuv420p'];
  if (hasAudio) args.push('-af','apad','-c:a','aac','-b:a','192k');
  args.push('-t',String(frames/fps),'-movflags','+faststart',output);
  await runProcess('ffmpeg',args,{timeoutMs:300_000});
  return { originalSha256: await sha256(source), originalFrameRate: video.avg_frame_rate, originalDuration: duration, output:resolve(output), fps, frames, hasAudio };
}

/** Builds a real media graph. Cut addresses are authored/confirmed by the caller, never guessed as semantics. */
export async function importVideoWorkspace(source: string, target: string, options: { entity: string; instruction: string; cuts?: number[]; actionShot?: number }) : Promise<EventWorkspace> {
  const { media, info } = await importVideo(dirname(resolve(target)),resolve(source));
  const cuts = options.cuts ?? [], actionShot = options.actionShot ?? 0;
  if (cuts.some((x,i)=>!Number.isSafeInteger(x)||x<=0||x>=info.frames||(i>0&&x<=cuts[i-1]!)) || !Number.isSafeInteger(actionShot)||actionShot<0||actionShot>cuts.length) throw new EventError('INVALID_CUTS','Cuts must be ascending source frame addresses and actionShot must exist');
  const id=crypto.randomUUID(), toUs=(f:number)=>Math.round(f*1e6*info.frameRate.den/info.frameRate.num), durationUs=toUs(info.frames);
  const ws: EventWorkspace = { schema:'cassie/events@1',transactions:[],document:{
    editor:{id,name:`${options.entity} / 视频动作工程`,revision:0,settings:{fps:info.frameRate.num/info.frameRate.den,width:info.width,height:info.height,durationUs},assets:{source:{id:'source',kind:'video',name:'source.mp4',durationUs,width:info.width,height:info.height}},tracks:[{id:'video',kind:'video',name:'成片镜头',locked:false,clips:[]}]},
    semantic:{id:crypto.randomUUID(),editorProjectId:id,entities:{},relations:[],constraints:[]},frameRate:info.frameRate,media:{source:media},actions:{},events:[],scene:{background:'#111827',layers:[]}
  }};
  const d=ws.document,edges=[0,...cuts,info.frames];
  for(let i=0;i<edges.length-1;i++) {
    const start=edges[i]!,end=edges[i+1]!,frames=end-start,eventId=i===actionShot?'person-action':`shot-${i+1}`,entityId=i===actionShot?'person':`scene-${i+1}`,clipId=`clip-${i+1}`;
    d.semantic.entities[entityId]={id:entityId,name:i===actionShot?options.entity:`镜头 ${i+1}`,kind:i===actionShot?'subject':'scene',lifecycle:{enterUs:toUs(start),exitUs:toUs(end)},attributes:{sourceStartFrame:start,sourceEndFrame:end,annotation:'manual-shot-boundary'},binds:[{targetType:'clip',targetId:clipId,role:'primary'}],locked:false};
    d.editor.tracks[0]!.clips.push({id:clipId,assetId:'source',startUs:toUs(start),endUs:toUs(end),sourceInUs:toUs(start),attrs:{eventId}});
    d.events.push({id:eventId,entityId,kind:i===actionShot?'action':'reveal',label:i===actionShot?`${options.entity} · 原动作`:`镜头 ${i+1}`,start:i===0?{frame:0}:{eventId:d.events[i-1]!.id,edge:'end',offsetFrames:0},durationFrames:frames,clipId,...(i===actionShot?{action:{definitionId:'person-action',state:'original'}}:{})});
    if(i===actionShot) d.actions['person-action']={execution:'video-edit',states:{original:{label:'原视频动作',durationFrames:frames},modified:{label:options.instruction,durationFrames:frames}}};
    d.scene.layers.push({id:`video-${i+1}`,entityId,kind:'video',eventId,assetId:'source',x:0,y:0,width:info.width,height:info.height,color:'#ffffff'});
  }
  const audio = JSON.parse(await runProcess('ffprobe',['-v','error','-select_streams','a:0','-show_entries','stream=codec_type','-of','json',source]));
  if(audio.streams?.length) {
    d.media['source-audio']=media;
    d.editor.assets['source-audio']={id:'source-audio',kind:'audio',name:'原片口播与音乐',durationUs};
    d.editor.tracks.push({id:'audio',kind:'audio',name:'原片声音',locked:false,clips:[]});
    for(let i=0;i<edges.length-1;i++) {
      const start=edges[i]!,end=edges[i+1]!,clipId=`audio-${i+1}`,entityId=`voice-${i+1}`,eventId=`sound-${i+1}`,shot=d.events[i]!;
      d.editor.tracks[1]!.clips.push({id:clipId,assetId:'source-audio',startUs:toUs(start),endUs:toUs(end),sourceInUs:toUs(start),attrs:{eventId}});
      d.semantic.entities[entityId]={id:entityId,name:`原声 · 镜头 ${i+1}`,kind:'audio',lifecycle:{enterUs:toUs(start),exitUs:toUs(end)},attributes:{preserve:true},binds:[{targetType:'clip',targetId:clipId,role:'primary'}],locked:false};
      d.events.push({id:eventId,entityId,kind:'sound',label:`原声 · 镜头 ${i+1}`,start:{eventId:shot.id,edge:'start',offsetFrames:0},durationFrames:end-start,clipId});
    }
  }
  validateWorkspace(ws);return ws;
}
