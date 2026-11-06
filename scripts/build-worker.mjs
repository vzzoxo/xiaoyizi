import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import ejs from 'ejs';
import { parse } from 'acorn';
import { analyze } from 'eslint-scope';
const root = process.cwd();
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const views = walk('views').filter(f => f.endsWith('.ejs'));
// Compile at build time: Workers forbid runtime eval/new Function.
let compiled = 'const templates = {};\n';
for (const file of views) {
  const key = file.slice(6, -4);
  const options = { client: true, compileDebug: false, filename: file, _with: false };
  const preliminary = ejs.compile(fs.readFileSync(file, 'utf8'), options).toString();
  const scopes = analyze(parse('('+preliminary+')', {ecmaVersion: 2022, ranges: true}), {ecmaVersion: 2022});
  const locals = [...new Set(scopes.globalScope.through.map(r => r.identifier.name))].filter(n => !(n in globalThis));
  compiled += `templates[${JSON.stringify(key)}] = ${ejs.compile(fs.readFileSync(file, 'utf8'), { ...options, destructuredLocals: locals }).toString()};\n`;
}
compiled += `
function render(name, data) {
  const fn = templates[name];
  if (!fn) throw new Error('Unknown view: ' + name);
  return fn(data, undefined, (child, extra) => render(require('node:path').posix.normalize(require('node:path').posix.join(require('node:path').posix.dirname(name), child)).replace(/\\.ejs$/, ''), { ...data, ...extra }));
}
exports.renderFile = (file, data, cb) => { try { cb(null, render(file.split('/views/')[1].replace(/\\.ejs$/, ''), data)); } catch (e) { cb(e); } };
`;
fs.writeFileSync('workers/views.cjs', compiled);
const files = [...views, ...walk('templates'), ...walk('node-agent')];
fs.writeFileSync('workers/files.cjs', 'module.exports = '+JSON.stringify(Object.fromEntries(files.map(f => ['/tmp/xiaoyizi/'+f, fs.readFileSync(f, 'utf8')])))+';\n');
await build({
  entryPoints: ['workers/entry.mjs'], outfile: 'dist/worker.mjs', bundle: true,
  platform: 'node', format: 'esm', target: 'es2022',
  external: ['cloudflare:*', 'node:*'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire('/bundle/worker.mjs'); const __dirname = '/bundle'; const __filename = '/bundle/worker.mjs';" },
  define: { 'process.env.WORKERS_RUNTIME': '"true"' },
  plugins: [{ name: 'worker-compat', setup(b) {
    b.onResolve({filter: /^node-telegram-bot-api$/}, () => ({ path: path.join(root, 'workers/telegram.js') }));
    b.onResolve({filter: /^node-cron$/}, () => ({ path: path.join(root, 'workers/cron.js') }));
    b.onResolve({filter: /^better-sqlite3$/}, () => ({ path: path.join(root, 'workers/sqlite.js') }));
    b.onResolve({filter: /^better-sqlite3-session-store$/}, () => ({ path: path.join(root, 'workers/session-store.js') }));
    b.onResolve({filter: /^(bufferutil|utf-8-validate|cpu-features)$/}, () => ({path: 'optional-native', namespace: 'empty'}));
    b.onLoad({filter: /.*/, namespace: 'empty'}, () => ({contents: 'module.exports = {};'}));
    b.onLoad({filter: /\.js$/}, async args => {
      if (args.path.endsWith('/ssh2/lib/protocol/crypto.js')) {
        const code = await fs.promises.readFile(args.path, 'utf8');
        const patched=code.replace(/init: \(\(\) => \{[\s\S]*?\}\)\(\),/, 'init: Promise.resolve(),');
        if(patched===code) throw new Error('ssh2 initialization changed: recheck Workers crypto adapter');
        return {contents:patched.replace("binding = require('./crypto/build/Release/sshcrypto.node');", 'binding = null;'),loader:'js'};
      }
      if (args.path.endsWith('/ssh2/lib/protocol/node-fs-compat.js')) {
        const code = await fs.promises.readFile(args.path, 'utf8');
        return { contents: code.replace("new Function('return 2n ** 32n')()", '(2n ** 32n)'), loader: 'js' };
      }
      if (!args.path.startsWith(path.join(root, 'src'))) return;
      let contents = await fs.promises.readFile(args.path, 'utf8');
      contents = contents.replaceAll('__dirname', JSON.stringify('/tmp/xiaoyizi/'+path.relative(root, path.dirname(args.path))));
      return { contents, loader: 'js' };
    });
  }}],
});
