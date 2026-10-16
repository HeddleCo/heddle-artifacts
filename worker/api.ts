// SPDX-License-Identifier: Apache-2.0
import type { Env } from './env';
import { bodyText, checkOrigin, credential, HttpError, jsonBody, operator, responseError, slug } from './auth';
import { routeEvent } from './events';
export async function fetchApi(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.pathname === '/__dev/events') {
      if (env.DEV !== '1') return new Response(null, { status: 404 });
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      await routeEvent(await jsonBody(request), env); return Response.json({ ok: true });
    }
    if (url.pathname === '/login') {
      if (request.method === 'GET') {
        // The app's own sign-in page when the UI is deployed; this bare form only for an API-only Worker.
        // Asked for by path ('/', the index), so it does not depend on the asset layer's SPA fallback rules.
        if (env.ASSETS) return env.ASSETS.fetch(new Request(new URL('/', url), { headers: request.headers }));
        const rejected = url.searchParams.get('error') === 'token' ? '<p role="alert">That operator token was not accepted. Check it and try again.</p>' : '';
        return new Response(`<!doctype html><meta name="viewport" content="width=device-width"><title>Heddle login</title>${rejected}<form method="post"><label>Operator token <input name="token" type="password" required autocomplete="current-password"></label><button>Sign in</button></form>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      checkOrigin(request); if (Number(request.headers.get('content-length') ?? 0) > 4096) throw new HttpError(413, 'body_limit');
      const body = await bodyText(request, 4096); const token = new URLSearchParams(body).get('token') ?? '';
      // A browser form post: a wrong token goes back to the sign-in page with a message, not to a JSON error body.
      if (!await operator(new Request(request.url, { headers: { authorization: `Bearer ${token}` } }), env.OPERATOR_TOKEN)) return new Response(null, { status: 303, headers: { location: '/login?error=token', 'cache-control': 'no-store' } });
      return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': `heddle_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${url.protocol === 'https:' ? '; Secure' : ''}`, 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/logout') {
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
      checkOrigin(request); if (request.body) await bodyText(request, 4096);
      return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': `heddle_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${url.protocol === 'https:' ? '; Secure' : ''}`, 'cache-control': 'no-store' } });
    }
    // One boolean for the UI: whether to offer the create forms. The session cookie is HttpOnly, so the page cannot tell.
    if (url.pathname === '/api/session') {
      if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } });
      // `demo` is the project public reads already expose (DEMO_PROJECT), so the root URL can show it without a /p/<name> path.
      return Response.json({ operator: await operator(request, env.OPERATOR_TOKEN), ...(env.DEMO_PROJECT ? { demo: env.DEMO_PROJECT } : {}) }, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/api/projects' && request.method === 'POST') {
      checkOrigin(request); if (!await operator(request, env.OPERATOR_TOKEN)) throw new HttpError(403, 'forbidden');
      const body = await jsonBody(request), id = slug(body.id);
      return env.PROJECT.getByName(id).fetch(new Request(`${url.origin}/api/projects/${id}`, { method: 'POST', headers: request.headers, body: JSON.stringify(body) }));
    }
    const match = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/.*)?$/);
    if (match) return env.PROJECT.getByName(slug(match[1])).fetch(request);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__dev/')) return new Response(null, { status: 404 });
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Heddle Artifacts control plane', { headers: { 'content-type': 'text/plain' } });
  } catch (error) { return responseError(error); }
}
