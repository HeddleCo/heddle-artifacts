// SPDX-License-Identifier: Apache-2.0
// Deterministic handler/effect harness, not a DOM or browser substitute.
// Bundle the actual components with controlled hooks so same-turn events and deferred responses
// can be exercised without a browser, network, credentials, or additional dependencies.
import { build } from 'esbuild';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export async function components() {
  const temp = await mkdtemp(join(tmpdir(), 'heddle-handlers-'));
  const entry = fileURLToPath(new URL('../../src/app.tsx', import.meta.url));
  await build({ entryPoints: [entry], outfile: join(temp, 'app.mjs'), bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', jsxImportSource: 'preact', plugins: [{
    name: 'controlled-component-hooks', setup(b) {
      b.onResolve({ filter: /^preact\/hooks$/ }, () => ({ path: 'hooks', namespace: 'harness' }));
      b.onLoad({ filter: /.*/, namespace: 'harness' }, () => ({ contents: 'export const useState = (...a) => globalThis.__componentHooks.state(...a); export const useRef = (...a) => globalThis.__componentHooks.ref(...a); export const useEffect = (...a) => globalThis.__componentHooks.effect(...a);' }));
      b.onLoad({ filter: /\/src\/app\.tsx$/ }, async () => ({ contents: (await readFile(entry, 'utf8')).replace("render(<App/>, document.getElementById('app')!);", 'export { Board, Compare, Discussion, Why };'), loader: 'tsx' }));
    }
  }] });
  return { ...(await import(pathToFileURL(join(temp, 'app.mjs')))), cleanup: () => rm(temp, { recursive: true, force: true }) };
}
export function mount(Component, props) {
  const slots = []; let cursor = 0, pending = [];
  const api = {
    tree: undefined,
    state(initial) { const i = cursor++; slots[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, value => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; }]; },
    ref(value) { const i = cursor++; slots[i] ??= { value: { current: value } }; return slots[i].value; },
    effect(callback, dependencies) { const i = cursor++, previous = slots[i]; if (!previous || dependencies.some((value, j) => !Object.is(value, previous.dependencies[j]))) { pending.push(() => { previous?.cleanup?.(); slots[i] = { dependencies, cleanup: callback() }; }); } },
    render(nextProps = props) { props = nextProps; cursor = 0; globalThis.__componentHooks = api; api.tree = Component(props); const effects = pending; pending = []; effects.forEach(run => run()); return api.tree; },
    unmount() { for (const slot of slots) slot?.cleanup?.(); }
  };
  api.render(); return api;
}
export function nodes(tree, predicate) {
  const found = [];
  const visit = value => { if (Array.isArray(value)) return value.forEach(visit); if (!value || typeof value !== 'object') return; if (predicate(value)) found.push(value); visit(value.props?.children); };
  visit(tree); return found;
}
export const one = (root, predicate) => { const found = nodes(root.tree, predicate); if (found.length !== 1) throw new Error(`Expected one matching node, got ${found.length}`); return found[0]; };
export const textOf = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(textOf).join('') : node && typeof node === 'object' ? textOf(node.props?.children) : '';
export const button = (root, name) => one(root, node => node.type === 'button' && textOf(node) === name);
export const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
export async function flush(root) { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise(resolve => setImmediate(resolve)); root?.render(); }
export const submitEvent = () => ({ preventDefault() {} });
export class FakeSocket {
  static all = [];
  constructor(url) { this.url = url; FakeSocket.all.push(this); }
  open() { this.onopen?.({}); }
  emit(event) { this.onmessage?.({ data: JSON.stringify(event) }); }
  close() { this.closed = true; }
  disconnect() { this.onclose?.({}); }
  error() { this.onerror?.({}); }
}
