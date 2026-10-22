// {{NAME}} substitution in URLs, headers, bodies and auth fields (CFG-05),
// plus turning a stored request definition into concrete request options.
// Pure module (no DB access) so it can run inside load-test worker threads.

import crypto from 'node:crypto';

const DYNAMIC = {
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $timestampMs: () => String(Date.now()),
  $isoTimestamp: () => new Date().toISOString(),
  $uuid: () => crypto.randomUUID(),
  $randomInt: () => String(Math.floor(Math.random() * 1_000_000)),
};

export function interpolate(input, vars) {
  if (input == null || typeof input !== 'string' || !input.includes('{{')) return input;
  return input.replace(/\{\{\s*([$\w.-]+)\s*\}\}/g, (m, name) => {
    if (DYNAMIC[name]) return DYNAMIC[name]();
    if (vars && Object.prototype.hasOwnProperty.call(vars, name)) return String(vars[name]);
    return m;
  });
}

/** Names of {{vars}} that could not be resolved – reported to the user instead of sending them literally. */
export function unresolved(strings, vars) {
  const missing = new Set();
  for (const s of strings) {
    if (typeof s !== 'string') continue;
    for (const m of s.matchAll(/\{\{\s*([$\w.-]+)\s*\}\}/g)) {
      if (!DYNAMIC[m[1]] && !(vars && m[1] in vars)) missing.add(m[1]);
    }
  }
  return [...missing];
}

const kv = (list) => (Array.isArray(list) ? list : Object.entries(list || {}).map(([key, value]) => ({ key, value })))
  .filter((h) => h && h.key && h.enabled !== false);

/**
 * @param {object} def   { method, url, headers:[{key,value}], query:[{key,value}], body, bodyType }
 * @param {object} auth  { type: none|bearer|basic|apiKey, token, username, password, key, value, in }
 * @param {object} vars
 * @returns {{method:string,url:string,headers:object,body:string|null, missing:string[]}}
 */
export function buildRequest(def, auth = {}, vars = {}) {
  const I = (s) => interpolate(s, vars);
  const strings = [def.url, def.body, ...kv(def.headers).flatMap((h) => [h.key, h.value]),
    ...kv(def.query).flatMap((q) => [q.key, q.value]), auth?.token, auth?.username, auth?.password, auth?.value];
  const missing = unresolved(strings, vars);

  let url;
  try {
    url = new URL(I(def.url || '').trim());
    for (const q of kv(def.query)) url.searchParams.append(I(q.key), I(q.value ?? ''));
  } catch {
    return { method: def.method || 'GET', url: I(def.url || ''), headers: {}, body: null, missing, invalidUrl: true };
  }

  const headers = {};
  for (const h of kv(def.headers)) headers[I(h.key).toLowerCase()] = I(h.value ?? '');

  switch (auth?.type) {
    case 'bearer': if (auth.token) headers.authorization = `Bearer ${I(auth.token)}`; break;
    case 'basic': headers.authorization = 'Basic ' + Buffer.from(`${I(auth.username || '')}:${I(auth.password || '')}`).toString('base64'); break;
    case 'apiKey':
      if (auth.key) {
        if (auth.in === 'query') url.searchParams.set(I(auth.key), I(auth.value || ''));
        else headers[I(auth.key).toLowerCase()] = I(auth.value || '');
      }
      break;
    default: break;
  }

  let body = null;
  const method = (def.method || 'GET').toUpperCase();
  if (def.bodyType && def.bodyType !== 'none' && def.body != null && def.body !== '' && !['GET', 'HEAD'].includes(method)) {
    body = I(def.body);
    if (!headers['content-type']) {
      headers['content-type'] = def.bodyType === 'json' ? 'application/json'
        : def.bodyType === 'form' ? 'application/x-www-form-urlencoded' : 'text/plain';
    }
  }
  return { method, url: url.toString(), headers, body, missing };
}

/** Reads a value from a JSON document with a simple path: "data.items[0].id" or "$.data.id". */
export function jsonPath(obj, path) {
  if (!path) return obj;
  const parts = String(path).replace(/^\$\.?/, '').match(/[^.[\]]+/g) || [];
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}
