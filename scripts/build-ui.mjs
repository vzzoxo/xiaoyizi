import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';

await build({
  entryPoints: ['frontend/material.js'],
  outfile: 'public/js/material.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  legalComments: 'linked',
});

const notices = await Promise.all([
  ['Material Web', 'node_modules/@material/web/LICENSE'],
  ['Lit', 'node_modules/lit/LICENSE'],
  ['tslib', 'node_modules/tslib/LICENSE.txt'],
].map(async ([name, path]) => name + '\n\n' + await readFile(path, 'utf8')));
await writeFile('public/js/material-web-LICENSE.txt', notices.join('\n\n'));
