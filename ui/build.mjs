// SPDX-License-Identifier: Apache-2.0
import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir(new URL('./dist', import.meta.url), { recursive: true });
await build({ entryPoints: ['src/app.tsx'], bundle: true, minify: true, legalComments: 'inline',
  banner: { js: '// SPDX-License-Identifier: Apache-2.0' }, outfile: 'dist/app.js', jsx: 'automatic', jsxImportSource: 'preact' });
for (const file of ['index.html', 'style.css', '_headers']) await copyFile(file, `dist/${file}`);
console.log('Built ui/dist: index.html, app.js, style.css, _headers');
