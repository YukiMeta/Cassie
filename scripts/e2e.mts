/**
 * Browser end-to-end check of the variant workflow on a synthetic project. Starts its own runtime
 * and Vite server on free ports, drives headless Chrome, verifies every step through the API, and
 * tears everything down. Screenshots of failures land in .e2e/.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importTake, importVideoWorkspace, readWorkspace, runProcess, serveWorkspace, writeJson, applyEdits } from '../packages/runtime/src/index';
import type { DocumentEdit, EventWorkspace } from '../packages/spec/src/index';

const homeCache = join(homedir(), '.cache', 'puppeteer');
if (existsSync(join(homeCache, 'chrome'))) process.env.PUPPETEER_CACHE_DIR = homeCache;
const { default: puppeteer } = await import('puppeteer');
const { createServer } = await import('vite');

const repo = fileURLToPath(new URL('..', import.meta.url));
const artifacts = join(repo, '.e2e');
const dir = await mkdtemp(join(tmpdir(), 'cassie-e2e-'));
const ffmpeg = (args: string[]) => runProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeoutMs: 120_000 });
const clip = (file: string, w: number, h: number, pattern: string) =>
  ffmpeg(['-f', 'lavfi', '-i', `${pattern}=size=${w}x${h}:rate=24:duration=4`, '-f', 'lavfi', '-i', 'sine=frequency=330:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);

async function fixture(): Promise<string> {
  const file = join(dir, 'project.cassie.json');
  await clip(join(dir, 'master.mp4'), 640, 360, 'testsrc2');
  let ws: EventWorkspace = await importVideoWorkspace(join(dir, 'master.mp4'), file, { entity: 'Synthetic host', instruction: 'E2E fixture' });
  const masterAssetId = Object.values(ws.document.editor.assets).find(a => a.kind === 'video')!.id;
  const edits: DocumentEdit[] = [
    { kind: 'set-variant-set', set: { masterAssetId, brief: 'Synthetic localization', keep: ['Timing'], axes: [
      { id: 'market', label: '市场', values: [{ id: 'jp', label: 'Japan', attrs: { language: '日本語' } }, { id: 'kr', label: 'Korea', attrs: { language: '한국어' } }] },
      { id: 'aspect', label: '画幅', values: [{ id: '16x9', label: '16:9', attrs: { aspect: '16x9' } }, { id: '9x16', label: '9:16', attrs: { aspect: '9x16' } }] },
    ] } },
    { kind: 'add-variants', items: ['jp', 'kr'].flatMap(m => ['16x9', '9x16'].map(a => ({ id: `${m}-${a}`, coords: { market: m, aspect: a }, review: 'pending' as const }))) },
    { kind: 'set-variable', variable: { id: 'cta', label: 'CTA', type: 'text', default: 'Book now' } },
    { kind: 'add-overlay-text', layerId: 'cta', label: 'CTA', bind: 'cta', color: '#ffffff', startFrame: 48, durationFrames: 48, box: { x: 0.25, y: 0.8, width: 0.5, height: 0.1 }, anchor: 'end' },
  ];
  for (const [id, w, h, p] of [['jp-16x9', 640, 360, 'smptebars'], ['jp-9x16', 360, 640, 'smptebars'], ['kr-16x9', 640, 360, 'rgbtestsrc'], ['kr-9x16', 360, 640, 'rgbtestsrc']] as const) {
    const src = join(dir, `${id}.mp4`);
    await clip(src, w, h, p);
    const { asset, media, take } = await importTake(dir, src);
    edits.push({ kind: 'attach-variant-take', variantId: id, take: { ...take, provider: 'synthetic' }, asset, media });
  }
  ws = applyEdits(ws, edits);
  await writeJson(file, ws);
  return file;
}

/** A stand-in subject provider: hue-shifts the take so the output is a genuinely new file. Not segmentation. */
async function fakeProvider(): Promise<string> {
  const script = join(dir, 'provider.mjs');
  await writeFile(script, `import { execFileSync } from 'node:child_process';
let s = ''; for await (const c of process.stdin) s += c;
const r = JSON.parse(s), out = r.takePath.replace(/take\\.mp4$/, 'synced.mp4');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', r.takePath, '-vf', 'hue=h=90', '-c:a', 'copy', out]);
process.stdout.write(JSON.stringify({ outputPath: out }));
`);
  const file = join(dir, 'provider.json');
  await writeJson(file, { name: 'e2e-hue-shift', command: process.execPath, args: [script], capabilities: ['subject-sync'], pricing: { perSecond: 1, unit: 'credits' } });
  return file;
}

/**
 * A scripted OpenAI-compatible model: reads the project, overrides one CTA, checks a frame, answers.
 * Records every request so the test can assert the frame really went back to the model as an image.
 */
function fakeModel() {
  const requests: { messages: { role: string; content: unknown; tool_calls?: unknown[] }[]; tools: { function: { name: string } }[] }[] = [];
  const server: Server = createHttpServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const r = JSON.parse(body);
    requests.push(r);
    const toolMsgs = r.messages.filter((m: { role: string }) => m.role === 'tool');
    const call = (name: string, args: unknown) => ({ choices: [{ message: { content: null, tool_calls: [{ id: `call_${toolMsgs.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
    let reply;
    if (toolMsgs.length === 0) reply = call('project_overview', {});
    else if (toolMsgs.length === 1) reply = call('apply_edit', { baseRevision: JSON.parse(toolMsgs[0].content).revision, edit: { kind: 'set-variant-values', variantId: 'jp-16x9', values: { cta: '今すぐ予約' } } });
    else if (toolMsgs.length === 2) reply = call('preview_frame', { variantId: 'jp-16x9', seconds: 3.5 });
    else reply = { choices: [{ message: { content: `已把日本横版的 CTA 改成「今すぐ予約」，截图确认文字完整。事务 ${JSON.parse(toolMsgs[1].content).transactionId}` } }] };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(reply));
  });
  return { server, requests };
}

/** A stand-in SAM 3 service on the servers/sam3 contract: one track covering the lower middle of every frame. */
function fakeSam3() {
  let calls = 0;
  const server: Server = createHttpServer(async (req, res) => {
    for await (const _ of req) { /* drain the upload */ }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') { res.end(JSON.stringify({ ok: true, model: 'sam3', loaded: true })); return; }
    calls++;
    const boxes = Array.from({ length: 96 }, (_, i) => ({ t: Math.round(i * 1e6 / 24), box: [200, 250, 440, 350] }));
    res.end(JSON.stringify({ candidates: [{ concept: 'product', tracks: [{ track_id: 1, score: 0.9, startUs: 0, endUs: 4e6, boxes }] }] }));
  });
  return { server, calls: () => calls };
}

const results: { name: string; ok: boolean; ms: number; error?: string }[] = [];
let runtime: Awaited<ReturnType<typeof serveWorkspace>> | undefined;
let vite: Awaited<ReturnType<typeof createServer>> | undefined;
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
const model = fakeModel();
const sam3 = fakeSam3();

try {
  const project = await fixture();
  process.env.CASSIE_SUBJECT_PROVIDER = await fakeProvider();
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=orange:size=256x256', '-frames:v', '1', join(dir, 'ref.png')]);
  await new Promise<void>(r => sam3.server.listen(0, '127.0.0.1', r));
  process.env.CASSIE_SAM3_URL = `http://127.0.0.1:${(sam3.server.address() as { port: number }).port}`;
  runtime = await serveWorkspace(project, 0);
  process.env.CASSIE_RUNTIME = runtime.url;
  vite = await createServer({ configFile: join(repo, 'apps/web/vite.config.ts'), root: join(repo, 'apps/web'), logLevel: 'error', server: { port: 5290, strictPort: false } });
  await vite.listen();
  const appUrl = vite.resolvedUrls!.local[0]!;
  browser = await puppeteer.launch({ headless: true, defaultViewport: { width: 1440, height: 900 } });
  await new Promise<void>(r => model.server.listen(0, '127.0.0.1', r));
  const modelUrl = `http://127.0.0.1:${(model.server.address() as { port: number }).port}`;
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((url: string) => {
    localStorage.setItem('cassie:model-config', JSON.stringify({ llm: { enabled: true, baseUrl: url, apiKey: 'e2e', model: 'scripted' } }));
  }, modelUrl);
  const pageErrors: string[] = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  const doc = async () => (await readWorkspace(project)).document;
  const until = async (fn: () => Promise<boolean> | boolean, what: string, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 200)); }
    throw new Error(`Timed out waiting for ${what}`);
  };
  const clickText = async (selector: string, text: string) => {
    const ok = await page.$$eval(selector, (els, t) => { const el = els.find(e => e.textContent?.trim().startsWith(t)) as HTMLElement | undefined; el?.click(); return Boolean(el); }, text);
    if (!ok) throw new Error(`No ${selector} starting with "${text}"`);
  };
  const count = (selector: string) => page.$$eval(selector, els => els.length);
  const toasts: string[] = [];
  await page.exposeFunction('__e2eToast', (t: string) => { if (t && toasts.at(-1) !== t) toasts.push(t); });
  await page.evaluateOnNewDocument(() => {
    new MutationObserver(() => {
      const t = document.querySelector('.toast')?.textContent;
      if (t) (window as unknown as { __e2eToast: (t: string) => void }).__e2eToast(t);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  const step = async (name: string, fn: () => Promise<void>) => {
    const t = Date.now();
    try { await fn(); results.push({ name, ok: true, ms: Date.now() - t }); console.log(`  ✓ ${name} (${Date.now() - t}ms)`); }
    catch (e) {
      results.push({ name, ok: false, ms: Date.now() - t, error: (e as Error).message });
      console.log(`  ✗ ${name}\n    ${(e as Error).message}${toasts.length ? `\n    last toasts: ${toasts.slice(-3).join(' | ')}` : ''}`);
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: join(artifacts, `${results.length}-${name.replace(/[^\w]+/g, '-')}.png`) as `${string}.png` }).catch(() => undefined);
    }
  };

  console.log(`Cassie e2e · ${appUrl}`);
  await step('app boots against the runtime', async () => {
    await page.goto(`${appUrl}?runtime=1`, { waitUntil: 'domcontentloaded' });
    await until(async () => (await count('.view-switch:not(.agent-panel .view-switch) button')) === 2, 'master/variant switch');
  });
  await step('variant board shows every take as a poster frame', async () => {
    await clickText('.view-switch button', '变体');
    await until(async () => (await count('.variant-cell:not(.empty)')) === 4, '4 cells');
    await until(() => page.$$eval('.vb-frame img', imgs => imgs.length === 4 && imgs.every(i => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0)), 'posters loaded');
  });
  await step('variant view keeps the agent chat in the right panel', async () => {
    await until(async () => (await count('.agent-chat')) === 1, 'agent chat');
    assert.equal(await page.$$eval('.agent-panel .view-switch button', b => (b[1] as HTMLButtonElement).disabled), true);
  });
  await step('hover mounts a playing preview, leaving removes it', async () => {
    await page.hover('.variant-cell[title^="kr-16x9"] .vb-frame');
    await until(async () => (await count('.variant-cell[title^="kr-16x9"] video')) === 1, 'preview video');
    await page.mouse.move(5, 5);
    await until(async () => (await count('.variant-cell video')) === 0, 'preview removed');
  });
  await step('variant text value overrides the master and persists', async () => {
    await page.click('.variant-cell[title^="kr-9x16"]');
    await until(async () => (await count('.vb-head .vb-coords')) === 1, 'detail');
    await clickText('.vb-tabs button', '文字');
    await page.type('.variant-var input', '지금 예약');
    await page.keyboard.press('Tab');
    await until(async () => (await doc()).variants!.items['kr-9x16']!.values?.cta === '지금 예약', 'value saved');
  });
  await step('reject needs a note; approve and undo work', async () => {
    await clickText('.vb-tabs button', '审核');
    assert.equal(await page.$$eval('.variant-actions .danger-btn', b => (b[0] as HTMLButtonElement).disabled), true);
    await page.type('.variant-detail textarea', 'Lip sync drifts at 2s');
    await clickText('.variant-actions button', '打回');
    await until(async () => (await doc()).variants!.items['kr-9x16']!.review === 'rejected', 'rejected');
    assert.equal((await doc()).variants!.items['kr-9x16']!.note, 'Lip sync drifts at 2s');
    await clickText('.variant-actions button', '通过');
    await until(async () => (await doc()).variants!.items['kr-9x16']!.review === 'approved', 'approved');
    await until(async () => (await count('.variant-cell.approved')) === 1, 'approved cell');
  });
  await step('scoped subject reference marks only the matching market stale', async () => {
    await page.click('.vb-close');
    await clickText('.vb-tabs button', '主体参考');
    await clickText('.variant-detail button', '添加参考图');
    await page.type('.subject-form input[list="subject-ids"]', 'host');
    await page.type('.subject-form input[placeholder="名称"]', '主播');
    await page.select('.subject-form select', 'market=jp');
    await page.type('.subject-form input[placeholder^="分割提示词"]', 'person on camera');
    await page.type('.subject-form input[placeholder="替换要求"]', 'Swap the host for the reference');
    const input = await page.$('.subject-form input[type=file]');
    await (input as unknown as { uploadFile: (p: string) => Promise<void> }).uploadFile(join(dir, 'ref.png'));
    await clickText('.subject-form button', '保存');
    await until(async () => Object.keys((await doc()).subjectRefs ?? {}).includes('host@market=jp'), 'reference saved');
    await until(async () => (await count('.variant-stale')) === 2, '2 stale badges');
    assert.deepEqual(await page.$$eval('.variant-cell', els => els.filter(e => e.querySelector('.variant-stale')).map(e => e.getAttribute('title')!.split(' ')[0]).sort()), ['jp-16x9', 'jp-9x16']);
  });
  await step('sync all asks first with a price; cancel spends nothing', async () => {
    await page.click('.vb-sync-all');
    await until(async () => (await count('.confirm-card')) === 1, 'confirm dialog');
    const text = await page.$eval('.confirm-card', el => (el as HTMLElement).innerText);
    assert.match(text, /2 条变体/);
    assert.match(text, /约 8 credits/);
    await clickText('.confirm-card button', '取消');
    await until(async () => (await count('.confirm-card')) === 0, 'dialog closed');
    assert.equal((await doc()).variants!.items['jp-9x16']!.take!.provider, 'synthetic');
  });
  await step('a paid sync left running across a restart is not charged again', async () => {
    const jobs = join(dirname(project), '.cassie-cache', 'sync-jobs');
    await mkdir(jobs, { recursive: true });
    await writeFile(join(jobs, 'jp-16x9.json'), JSON.stringify({ variantId: 'jp-16x9', startedAt: Date.now() }));
        try {
    const post = (url: string, body: unknown) => page.evaluate(async (u, b) => {
      const { token } = await (await fetch('/rt/api/project')).json();
      const r = await fetch('/rt' + u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cassie-Token': token }, body: JSON.stringify(b) });
      return { status: r.status, body: await r.json() };
    }, url, body);
    const r = (await post('/api/tools/call', { name: 'subject_sync', args: { confirmed: true } })).body;
    assert.ok(r.text, `tool response: ${JSON.stringify(r)}`);
    assert.deepEqual(JSON.parse(r.text).inProgress, ['jp-16x9']);
    const ui = await post('/api/subject-sync', { variantId: 'jp-16x9' });
    assert.ok(ui.status >= 400, 'UI sync endpoint refuses too');
    assert.notEqual((await doc()).variants!.items['jp-16x9']!.take!.provider, 'e2e-hue-shift');
    } finally { await rm(join(jobs, 'jp-16x9.json'), { force: true }); }
  });
  await step('confirmed sync replaces both takes and clears stale', async () => {
    const before = (await doc()).variants!.items['jp-9x16']!.take!.sha256;
    await page.click('.vb-sync-all');
    await until(async () => (await count('.confirm-card')) === 1, 'confirm dialog');
    await clickText('.confirm-card button', '开始同步');
    await until(async () => { const d = await doc(); return ['jp-16x9', 'jp-9x16'].every(id => d.variants!.items[id]!.take!.provider === 'e2e-hue-shift'); }, 'synced takes', 90_000);
    const d = await doc();
    const ref = d.subjectRefs!['host@market=jp']!;
    for (const id of ['jp-16x9', 'jp-9x16']) {
      assert.equal(d.variants!.items[id]!.take!.basis?.host, ref.sha256);
      assert.equal(d.variants!.items[id]!.review, 'pending');
    }
    assert.notEqual(d.variants!.items['jp-9x16']!.take!.sha256, before);
    assert.equal(d.variants!.items['kr-16x9']!.take!.provider, 'synthetic');
    await until(async () => (await count('.variant-stale')) === 0, 'stale cleared');
  });
  await step('variant renders to an mp4 at its own canvas with master text', async () => {
    await page.click('.variant-cell[title^="kr-9x16"]');
    await clickText('.vb-tabs button', '审核');
    await clickText('.variant-actions button', '渲染成片');
    await until(async () => (await count('a.tool-btn[href*="/output/"]')) === 1 || toasts.some(t => /fail|error|失败|错误/i.test(t)), 'download link', 180_000);
    assert.equal(await count('a.tool-btn[href*="/output/"]'), 1, `render failed: ${toasts.at(-1)}`);
    const href = await page.$eval('a.tool-btn[href*="/output/"]', a => (a as HTMLAnchorElement).href);
    const out = join(dir, 'render.mp4');
    await writeFile(out, Buffer.from(await page.evaluate(async u => Array.from(new Uint8Array(await (await fetch(u)).arrayBuffer())), href)));
    const probe = JSON.parse(await runProcess('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', out]));
    const video = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
    assert.deepEqual([video.width, video.height], [360, 640]);
    assert.ok(probe.streams.some((s: { codec_type: string }) => s.codec_type === 'audio'), 'audio track');
  });
  await step('agent edits through tools, checks a frame, and the change is undoable', async () => {
    const before = (await doc()).editor.revision;
    await page.type('.ac-compose textarea', '把日本横版的 CTA 改成日语并截图检查');
    await page.keyboard.press('Enter');
    await until(async () => (await count('.ac-reply')) === 1, 'final reply', 60_000);
    const d = await doc();
    assert.equal(d.variants!.items['jp-16x9']!.values?.cta, '今すぐ予約');
    assert.equal(d.editor.revision, before + 1);
    assert.equal(await count('.ac-step.done'), 3);
    assert.equal(await count('.ac-frame'), 1);
    const last = model.requests.at(-1)!;
    const offered = model.requests[0]!.tools.map(t => t.function.name);
    for (const t of ['apply_edit', 'select', 'check_layout', 'preview_frame']) assert.ok(offered.includes(t), `model is offered ${t}`);
    assert.ok(last.messages.some(m => m.role === 'user' && Array.isArray(m.content) && (m.content as { type: string }[]).some(c => c.type === 'image_url')), 'frame sent back to the model');
    const applied = last.messages.filter(m => m.role === 'tool')[1]!;
    const txId = JSON.parse(String(applied.content)).transactionId as string;
    assert.match(await page.$eval('.ac-reply', el => el.textContent ?? ''), new RegExp(txId));
  });
  await step('track_subject uses the SAM 3 service, and check_layout sees the CTA covering it', async () => {
    const post = (url: string, body: unknown) => page.evaluate(async (u, b) => {
      const { token } = await (await fetch('/rt/api/project')).json();
      const r = await fetch('/rt' + u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cassie-Token': token }, body: JSON.stringify(b) });
      return r.json();
    }, url, body);
    const tracked = JSON.parse((await post('/api/tools/call', { name: 'track_subject', args: { prompt: 'product', entityId: 'product', name: '产品' } })).text);
    assert.equal(tracked.detector, 'sam3');
    assert.equal(sam3.calls(), 1);
    assert.equal(tracked.shots[0].found, true);
    const region = Object.values((await doc()).regions ?? {}).find(r => r.entityId === 'product')!;
    assert.equal(region.backend, 'sam3');
    assert.equal(region.boxes.filter(b => b.length === 4).length, 96);
    const check = JSON.parse((await post('/api/tools/call', { name: 'check_layout', args: { subject: 'overlay[var=cta]', avoid: 'entity#product' } })).text);
    assert.equal(check.ok, false);
    assert.equal(check.violations[0].avoid, 'product');
    assert.ok(check.suggestions.length, 'a position that clears the product');
  });
  await step('settings shows what this machine can do', async () => {
    await clickText('button', '⚙ 模型');
    await until(async () => (await count('.doctor li')) >= 6, 'doctor rows');
    assert.match(await page.$eval('.doctor', el => el.textContent ?? ''), /SAM 3 服务/);
    await page.keyboard.press('Escape');
  });
  await step('no uncaught page errors', async () => {
    assert.deepEqual(pageErrors, []);
  });
} finally {
  await browser?.close().catch(() => undefined);
  model.server.close();
  sam3.server.close();
  await vite?.close().catch(() => undefined);
  runtime?.close();
  await rm(dir, { recursive: true, force: true });
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? ` · screenshots in ${artifacts}` : ''}`);
process.exit(failed.length ? 1 : 0);
