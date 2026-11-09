import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { applyDocumentEdit, EventError, planDocumentEdit, resolveEvents } from '@cassie/harness';
import type { DocumentEdit, EventDocument, MediaReference } from '@cassie/spec';
import { loadAnalysis, loadGrounding } from './analyze';
import { importVideo, probeVideo, runProcess, sha256, verifiedMedia } from './media';
import { readWorkspace, updateWorkspace, writeJson } from './store';

interface RecolorScript {
  schema: 'cassie/grounded-recolor@1';
  sourceAssetId: string;
  layerId: string;
  groundingId: string;
  targetEntityId: string;
  /** Lossless grayscale video, one frame per frame of the resolved range. White selects the bottle body. */
  mask: MediaReference;
  color: string;
}

interface PreviewReceipt {
  previewId: string;
  projectId: string;
  baseRevision: number;
  script: RecolorScript;
  preview: MediaReference;
  range: { startFrame: number; endFrame: number };
  evidenceFrames: number[];
}

const error = (message: string) => new EventError('GROUNDED_RECOLOR', message);
const hash = /^[a-f0-9]{64}$/;
const color = /^#[a-f0-9]{6}$/i;
const cache = (project: string, id: string) => join(dirname(project), '.cassie-cache', 'grounded-recolors', id);

async function bind(project: string, document: EventDocument, script: RecolorScript) {
  if (script?.schema !== 'cassie/grounded-recolor@1' || !color.test(script.color) ||
      typeof script.mask?.path !== 'string' || !hash.test(script.mask?.sha256 ?? '') ||
      [script.sourceAssetId, script.layerId, script.groundingId, script.targetEntityId].some(value => typeof value !== 'string' || !value)) {
    throw error('Expected cassie/grounded-recolor@1 with a source, shot layer, grounding, target entity, hashed matte and hex color');
  }
  const analysis = await loadAnalysis(project, script.sourceAssetId);
  const grounding = await loadGrounding(project, script.sourceAssetId, analysis);
  if (!analysis || !grounding || grounding.id !== script.groundingId || grounding.status !== 'resolved' || grounding.candidates.length !== 1) {
    throw error('The current grounding must resolve exactly one target. Reinspect stale or ambiguous evidence.');
  }
  const candidate = grounding.candidates[0]!;
  if (!candidate.eventId || !candidate.entityIds.includes(script.targetEntityId) || !candidate.evidenceFrames.length) {
    throw error('The selected object must belong to an observed event with evidence');
  }
  const layer = document.scene.layers.find(item => item.id === script.layerId);
  const event = resolveEvents(document).find(item => item.id === layer?.eventId && item.active);
  const clipId = document.events.find(item => item.id === event?.id)?.clipId;
  const clip = document.editor.tracks.flatMap(track => track.clips).find(item => item.id === clipId);
  const source = document.media[script.sourceAssetId];
  if (layer?.kind !== 'video' || layer.assetId !== script.sourceAssetId || layer.groundedRecolor ||
      !event || clip?.assetId !== script.sourceAssetId || source?.sha256 !== analysis.source.sha256) {
    throw error('Target layer must be an ungraded active shot of the grounded source');
  }
  const rate = analysis.source.frameRate.num / analysis.source.frameRate.den;
  if (rate !== document.frameRate.num / document.frameRate.den) throw error('Normalize source and timeline to the same frame rate');
  const inFrame = Math.round(clip.sourceInUs * rate / 1e6);
  if (candidate.range.startFrame < inFrame || candidate.range.endFrame > inFrame + event.endFrame - event.startFrame) {
    throw error('The grounded range must fit entirely in the target shot');
  }
  return { analysis, candidate, source, layer };
}

/** Render a source-aligned preview and a lossless verification master without changing the project. */
export async function previewGroundedRecolor(projectPath: string, data: unknown) {
  const project = resolve(projectPath), root = dirname(project), script = data as RecolorScript;
  const { document } = await readWorkspace(project);
  const { analysis, candidate, source } = await bind(project, document, script);
  const [input, mask] = await Promise.all([verifiedMedia(root, source), verifiedMedia(root, script.mask)]);
  const matte = await probeVideo(mask);
  const { startFrame, endFrame } = candidate.range;
  const { width, height, frames, frameRate } = analysis.source;
  if (matte.frames !== endFrame - startFrame || matte.width !== width || matte.height !== height ||
      matte.frameRate.num / matte.frameRate.den !== frameRate.num / frameRate.den) {
    throw error('Matte must match source dimensions, frame rate and exact grounded frame count');
  }
  const stats = await runProcess('ffmpeg', ['-v', 'error', '-i', mask, '-vf', 'format=gray,signalstats,metadata=print:key=lavfi.signalstats.YMAX:file=-', '-an', '-f', 'null', '-']);
  const peaks = Array.from(stats.matchAll(/lavfi\.signalstats\.YMAX=(\d+)/g), m => Number(m[1]));
  if (peaks.length !== matte.frames || !peaks.some(peak => peak > 16)) throw error('The grounded matte has no editable pixels');

  const previewId = crypto.randomUUID(), folder = cache(project, previewId);
  const master = join(folder, 'master.mkv'), mp4 = join(folder, 'preview.mp4');
  const channels = script.color.slice(1).match(/../g)!.map(value => parseInt(value, 16));
  const lut = channels.map((value, index) => `${'rgb'[index]}='clip(${value}+(val-96)*0.55,0,255)'`).join(':');
  // Matroska and MP4 can quantize timestamps differently. Use the exact source frame index
  // on both inputs so framesync cannot duplicate a frame or shift a mask.
  const indexClock = `settb=${frameRate.den}/${frameRate.num},setpts=N`;
  const graph = `[0:v]${indexClock},format=gbrp,split[base][tone];[tone]format=gray,format=gbrp,lutrgb=${lut}[grade];` +
    `[1:v]format=gray,${indexClock},tpad=start=${startFrame}:stop=${frames-endFrame}:color=black,setpts=N,format=gbrp[matte];` +
    '[base][grade][matte]maskedmerge[out]';
  await mkdir(folder, { recursive: true });
  try {
    await runProcess('ffmpeg', ['-v', 'error', '-filter_complex_threads', '1', '-i', input, '-i', mask, '-filter_complex', graph,
      '-map', '[out]', '-map', '0:a?', '-frames:v', String(frames), '-c:v', 'ffv1', '-c:a', 'copy', master]);
    await runProcess('ffmpeg', ['-v', 'error', '-i', master, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264',
      '-crf', '15', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', mp4]);
    const output = await probeVideo(mp4);
    if (output.frames !== frames || output.width !== width || output.height !== height ||
        output.frameRate.num / output.frameRate.den !== frameRate.num / frameRate.den) throw error('Composite changed the source frame domain');
    const receipt: PreviewReceipt = {
      previewId, projectId: document.editor.id, baseRevision: document.editor.revision,
      script, range: candidate.range, evidenceFrames: candidate.evidenceFrames,
      preview: { path: relative(root, mp4), sha256: await sha256(mp4) },
    };
    await writeJson(join(folder, 'receipt.json'), receipt);
    return { ...receipt, previewPath: mp4, losslessMasterPath: master };
  } catch (cause) {
    await rm(folder, { recursive: true, force: true });
    throw cause;
  }
}

/** Commit the exact inspected preview as one transaction; ordinary rollback removes it. */
export async function applyGroundedRecolor(projectPath: string, previewId: string) {
  if (!/^[a-f0-9-]{36}$/.test(previewId)) throw error('Expected a local preview id');
  const project = resolve(projectPath), root = dirname(project), folder = cache(project, previewId);
  const receipt = JSON.parse(await readFile(join(folder, 'receipt.json'), 'utf8')) as PreviewReceipt;
  if (receipt.previewId !== previewId || receipt.preview.path !== relative(root, join(folder, 'preview.mp4'))) throw error('Invalid preview receipt');
  const next = await updateWorkspace(project, async workspace => {
    const { document } = workspace;
    if (receipt.projectId !== document.editor.id || receipt.baseRevision !== document.editor.revision) throw error('Project changed after preview. Generate a fresh preview.');
    const { analysis, candidate, source, layer } = await bind(project, document, receipt.script);
    if (candidate.range.startFrame !== receipt.range.startFrame || candidate.range.endFrame !== receipt.range.endFrame) throw error('Grounded range changed after preview');
    const [, , preview] = await Promise.all([verifiedMedia(root, source), verifiedMedia(root, receipt.script.mask), verifiedMedia(root, receipt.preview)]);
    const { media } = await importVideo(root, preview);
    if (media.sha256 !== receipt.preview.sha256) throw error('Preview media changed during commit');
    const assetId = `recolor-${previewId}`;
    const edit: DocumentEdit = {
      kind: 'apply-grounded-recolor', layerId: layer.id, media,
      asset: { ...document.editor.assets[receipt.script.sourceAssetId]!, id: assetId, name: 'Grounded recolor' },
      recolor: { assetId, sourceSha256: analysis.source.sha256, groundingId: receipt.script.groundingId,
        targetEntityId: receipt.script.targetEntityId, ...candidate.range, maskSha256: receipt.script.mask.sha256, color: receipt.script.color },
    };
    return applyDocumentEdit(workspace, planDocumentEdit(document, edit));
  });
  return { transactionId: next.transactions.at(-1)!.id, revision: next.document.editor.revision };
}
