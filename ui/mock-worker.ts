// SPDX-License-Identifier: Apache-2.0
// Wrangler-only fixture harness. Production API and auth belong to Track A.
import { createMock } from './mock-api';
import replayText from './fixtures/feed.jsonl';
const replay = replayText.trim().split('\n').map(line => JSON.parse(line)).filter(event => event.type);

// A single local DO owns fixture data and sockets, just as ProjectDO owns the real feed.
export class FixtureProject {
  private mock = createMock();
  private feedDenied = false;
  constructor(private ctx: DurableObjectState) {}
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/__mock/reset' && request.method === 'POST')
      this.feedDenied = !!(await request.clone().json() as { feedDenied?: boolean }).feedDenied;
    if (url.pathname === '/api/projects/demo/ws' && request.headers.get('Upgrade') === 'websocket') {
      if (this.feedDenied) return new Response('Sign in to open the feed', { status: 403 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === '/__mock/replay' && request.method === 'POST') {
      // Await the replay so tests know when the entire feed has reached connected clients.
      for (const event of replay) {
        await new Promise(resolve => setTimeout(resolve, 180)); this.mock.apply(event);
        for (const socket of this.ctx.getWebSockets()) socket.send(JSON.stringify(event));
      }
      return Response.json({ ok: true });
    }
    return await this.mock.handle(request) || new Response('Not found', { status: 404 });
  }
  webSocketClose(socket: WebSocket) { socket.close(1000, 'Fixture disconnected'); }
  webSocketError(socket: WebSocket) { socket.close(1011, 'Fixture socket error'); }
}
export default {
  async fetch(request: Request, env: { ASSETS: { fetch(request: Request): Promise<Response> }; FIXTURE_PROJECT: DurableObjectNamespace }) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__mock/') || (['/login', '/logout'].includes(url.pathname) && request.method === 'POST'))
      return env.FIXTURE_PROJECT.get(env.FIXTURE_PROJECT.idFromName('demo')).fetch(request);
    return env.ASSETS.fetch(request);
  }
};
