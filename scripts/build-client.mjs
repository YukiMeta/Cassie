import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('apps/client/dist', { recursive: true });
await build({entryPoints:['apps/client/src/main.tsx'],bundle:true,plugins:[{name:'browser-os',setup(b){b.onResolve({filter:/^os$/},()=>({path:'os',namespace:'browser-shim'}));b.onLoad({filter:/.*/,namespace:'browser-shim'},()=>({contents:'export const EOL = \"\\n\";'}));}}],format:'esm',target:'es2022',outdir:'apps/client/dist',minify:true,sourcemap:true,loader:{'.woff2':'file','.woff':'file','.svg':'file','.png':'file'},define:{'process.env.NODE_ENV':'"production"'}});
await writeFile('apps/client/dist/index.html','<!doctype html><html lang="zh-CN" class="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cassie Studio</title><link rel="stylesheet" href="/client/main.css"><div id="root"></div><script type="module" src="/client/main.js"></script></html>');
