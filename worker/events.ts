// SPDX-License-Identifier: Apache-2.0
import { isMainPush } from '../contracts/events';
import type { Env } from './env';
export async function routeEvent(value: unknown, env: Env): Promise<void> {
  if (!isMainPush(value) || (value.source.namespace && value.source.namespace !== (env.ARTIFACTS_NAMESPACE ?? 'heddle-demo'))) return;
  const project = await env.PROJECT.getByName('__routing__').lookupFork(value.source.repoName);
  if (!project) return;
  await env.PROJECT.getByName(project).notePush(value.source.repoName, value.payload.ref, value.payload.after, 'event');
}
export async function queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) { try { await routeEvent(message.body, env); message.ack(); } catch { message.retry({ delaySeconds: 3 }); } }
}
