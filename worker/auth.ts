// SPDX-License-Identifier: Apache-2.0
export class HttpError extends Error {
  constructor(public status: number, public code: string, public data: Record<string, unknown> = {}) { super(code); }
}
export async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
export function randomKey(): string { return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(''); }
export function credential(request: Request): string {
  const header = request.headers.get('authorization');
  if (header) return header.startsWith('Bearer ') ? header.slice(7) : '';
  return request.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith('heddle_session='))?.slice(15) ?? '';
}
export async function operator(request: Request, token: string): Promise<boolean> {
  if (!token || !credential(request)) return false;
  const a = await digest(credential(request)), b = await digest(token); let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export function checkOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, 'origin');
}
export async function bodyText(request: Request, maxBytes = 65536): Promise<string> {
  if (!request.body) throw new HttpError(400, 'body_required');
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maxBytes) { await reader.cancel(); throw new HttpError(413, 'body_limit'); } chunks.push(value); }
  const bytes = new Uint8Array(size); let off = 0; for (const chunk of chunks) { bytes.set(chunk, off); off += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
export async function jsonBody(request: Request): Promise<Record<string, any>> {
  const raw = await bodyText(request);
  try { const body = JSON.parse(raw); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body; } catch { throw new HttpError(400, 'invalid_json'); }
}
export function slug(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(value) || value.includes('--')) throw new HttpError(400, 'invalid_slug');
  return value;
}
export function text(value: unknown, max = 16000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpError(400, 'invalid_text'); return value;
}
export function responseError(error: unknown): Response {
  if (error instanceof HttpError) return Response.json({ error: error.code, ...error.data }, { status: error.status });
  // Engine and transport exception messages can include credentials. Never forward them.
  return Response.json({ error: 'internal' }, { status: 500 });
}
