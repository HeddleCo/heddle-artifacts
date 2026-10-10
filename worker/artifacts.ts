// SPDX-License-Identifier: Apache-2.0
import type { ArtifactsBinding, ArtifactsRepo, Env } from './env';
import { digest, HttpError } from './auth';
export async function forkName(project: string, task: string, agent: string): Promise<string> {
  const full = `${project}--${task}--${agent}`;
  return full.length <= 63 ? full : `${full.slice(0, 46)}-${(await digest(full)).slice(0, 16)}`;
}
export function artifacts(env: Env): ArtifactsBinding {
  if (env.DEV !== '1') { if (!env.ARTIFACTS) throw new HttpError(503, 'artifacts_unavailable'); return env.ARTIFACTS; }
  const origin = env.FAKE_ARTIFACTS_URL ?? 'http://127.0.0.1:8788';
  async function call(method: string, args: unknown[], repo?: string): Promise<any> {
    const response = await fetch(`${origin}/__binding`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, args, repo }), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new HttpError(503, 'artifacts_unavailable'); return response.json();
  }
  return {
    create: (name, opts) => call('create', [name, opts]),
    async get(name) {
      await call('get', [name]);
      return { [Symbol.dispose]() {}, info: () => call('info', [], name), fork: (n, opts) => call('fork', [n, opts], name), createToken: (scope, ttl) => call('createToken', [scope, ttl], name), revokeToken: t => call('revokeToken', [t], name), log: opts => call('log', [opts], name) } satisfies ArtifactsRepo;
    }
  };
}
export async function subscribeFork(env: Env, repo: string): Promise<string> {
  if (env.DEV === '1') return 'local-hook';
  if (!env.CF_EVENTS_API_TOKEN || !env.CF_ACCOUNT_ID || !env.EVENTS_QUEUE_ID) return 'poll-only:missing-events-config';
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/event_subscriptions/subscriptions`, {
      method: 'POST', headers: { authorization: `Bearer ${env.CF_EVENTS_API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `push-${repo}`, enabled: true, source: { type: 'artifacts.repo', namespace: env.ARTIFACTS_NAMESPACE ?? 'heddle-demo', repo_name: repo }, events: ['pushed'], destination: { type: 'queues.queue', queue_id: env.EVENTS_QUEUE_ID } }), signal: AbortSignal.timeout(10000)
    });
    const body = await r.json() as { success: boolean; result?: { id: string } };
    return r.ok && body.success ? body.result?.id ?? 'subscribed' : 'poll-only:subscription-failed';
  } catch { return 'poll-only:subscription-failed'; }
}
export function setupScript(fork: string, write: string, upstream: string, read: string): string {
  const q = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  return `#!/bin/sh\n# SPDX-License-Identifier: Apache-2.0\nset -eu\ngit -c ${q(`http.${fork}.extraHeader=Authorization: Bearer ${write}`)} clone ${q(fork)} .\ngit remote add upstream ${q(upstream)}\ngit config ${q(`http.${fork}.extraHeader`)} ${q(`Authorization: Bearer ${write}`)}\ngit config ${q(`http.${upstream}.extraHeader`)} ${q(`Authorization: Bearer ${read}`)}\n`;
}
