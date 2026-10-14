// SPDX-License-Identifier: Apache-2.0
// Request bodies and commands for the create-and-drive forms. Pure functions, so the rules are tested without a browser.
// The server stays the authority (worker/auth.ts slug(), worker/test-recipe.ts); these checks only give a clear message first.

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PROGRAMS = new Set(['npm', 'npx', 'node']);
export function validId(value: string): boolean { return ID.test(value) && !value.includes('--'); }
function id(value: string, what: string): string {
  if (!validId(value)) throw new Error(`The ${what} name must be lowercase letters, digits and single hyphens, up to 63 characters.`);
  return value;
}

/** A valid id from free text or a repository URL: "My Cool App!" → "my-cool-app", ".../Widgets.git" → "widgets". */
export function suggestId(input: string): string {
  let text = input.trim();
  try { const url = new URL(text); if (url.protocol === 'https:') text = url.pathname.split('/').filter(Boolean).pop()?.replace(/\.git$/, '') ?? ''; } catch { /* Not a URL: use the text as typed. */ }
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/, '');
}

function argv(command: string, label: string): string[] {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) throw new Error(`Enter the ${label} command.`);
  if (!PROGRAMS.has(parts[0]!)) throw new Error('Tests run with npm, npx or node only, for example: npm test');
  return parts;
}

export interface ProjectForm { id: string; source: 'repo' | 'sample'; repoUrl: string; setup: string; test: string }
export function projectBody(form: ProjectForm) {
  const project = id(form.id, 'project');
  if (form.source === 'sample') return { id: project, seed: { template: 'demo' as const } };
  let url: URL;
  try { url = new URL(form.repoUrl.trim()); } catch { throw new Error('Enter the repository address, for example https://github.com/you/your-repo'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('The repository address must be https, with no password, query or fragment.');
  const body: { id: string; seed: { importUrl: string; snapshot: true }; tests?: { setup: string[][]; test: string[] } } = { id: project, seed: { importUrl: url.href, snapshot: true } };
  const setup = form.setup.trim(), test = form.test.trim();
  if (setup && !test) throw new Error('Enter the test command that follows the setup command.');
  if (test) body.tests = { setup: setup ? [argv(setup, 'setup')] : [], test: argv(test, 'test') };
  return body;
}

export function taskBody(form: { slug: string; intent: string }) {
  const intent = form.intent.trim();
  if (!intent) throw new Error('Describe the intent: what should the agents try to do?');
  return { slug: id(form.slug, 'task'), intent };
}

export function humanBody(form: { displayName: string }) {
  const displayName = form.displayName.trim(), humanId = suggestId(displayName);
  if (!humanId) throw new Error('Enter your name: it is shown next to your decisions.');
  return { id: humanId, displayName };
}

/** What a person runs to put their own agent on a task. The operator token comes from their own environment; it is never in the text. */
export function joinCommand(input: { origin: string; project: string; task: string; agent: string }): string {
  let origin: URL;
  try { origin = new URL(input.origin); } catch { throw new Error('Unusable origin'); }
  if (origin.username || origin.password || origin.search || origin.hash || !['https:', 'http:'].includes(origin.protocol)) throw new Error('Unusable origin');
  const project = id(input.project, 'project'), task = id(input.task, 'task'), agent = id(input.agent, 'agent');
  return [
    '# In a clone of heddle-artifacts, with your operator token in the environment (never in a URL):',
    'export OPERATOR_TOKEN=…',
    `node cli/ha.mjs join ${origin.origin}/p/${project} --task ${task} --as ${agent} --dir ./${agent}`,
    `cd ${agent}`,
    '# Point your agent at this folder (Claude Code, Codex, OpenCode or plain git), then:',
    'git push origin HEAD:main',
  ].join('\n');
}
