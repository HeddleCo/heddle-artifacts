// SPDX-License-Identifier: Apache-2.0
import { build } from 'esbuild';
import { mkdir, copyFile, readdir } from 'node:fs/promises';
await mkdir(new URL('./dist', import.meta.url), { recursive: true });
await build({ entryPoints: ['src/app.tsx'], bundle: true, minify: true, legalComments: 'inline',
  banner: { js: '// SPDX-License-Identifier: Apache-2.0' }, outfile: 'dist/app.js', jsx: 'automatic', jsxImportSource: 'preact' });
for (const file of ['index.html', 'style.css', '_headers']) await copyFile(file, `dist/${file}`);
// Self-hosted OFL fonts and their licences ship with the assets.
await mkdir(new URL('./dist/fonts', import.meta.url), { recursive: true });
for (const file of await readdir(new URL('./fonts', import.meta.url))) await copyFile(`fonts/${file}`, `dist/fonts/${file}`);
console.log('Built ui/dist: index.html, app.js, style.css, _headers, fonts/');
