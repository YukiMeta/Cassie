import { readFile, access, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { applyDocumentEdit, planDocumentEdit, applyAction, planAction, resolveEvents, rollbackAction, EventError, parseWorkspace, frameToUs } from "@cassie/harness";
import type { RegionKey, DocumentEdit, ActionEdit, ActionPlan, EventWorkspace, GenerationReceipt } from "@cassie/spec";
import { readWorkspace, writeJson, updateWorkspace, renderVideo, serveWorkspace, stageScene, importVideo, createReceipt, verifyReceiptFiles, verifiedMedia, runProcess, probeVideo, normalizeVideo, importVideoWorkspace, extractSubjectMatte, verifyMatteEdit, exportSubjectCutout, bundleVideoEdit, trackRegion, importFilmWorkspace, importVideoAsFilm, planReplacement, replaceRegion, type TrackRequest } from "@cassie/runtime";

const help = `Cassie — semantic action/event workspace

  cassie init <project.json> [--template <project.json>]
  cassie edit <project.json> --edit <edit.json>
  cassie inspect <project.json>
  cassie bundle <plan.json> --project <project.json> --out <directory>
  cassie matte <project.json> --event <event-id>
  cassie cutout <project.json> --event <event-id> --out <transparent.webm>
  cassie normalize <video.mp4> --out <cfr.mp4> [--fps 24]
  cassie import <video.mp4> --out <project.json> --entity <name> --instruction <desired action> [--cuts 44,97,241] [--action-shot 0]
  cassie import-film <film.json> --out <project.json>
  cassie import-video <video.mp4> --out <project.json> [--cuts 44,97]   (shots auto-detected without --cuts)
  cassie replace-plan <project.json> --entity <id> --reference <image> --instruction <text> --out <directory>
  cassie replace <project.json> --region <id> --candidate <video.mp4> --provider-name <name> --review <note> --instruction <text> [--pad 24] [--keys candidate-keys.json]
  cassie track <project.json> --track <track.json>     (layerId, regionId, entityId, name, keys:[{sourceFrame,box:[x,y,w,h]}], look)
  cassie occurrences <project.json> --entity <entity-id>
  cassie plan <project.json> --edit <edit.json> --out <plan.json>
  cassie generate <plan.json> --provider <provider.json> --out <run.json>
  cassie accept <project.json> --plan <plan.json> --candidate <video.mp4> --provider-name <name> --review <note> --out <receipt.json>
  cassie apply <project.json> --plan <plan.json> [--receipt <receipt.json>]
  cassie rollback <project.json> --transaction <id>
  cassie scene <project.json> --out <directory>
  cassie render <project.json> --out <video.mp4>
  cassie serve <project.json> [--port 4317]

Plans never mutate projects. Video edits cannot commit without reviewed media.
init uses a procedural animation fixture; import prepares an actual video edit.
JSON results go to stdout; errors have a code and a nonzero exit status.
`;

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: Object.fromEntries(["template", "out", "entity", "instruction", "edit", "provider", "provider-name", "plan", "candidate", "review", "receipt", "transaction", "port", "fps", "cuts", "action-shot", "event", "project", "track", "entity", "reference", "region", "pad", "keys"].map(k => [k, { type: "string" as const }])) });
  const [command, input] = positionals;
  if (!command || command === "help") { process.stdout.write(help); return; }
  if (!input || positionals.length > 2) throw new EventError("ARGUMENTS", "Expected a command and one input path. Run cassie help.");
  const option = (name: keyof typeof values) => { const v = values[name]; if (!v) throw new EventError("ARGUMENTS", `Missing --${name}`); return v as string; };
  const file = resolve(input);
  const read = async <T,>(path: string): Promise<T> => JSON.parse(await readFile(resolve(path), "utf8"));
  const output = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  const absent = async (path: string) => { try { await access(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; } throw new EventError("FILE_EXISTS", `Refusing to overwrite ${path}`); };
  if (command === "init") {
    await absent(file);
    const template = values.template ? await readFile(resolve(values.template), "utf8") : await readFile(new URL("../../../examples/action-flow/project.cassie.json", import.meta.url), "utf8");
    const workspace = parseWorkspace(template);
    if (Object.keys(workspace.document.media).length) throw new EventError("TEMPLATE_MEDIA", "Media-bearing projects must be copied together with their media directory");
    await writeJson(file, workspace); output({ project: file, schema: workspace.schema }); return;
  }
  if (command === "normalize") { const target=resolve(option("out")); await absent(target); output(await normalizeVideo(file,target,Number(values.fps??24))); return; }
  if (command === "import") {
    const target=resolve(option("out"));await absent(target);
    const workspace=await importVideoWorkspace(file,target,{entity:option("entity"),instruction:option("instruction"),cuts:values.cuts?String(values.cuts).split(",").map(Number):undefined,actionShot:Number(values["action-shot"]??0)});
    await writeJson(target,workspace);output({project:target,edit:{kind:"set-action-state",eventId:"person-action",state:"modified"},events:resolveEvents(workspace.document),note:"Manually identified shot. No pixels have been regenerated."});return;
  }
  if (command === "import-film") { const target=resolve(option("out"));await absent(target);const ws=await importFilmWorkspace(file,target,m=>process.stderr.write(m+"\n"));await writeJson(target,ws);output({project:target,events:resolveEvents(ws.document)});return; }
  if (command === "import-video") { const target=resolve(option("out"));await absent(target);const ws=await importVideoAsFilm(file,target,{cuts:values.cuts?String(values.cuts).split(",").map(Number):undefined},m=>process.stderr.write(m+"\n"));await writeJson(target,ws);output({project:target,events:resolveEvents(ws.document)});return; }
  if (command === "replace-plan") { const out=resolve(option("out"));await absent(out);output(await planReplacement((await readWorkspace(file)).document,dirname(file),option("entity"),option("reference"),option("instruction"),out));return; }
  if (command === "replace") {
    const base=await readWorkspace(file),edit=await replaceRegion(base.document,dirname(file),option("region"),option("candidate"),{provider:option("provider-name"),review:option("review"),instruction:option("instruction"),pad:values.pad?Number(values.pad):undefined,keys:values.keys?await read<RegionKey[]>(values.keys):undefined});
    const ws=await updateWorkspace(file,async ws=>{if(ws.document.editor.revision!==base.document.editor.revision)throw new EventError("STALE_PLAN","Project changed; retry");return applyDocumentEdit(ws,planDocumentEdit(ws.document,edit))});
    output({revision:ws.document.editor.revision,transactionId:ws.transactions.at(-1)!.id,region:option("region"),replacement:edit.replacement});return;
  }
  if (command === "track") {
    const base=await readWorkspace(file),edit=await trackRegion(base.document,dirname(file),await read<TrackRequest>(option("track")),m=>process.stderr.write(m+"\n"));
    const ws=await updateWorkspace(file,async ws=>{if(ws.document.editor.revision!==base.document.editor.revision)throw new EventError("STALE_PLAN","Project changed while tracking; retry");return applyDocumentEdit(ws,planDocumentEdit(ws.document,edit))});
    const r=ws.document.regions![edit.region.id]!,event=resolveEvents(ws.document).find(e=>e.id===r.eventId)!;
    output({revision:ws.document.editor.revision,region:r.id,entity:r.entityId,timeline:[event.startFrame,event.endFrame],keys:r.keys.length,lowConfidenceFrames:r.confidence.filter((c,i)=>r.boxes[i]!.length&&c<0.3).length});return;
  }
  if (command === "occurrences") {
    const d=(await readWorkspace(file)).document,events=resolveEvents(d),id=option("entity"),entity=d.semantic.entities[id];
    if(!entity)throw new EventError("MISSING_ENTITY",id);
    output({entity:{id,name:entity.name},occurrences:Object.values(d.regions??{}).filter(r=>r.entityId===id).map(r=>{const e=events.find(e=>e.id===r.eventId)!,shot=d.scene.layers.find(l=>l.id===r.layerId)!;const seen=r.confidence.filter((_,i)=>r.boxes[i]!.length);return{region:r.id,shot:shot.eventId,timeline:[e.startFrame,e.endFrame],frames:seen.length,keys:r.keys.length,meanConfidence:+(seen.reduce((a,b)=>a+b,0)/Math.max(1,seen.length)).toFixed(2),look:r.look}})});return;
  }
  if (command === "matte") {
    const base=await readWorkspace(file),edit=await extractSubjectMatte(base.document,dirname(file),option("event"),m=>process.stderr.write(m+"\n"));
    const ws=await updateWorkspace(file,async ws=>{if(ws.document.editor.revision!==base.document.editor.revision)throw new EventError("STALE_PLAN","Project changed while segmenting; retry");await verifyMatteEdit(ws.document,dirname(file),edit);return applyDocumentEdit(ws,planDocumentEdit(ws.document,edit))});
    output({revision:ws.document.editor.revision,matte:edit.matte,note:"Draft person matte. Original motion is retained."});return;
  }
  if (command === "cutout") { const out=resolve(option("out"));await absent(out);output(await exportSubjectCutout((await readWorkspace(file)).document,dirname(file),option("event"),out));return; }
  if(command==="bundle"){const project=resolve(option("project")),out=resolve(option("out"));await absent(out);output(await bundleVideoEdit((await readWorkspace(project)).document,dirname(project),await read<ActionPlan>(file),out));return;}
  if (command === "generate") {
    const plan = await read<ActionPlan>(file);
    const provider = await read<{ name: string; command: string; args: string[]; capabilities: string[]; projectRoot: string }>(option("provider"));
    if (!plan.tasks?.length || !provider.name || typeof provider.command !== "string" || !Array.isArray(provider.args) || !provider.args.every(a => typeof a === "string") || !provider.capabilities?.includes("video-edit") || !provider.projectRoot)
      throw new EventError("PROVIDER_CAPABILITY", "Provider must declare video-edit, command, args and projectRoot");
    if(plan.tasks.some(t=>t.selection)&&!provider.capabilities.includes("subject-mask"))throw new EventError("PROVIDER_CAPABILITY","A selected-person edit requires a provider declaring subject-mask support");
    const out = resolve(option("out")); await absent(out);
    const run: { planId: string; status: string; jobs: Record<string, unknown>[] } = { planId: plan.id, status: "running", jobs: [] };
    await writeJson(out, run);
    try {
      for (const task of plan.tasks) {
        const sourcePath = await verifiedMedia(resolve(provider.projectRoot), task.source);
        const maskPath = task.selection ? await verifiedMedia(resolve(provider.projectRoot), task.selection.mask) : undefined;
        const job: Record<string, unknown> = { taskId: task.id, provider: provider.name, status: "running", input: task }; run.jobs.push(job); await writeJson(out, run);
        const reply = JSON.parse(await runProcess(provider.command, provider.args, { stdin: JSON.stringify({ schema: "cassie/video-edit-request@1", task, sourcePath, ...(maskPath ? { maskPath } : {}) }), timeoutMs: 900_000 }));
        if (typeof reply.outputPath !== "string") throw new EventError("PROVIDER_RESULT", "Provider must return JSON with outputPath");
        const info = await probeVideo(resolve(reply.outputPath));
        if (info.frames !== task.outputFrames || info.frameRate.num / info.frameRate.den !== task.frameRate.num / task.frameRate.den || info.width !== plan.base.editor.settings.width || info.height !== plan.base.editor.settings.height) throw new EventError("PROVIDER_RESULT", "Provider output does not match the requested canvas/frame domain");
        Object.assign(job, { status: "awaiting-review", outputPath: resolve(reply.outputPath), mediaInfo: info }); await writeJson(out, run);
      }
      run.status = "awaiting-review"; await writeJson(out, run); output(run);
    } catch (error) { run.status = "failed"; const last = run.jobs.at(-1); if (last) Object.assign(last, { status: "failed", error: (error as Error).message }); await writeJson(out, run); throw error; }
    return;
  }
  if (command === "edit") { const edit = await read<DocumentEdit>(option("edit")); const ws = await updateWorkspace(file, async ws => {if(edit.kind==="attach-subject-matte")await verifyMatteEdit(ws.document,dirname(file),edit);return applyDocumentEdit(ws, planDocumentEdit(ws.document, edit));}); output({ revision: ws.document.editor.revision, transactionId: ws.transactions.at(-1)!.id, events: resolveEvents(ws.document) }); return; }
  if (command === "inspect") { const ws = await readWorkspace(file); output({ schema: ws.schema, project: ws.document.editor, entities: ws.document.semantic.entities, events: resolveEvents(ws.document), transactions: ws.transactions.map(t => ({ id: t.id, status: t.status, journal: t.journal })) }); return; }
  if (command === "plan") { const ws = await readWorkspace(file); const plan = planAction(ws.document, await read<ActionEdit>(option("edit"))); await writeJson(option("out"), plan); output({ id: plan.id, status: plan.status, changes: plan.changes, tasks: plan.tasks }); return; }
  if (command === "accept") {
    const plan = await read<ActionPlan>(option("plan"));
    if (plan.tasks.length !== 1) throw new EventError("TASK_COUNT", "This CLI receipt command accepts one-task plans");
    const receipt = await createReceipt(file, plan, plan.tasks[0]!.id, option("candidate"), option("provider-name"), option("review"));
    await writeJson(option("out"), receipt); output(receipt); return;
  }
  if (command === "apply") {
    const plan = await read<ActionPlan>(option("plan"));
    const receipts = values.receipt ? [await read<GenerationReceipt>(values.receipt)] : [];
    const ws = await updateWorkspace(file, async ws => {
      for (const task of plan.tasks) {await verifiedMedia(dirname(file), task.source);if(task.selection)await verifiedMedia(dirname(file), task.selection.mask);}
      await verifyReceiptFiles(file, receipts);
      return applyAction(ws, plan, receipts);
    });
    output({ revision: ws.document.editor.revision, transactionId: plan.id, events: resolveEvents(ws.document) }); return;
  }
  if (command === "rollback") { const ws = await updateWorkspace(file, ws => rollbackAction(ws, option("transaction"))); output({ revision: ws.document.editor.revision, events: resolveEvents(ws.document) }); return; }
  if (command === "scene") { const ws = await readWorkspace(file); await stageScene(ws.document, dirname(file), resolve(option("out"))); output({ html: resolve(option("out"), "index.html") }); return; }
  if (command === "render") { const ws = await readWorkspace(file); await renderVideo(ws.document, dirname(file), option("out"), m => process.stderr.write(m + "\n")); output({ output: resolve(option("out")), revision: ws.document.editor.revision }); return; }
  if (command === "serve") {
    const port = values.port === undefined ? 4317 : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new EventError("PORT", "Invalid port");
    const handle = await serveWorkspace(file, port); output({ url: handle.url, project: file });
    const close = () => handle.close(); process.once("SIGINT", close); process.once("SIGTERM", close); return;
  }
  throw new EventError("COMMAND", `Unknown command: ${command}`);
}
main().catch(error => { process.stderr.write(JSON.stringify({ error: error instanceof EventError ? error.code : "FAILED", message: error.message }) + "\n"); process.exitCode = 1; });
