// SPDX-License-Identifier: Apache-2.0
// Wrangler-only fixture harness. Production API and auth belong to Track A.
import { createMock } from './mock-api';
import replayText from './fixtures/feed.jsonl';
const mock = createMock();
const sockets = new Set<WebSocket>();
const replay = replayText.trim().split('\n').map(line => JSON.parse(line)).filter(event => event.type);
export default {
  async fetch(request: Request, env: { ASSETS: { fetch(request: Request): Promise<Response> } }, ctx: { waitUntil(promise: Promise<unknown>): void }) {
    const url = new URL(request.url);
    if (url.pathname === '/api/projects/demo/ws' && request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair(), client = pair[0], server = pair[1];
      server.accept(); sockets.add(server); server.addEventListener('close', () => sockets.delete(server));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === '/__mock/replay' && request.method === 'POST') {
      ctx.waitUntil((async () => { for (const event of replay) { await new Promise(resolve => setTimeout(resolve, 180)); mock.apply(event); for (const socket of sockets) { try { socket.send(JSON.stringify(event)); } catch { sockets.delete(socket); } } } })());
      return Response.json({ ok: true });
    }
    return await mock.handle(request) || env.ASSETS.fetch(request);
  }
};
