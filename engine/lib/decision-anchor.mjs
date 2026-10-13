// SPDX-License-Identifier: Apache-2.0
// Shared request validation; tree membership is checked by the engine before any native mutation.
export class DecisionInputError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function decisionOptions(request) {
  let anchor;
  if (request.anchor !== undefined) {
    if (typeof request.anchor !== 'string' || !request.anchor || request.anchor.length > 4096)
      throw new DecisionInputError('invalid_anchor', 'Anchor must be a path or path:symbol');
    const [path, symbol, extra] = request.anchor.split(':');
    if (!path || path.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..') || extra !== undefined)
      throw new DecisionInputError('invalid_anchor', 'Anchor must use a relative file path, optionally followed by :symbol');
    if (symbol !== undefined && !/^[A-Za-z_$][A-Za-z0-9_$]*$(?![\s\S])/.test(symbol))
      throw new DecisionInputError('invalid_anchor', 'Anchor symbol must be a plain identifier');
    anchor = { path, ...(symbol === undefined ? {} : { symbol }) };
  }
  if (request.tags !== undefined && (!Array.isArray(request.tags) || request.tags.length > 8 || request.tags.some(t => typeof t !== 'string' || !/^[A-Za-z0-9_.:/-]{1,64}$(?![\s\S])/.test(t))))
    throw new DecisionInputError('invalid_tags', 'Use at most 8 tags, each 1–64 characters of A–Z, a–z, 0–9, _ . : / -');
  return anchor;
}
