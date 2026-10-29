/**
 * One command: `npm start [project.cassie.json]`. Starts the runtime and the editor, prints what this machine
 * can do, and opens the browser. Without a project it opens the bundled example.
 */
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { doctor, serveWorkspace } from '@cassie/runtime';

const repo = fileURLToPath(new URL('..', import.meta.url));
const project = resolve(process.argv[2] ?? resolve(repo, 'examples/action-flow/project.cassie.json'));

const checks = await doctor();
for (const c of checks) console.log(`${c.ok ? '✓' : c.needed ? '✗' : '○'} ${c.label} — ${c.detail}${!c.ok && c.fix ? `  →  ${c.fix}` : ''}`);
if (checks.some(c => c.needed && !c.ok)) { console.error('\n缺少必需组件，按上面的修复命令装好后再启动。'); process.exit(1); }

const runtime = await serveWorkspace(project, 0);
process.env.CASSIE_RUNTIME = runtime.url;
const vite = await createServer({ configFile: resolve(repo, 'apps/web/vite.config.ts'), root: resolve(repo, 'apps/web'), logLevel: 'warn' });
await vite.listen();
const url = `${vite.resolvedUrls!.local[0]}?runtime=1`;
console.log(`\nCassie · ${project}\n${url}\n`);
if (process.platform === 'darwin') execFile('open', [url]);

const stop = async () => { await vite.close(); await runtime.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
