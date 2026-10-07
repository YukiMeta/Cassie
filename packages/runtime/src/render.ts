import { copyFile, mkdir, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createRenderJob, executeRenderJob } from "@hyperframes/producer";
import { resolveEvents, resolveFrameCount, EventError } from "@cassie/harness";
import type { EventDocument } from "@cassie/spec";
import { verifiedMedia } from "./media";

export const fontPath = (weight: 400 | 600) => fileURLToPath(import.meta.resolve(`@fontsource/inter/files/inter-latin-${weight}-normal.woff2`));

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

/** Per-region data the page needs to place a source-frame box at any timeline frame. */
export function regionTracks(d: EventDocument) {
  return Object.values(d.regions ?? {}).map(r => {
    const layer = d.scene.layers.find(l => l.id === r.layerId)!, shot = d.events.find(e => e.id === layer.eventId)!;
    const clip = d.editor.tracks.flatMap(t => t.clips).find(c => c.id === shot.clipId)!, asset = d.editor.assets[r.sourceAssetId]!;
    const sx = layer.width / (layer.crop?.width ?? asset.width ?? layer.width), sy = layer.height / (layer.crop?.height ?? asset.height ?? layer.height);
    return { id: r.id, eventId: r.eventId, shotEventId: shot.id, clipStartFrame: Math.round(clip.sourceInUs * d.frameRate.num / (1e6 * d.frameRate.den)), sourceStartFrame: r.sourceStartFrame, boxes: r.boxes, sx, sy, pad: r.replacement?.pad ?? 0, align: r.replacement?.align ?? null, width: asset.width ?? layer.width, height: asset.height ?? layer.height };
  });
}

/** Pure compiler used by preview and render; no network, timers, randomness or model calls. */
export function compileScene(d: EventDocument, assetUrls: Record<string, string> = {}, matteEventId?: string): string {
  const events = resolveEvents(d);
  const matte=matteEventId?d.subjectMattes?.[matteEventId]:undefined;
  const matteEvent=matteEventId?d.events.find(e=>e.id===matteEventId):undefined;
  const matteClip=matteEvent?.clipId?d.editor.tracks.flatMap(t=>t.clips).find(c=>c.id===matteEvent.clipId):undefined;
  if(matteEventId&&(!matte||matteClip?.assetId!==matte.sourceAssetId))throw new EventError("MATTE_REQUIRED","No current-source matte for this event");
  if(matte&&matteClip){const start=Math.round(matteClip.sourceInUs*(d.frameRate.num/d.frameRate.den)/1e6),frames=Math.round((matteClip.endUs-matteClip.startUs)*(d.frameRate.num/d.frameRate.den)/1e6);if(start<matte.sourceStartFrame||start+frames>matte.sourceStartFrame+matte.frames)throw new EventError("MATTE_RANGE","Re-extract this trimmed or extended source window");}
  const { width, height } = d.editor.settings;
  const fps = d.frameRate.num / d.frameRate.den;
  const frameCount = resolveFrameCount(d, events);
  const layers = d.scene.layers.map((layer, i) => {
    const event = events.find(e => e.id === layer.eventId);
    const authored = d.events.find(e => e.id === layer.eventId);
    const clip = authored?.clipId ? d.editor.tracks.flatMap(t => t.clips).find(c => c.id === authored.clipId) : undefined;
    const fill = escape(layer.color);
    let content = "";
    if (layer.kind === "person") content = `<svg viewBox="0 0 240 330" width="100%" height="100%"><ellipse cx="120" cy="316" rx="72" ry="9" fill="#000" opacity=".2"/><path d="M96 210L85 304M143 210L158 304" stroke="#59668b" stroke-width="29" stroke-linecap="round"/><path d="M77 315h29M144 315h32" stroke="#dce6f7" stroke-width="13" stroke-linecap="round"/><path d="M100 101Q66 123 63 188" fill="none" stroke="${fill}" stroke-width="25" stroke-linecap="round"/><path d="M87 99Q119 85 153 99L155 220Q121 232 82 220Z" fill="${fill}"/><g id="arm-${i}" transform="rotate(-25 145 117)"><path d="M145 117L163 172" stroke="${fill}" stroke-width="24" stroke-linecap="round"/><g id="forearm-${i}"><path d="M163 172L177 222" stroke="#dfb8a0" stroke-width="17" stroke-linecap="round"/><circle cx="177" cy="224" r="11" fill="#dfb8a0"/></g></g><rect x="110" y="69" width="25" height="32" rx="10" fill="#dfb8a0"/><ellipse cx="122" cy="49" rx="36" ry="42" fill="#e9c5ae"/><path d="M85 49Q74 0 117 4Q163 -5 161 53L149 33Q112 38 96 23L94 58Z" fill="#303246"/><circle cx="111" cy="49" r="2.7" fill="#303246"/><circle cx="137" cy="49" r="2.7" fill="#303246"/><path d="M116 68Q125 74 133 66" fill="none" stroke="#916755" stroke-width="2.5" stroke-linecap="round"/></svg>`;
    if (layer.kind === "card") content = `<div style="width:100%;height:100%;border:1px solid ${fill};border-radius:24px;background:linear-gradient(145deg,${fill}33,#172033);display:flex;align-items:center;justify-content:center;flex-direction:column;box-shadow:0 25px 60px #0005"><div style="width:60px;height:105px;border-radius:14px;background:${fill};box-shadow:inset -14px -8px 0 #0002;transform:rotate(-8deg)"></div><span style="margin-top:22px;letter-spacing:6px;color:${fill};font-size:18px">${escape(layer.text ?? "")}</span></div>`;
    if (layer.kind === "text") content = `<div style="font-size:${Math.max(12, layer.height * .65)}px;font-weight:650;letter-spacing:2px;line-height:1.2;color:${fill}">${escape(event?.text ?? layer.text ?? "")}</div>`;
    if (layer.kind === "video") {
      const src = layer.assetId ? assetUrls[layer.assetId] : undefined;
      if (!src) throw new EventError("MISSING_MEDIA", `No staged media URL for ${layer.id}`);
      const asset = d.editor.assets[layer.assetId!], c = layer.crop;
      const sw = asset?.width ?? layer.width, sh = asset?.height ?? layer.height;
      const sx = layer.width / (c?.width ?? sw), sy = layer.height / (c?.height ?? sh);
      const media = `position:absolute;left:${-(c?.x ?? 0) * sx}px;top:${-(c?.y ?? 0) * sy}px;width:${sw * sx}px;height:${sh * sy}px;`;
      const regions = Object.values(d.regions ?? {}).filter(r => r.layerId === layer.id).map(r => {
        if (!r.replacement) return `<div id="region-${escape(r.id)}" data-cassie-region="${escape(r.id)}" style="position:absolute;visibility:hidden;background:${escape(r.look.color)};mix-blend-mode:color;opacity:${r.look.tint};filter:blur(${r.look.feather * sx}px);pointer-events:none"></div>`;
        const rep = assetUrls[r.replacement.assetId];
        if (!rep) throw new EventError("MISSING_MEDIA", `No staged media URL for replacement of ${r.id}`);
        const f = r.look.feather * sx, ramp = (dir: string) => `linear-gradient(${dir},transparent,#000 ${f}px,#000 calc(100% - ${f}px),transparent)`;
        return `<div id="region-${escape(r.id)}" data-cassie-region="${escape(r.id)}" style="position:absolute;visibility:hidden;overflow:hidden;pointer-events:none;-webkit-mask-image:${ramp("to right")},${ramp("to bottom")};-webkit-mask-composite:source-in;mask-composite:intersect"><video id="region-video-${escape(r.id)}" src="${escape(rep)}" muted playsinline preload="auto" data-start="${(event?.startFrame ?? 0) / fps}" data-duration="${((event?.endFrame ?? frameCount) - (event?.startFrame ?? 0)) / fps}" data-media-start="0" style="position:absolute;width:${(r.replacement.align ? r.replacement.align.width * r.replacement.align.scale : sw) * sx}px;height:${(r.replacement.align ? r.replacement.align.height * r.replacement.align.scale : sh) * sy}px;object-fit:fill"></video></div>`;
      }).join("");
      const tint = layer.tint ? `<div style="position:absolute;inset:0;background:${fill};mix-blend-mode:color;opacity:${layer.tint};pointer-events:none"></div>` : "";
      content = `<div style="position:absolute;inset:0;overflow:hidden;isolation:isolate"><div style="${media}"><video id="video-${i}" src="${escape(src)}" muted playsinline preload="auto" data-start="${(event?.startFrame ?? 0) / fps}" data-duration="${((event?.endFrame ?? frameCount) - (event?.startFrame ?? 0)) / fps}" data-media-start="${(clip?.sourceInUs ?? 0) / 1e6}" style="width:100%;height:100%;object-fit:fill;${matte&&layer.eventId===matteEventId?'display:none;':''}"></video>${matte&&layer.eventId===matteEventId?`<canvas id="foreground" width="${width}" height="${height}" style="width:100%;height:100%"></canvas>`:''}${regions}</div>${tint}</div>`;
    }
    return `<div id="layer-${i}" data-hf-id="${escape(layer.id)}" data-cassie-layer-id="${escape(layer.id)}" style="position:absolute;rotate:${layer.rotation ?? 0}deg;left:${layer.x}px;top:${layer.y}px;width:${layer.width}px;height:${layer.height}px;transform-origin:center;">${content}</div>`;
  }).join("");
  const maskTime=matte?events.find(e=>e.id===matteEventId):undefined;
  const maskVideo=matte?`<video id="subject-mask" src="${escape(assetUrls[matte.maskAssetId]!)}" muted playsinline preload="auto" data-start="${maskTime!.startFrame/fps}" data-duration="${(maskTime!.endFrame-maskTime!.startFrame)/fps}" data-media-start="${(matteClip!.sourceInUs/1e6)-matte.sourceStartFrame/fps}" style="display:none"></video>`:'';
  const audio = d.editor.tracks.filter(t => t.kind === "audio").flatMap(t => t.clips).filter(c => c.attrs.eventActive !== false).map(clip => {
    const src = clip.assetId ? assetUrls[clip.assetId] : undefined;
    if (!src) throw new EventError("MISSING_MEDIA", `Missing audio asset for ${clip.id}`);
    return `<audio src="${escape(src)}" data-start="${clip.startUs / 1e6}" data-duration="${(clip.endUs - clip.startUs) / 1e6}" data-media-start="${clip.sourceInUs / 1e6}"></audio>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(d.editor.name)}</title><style>@font-face{font-family:Inter;src:url('font-400.woff2') format('woff2');font-weight:400}@font-face{font-family:Inter;src:url('font-600.woff2') format('woff2');font-weight:600}html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:${matte?'#18202a':d.scene.background};${matte?'background-image:conic-gradient(#27303c 25%,#18202a 0 50%,#27303c 0 75%,#18202a 0);background-size:48px 48px;':''}font-family:Inter,sans-serif;font-synthesis:none}*{box-sizing:border-box}#world{position:absolute;inset:0;transform-origin:50% 50%}</style></head><body><div id="composition" data-composition-id="cassie" data-composition-file="index.html" data-no-timeline data-width="${width}" data-height="${height}" data-duration="${frameCount / fps}" data-fps="${d.frameRate.num}/${d.frameRate.den}" style="width:${width}px;height:${height}px;position:relative;overflow:hidden"><div id="world">${layers}</div>${audio}${maskVideo}</div><script>
(() => {
 const data=${json({ events, authored: d.events, actions: d.actions, layers: d.scene.layers, fps, frameCount, matteEventId, regions: regionTracks(d) })};
 const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
 const sample=(keys,p,fallback)=>{if(!keys)return fallback;for(let i=1;i<keys.length;i++){if(p<=keys[i].at){const a=keys[i-1],b=keys[i],t=clamp((p-a.at)/(b.at-a.at),0,1);return a.value+(b.value-a.value)*t}}return keys[keys.length-1].value};
 function render(time){
  const frame=clamp(time*data.fps,0,data.frameCount);
  let zoom=1;
  for(const e of data.events)if(e.kind==='camera'&&e.active){const p=clamp((frame-e.startFrame)/(e.endFrame-e.startFrame),0,1);zoom*=1+.06*p;}
  document.getElementById('world').style.transform='scale('+zoom+')';
  data.layers.forEach((layer,i)=>{
   const e=data.events.find(e=>e.id===layer.eventId), authored=data.authored.find(e=>e.id===layer.eventId);
   const el=document.getElementById('layer-'+i);
   const isAction=e&&e.kind==='action'&&layer.kind!=='video';
   el.style.visibility=(!data.matteEventId||layer.eventId===data.matteEventId)&&(!e||(e.active&&(isAction||frame>=e.startFrame&&frame<e.endFrame)))?'visible':'hidden';
   const p=e?clamp((frame-e.startFrame)/(e.endFrame-e.startFrame),0,1):0;
   const motion=authored&&authored.action?data.actions[authored.action.definitionId].states[authored.action.state].motion:{};
   const x=sample(motion&&motion.x,p,0),y=sample(motion&&motion.y,p,0),r=sample(motion&&motion.rotation,p,0),scale=sample(motion&&motion.scale,p,1);
   const appear=e&&!isAction&&layer.kind!=='video'?clamp((frame-e.startFrame)/10,0,1):1;
   el.style.transform='translate('+x+'px,'+(y+(1-appear)*16)+'px) rotate('+r+'deg) scale('+scale+')';
   el.style.opacity=sample(motion&&motion.opacity,p,1)*appear;
   const arm=document.getElementById('arm-'+i),forearm=document.getElementById('forearm-'+i);
   if(arm)arm.setAttribute('transform','rotate('+sample(motion&&motion.armAngle,p,-25)+' 145 117)');
   if(forearm)forearm.setAttribute('transform','rotate('+sample(motion&&motion.forearmAngle,p,0)+' 163 172)');
  });
  for(const r of data.regions){
   const el=document.getElementById('region-'+r.id),shot=data.events.find(e=>e.id===r.shotEventId),own=data.events.find(e=>e.id===r.eventId);
   const f=Math.floor(frame),box=shot?r.boxes[r.clipStartFrame+(f-shot.startFrame)-r.sourceStartFrame]:undefined;
   const on=el&&own&&own.active&&f>=own.startFrame&&f<own.endFrame&&box&&box.length===4;
   if(!el)continue;el.style.visibility=on?'visible':'hidden';
   if(on){
    let u=box,vx=0,vy=0;
    if(r.align){
     const a=r.align,cb=a.boxes[Math.min(a.boxes.length-1,Math.max(0,Math.round((f-shot.startFrame)/data.fps*a.fps)))];
     if(!cb||cb.length!==4){el.style.visibility='hidden';continue}
     const cx=box[0]+box[2]/2,cy=box[1]+box[3]/2,mw=cb[2]*a.scale,mh=cb[3]*a.scale;
     vx=cx-(cb[0]+cb[2]/2)*a.scale;vy=cy-(cb[1]+cb[3]/2)*a.scale;
     const l=Math.min(box[0],cx-mw/2),t=Math.min(box[1],cy-mh/2);u=[l,t,Math.max(box[0]+box[2],cx+mw/2)-l,Math.max(box[1]+box[3],cy+mh/2)-t];
    }
    const x=Math.max(0,u[0]-r.pad),y=Math.max(0,u[1]-r.pad),w=Math.min(r.width,u[0]+u[2]+r.pad)-x,h=Math.min(r.height,u[1]+u[3]+r.pad)-y;
    el.style.left=x*r.sx+'px';el.style.top=y*r.sy+'px';el.style.width=w*r.sx+'px';el.style.height=h*r.sy+'px';
    const v=document.getElementById('region-video-'+r.id);if(v){v.style.left=(vx-x)*r.sx+'px';v.style.top=(vy-y)*r.sy+'px'}
   }
  }
 }
 async function previewSeek(time){
  render(time);
  await Promise.all(Array.from(document.querySelectorAll('video')).map(video=>new Promise((resolve,reject)=>{
   const t=clamp(time-Number(video.dataset.start),0,Math.max(0,Number(video.dataset.duration)-1/data.fps))+Number(video.dataset.mediaStart);
   if(video.readyState>=2&&Math.abs(video.currentTime-t)<.00001)return resolve();
   const timer=setTimeout(()=>{cleanup();reject(new Error('Video seek timed out'))},10000);
   const cleanup=()=>{clearTimeout(timer);video.removeEventListener('seeked',done);video.removeEventListener('error',fail)};
   const done=()=>{cleanup();resolve()},fail=()=>{cleanup();reject(new Error('Media failed'))};
   video.addEventListener('seeked',done);video.addEventListener('error',fail);video.currentTime=t;
  })));
  if(data.matteEventId){
   const canvas=document.getElementById('foreground'),mask=document.getElementById('subject-mask');
   const index=data.layers.findIndex(l=>l.eventId===data.matteEventId),source=document.getElementById('video-'+index);
   if(canvas&&source&&mask&&source.readyState>=2&&mask.readyState>=2){
    const alpha=document.createElement('canvas');alpha.width=canvas.width;alpha.height=canvas.height;
    const ac=alpha.getContext('2d',{willReadFrequently:true});ac.drawImage(mask,0,0,alpha.width,alpha.height);
    const pixels=ac.getImageData(0,0,alpha.width,alpha.height);
    for(let i=0;i<pixels.data.length;i+=4){pixels.data[i+3]=pixels.data[i];pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=255}ac.putImageData(pixels,0,0);
    const ctx=canvas.getContext('2d');ctx.globalCompositeOperation='source-over';ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(source,0,0,canvas.width,canvas.height);ctx.globalCompositeOperation='destination-in';ctx.drawImage(alpha,0,0);ctx.globalCompositeOperation='source-over';
   }
  }
 }
 window.cassieSeek=previewSeek;
 window.addEventListener('hf-seek',e=>render(e.detail.time));
 window.addEventListener('message',e=>{if(e.source===parent&&e.data&&e.data.type==='cassie:seek')previewSeek(e.data.time).catch(err=>parent.postMessage({type:'cassie:error',message:err.message},'*'))});
 if(!window.__hf)window.__hf={duration:${frameCount / fps},seek:previewSeek};
 render(0);
})();</script></body></html>`;
}

export async function stageScene(d: EventDocument, projectRoot: string, outputDir: string): Promise<string> {
  resolveEvents(d);
  await mkdir(join(outputDir, "media"), { recursive: true });
  await copyFile(fontPath(400), join(outputDir, "font-400.woff2"));
  await copyFile(fontPath(600), join(outputDir, "font-600.woff2"));
  await copyFile(fileURLToPath(import.meta.resolve("@fontsource/inter/LICENSE")), join(outputDir, "FONT-LICENSE.txt"));
  const urls: Record<string, string> = {};
  for (const [id, ref] of Object.entries(d.media)) {
    const source = await verifiedMedia(projectRoot, ref);
    const name = `${ref.sha256}${source.match(/\.[a-z0-9]+$/i)?.[0] ?? ".mp4"}`;
    await copyFile(source, join(outputDir, "media", name));
    urls[id] = `media/${name}`;
  }
  const html = compileScene(d, urls);
  await writeFile(join(outputDir, "index.html"), html);
  return html;
}

export async function renderVideo(d: EventDocument, projectRoot: string, output: string, onProgress: (message: string) => void = () => {}, signal?: AbortSignal): Promise<void> {
  const destination = resolve(output);
  const stage = join(dirname(destination), `.cassie-render-${crypto.randomUUID()}`);
  await stageScene(d, projectRoot, stage);
  const job = createRenderJob({ fps: d.frameRate, quality: "standard", format: "mp4", workers: 1, useGpu: false, strictness: "strict" });
  // Keeping the staged HTML alongside output makes failed renders inspectable and reproducible.
  await executeRenderJob(job, stage, destination, (_job, message) => onProgress(message), signal);
  if (job.status !== "complete") throw new EventError("RENDER_FAILED", `Render ended as ${job.status}`);
  await writeFile(`${destination}.manifest.json`, JSON.stringify({ projectId: d.editor.id, revision: d.editor.revision, frameRate: d.frameRate, renderer: "@hyperframes/producer@0.8.128", stage, events: resolveEvents(d) }, null, 2));
}
