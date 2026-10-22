import { badRequest } from '../util.js';
import { jsonPath } from '../templating.js';

/** "200-299, 301,404" → predicate. */
export function parseStatusExpr(expr) {
  const parts = String(expr || '200-299').split(',').map((s) => s.trim()).filter(Boolean);
  const ranges = parts.map((p) => {
    const m = p.match(/^(\d{3})(?:\s*-\s*(\d{3}))?$/) || p.match(/^([1-5])xx$/i);
    if (!m) throw badRequest(`Invalid expected status "${p}" – use e.g. 200-299, 301, 2xx`);
    if (/xx$/i.test(p)) return [Number(m[1]) * 100, Number(m[1]) * 100 + 99];
    return [Number(m[1]), Number(m[2] || m[1])];
  });
  return (code) => ranges.some(([a, b]) => code >= a && code <= b);
}

/**
 * Evaluates one check response against the monitor's success rules (MON-04/06).
 * @returns {{result:'ok'|'slow'|'fail', error:string|null}}
 */
export function evaluate(res, rules, degradedMs) {
  if (!res.ok) return { result: 'fail', error: res.errorMessage || res.error || 'Request failed' };

  const statusOk = parseStatusExpr(rules.expectedStatus)(res.status);
  if (!statusOk) return { result: 'fail', error: `Unexpected status ${res.status} (expected ${rules.expectedStatus || '200-299'})` };

  if (rules.bodyContains && !res.body.includes(rules.bodyContains)) {
    return { result: 'fail', error: `Response body does not contain "${rules.bodyContains}"` };
  }

  if (rules.jsonPath) {
    let doc;
    try { doc = JSON.parse(res.body); } catch { return { result: 'fail', error: 'Response is not valid JSON' }; }
    const val = jsonPath(doc, rules.jsonPath);
    const asStr = val === undefined ? undefined : typeof val === 'object' ? JSON.stringify(val) : String(val);
    const exp = rules.jsonExpected ?? '';
    const op = rules.jsonOperator || 'equals';
    let pass;
    if (op === 'exists') pass = val !== undefined && val !== null;
    else if (op === 'contains') pass = asStr !== undefined && asStr.includes(exp);
    else if (op === 'notEquals') pass = asStr !== exp;
    else pass = asStr === exp;
    if (!pass) {
      return { result: 'fail', error: op === 'exists' ? `JSON field ${rules.jsonPath} is missing`
        : `JSON field ${rules.jsonPath} is ${asStr === undefined ? 'missing' : `"${asStr}"`}, expected ${op === 'notEquals' ? 'not ' : ''}${op === 'contains' ? 'to contain ' : ''}"${exp}"` };
    }
  }

  if (degradedMs && res.timings.total > degradedMs) {
    return { result: 'slow', error: `Response time ${Math.round(res.timings.total)} ms exceeds ${degradedMs} ms` };
  }
  return { result: 'ok', error: null };
}

/**
 * Monitor state machine (MON-05): Down only after N consecutive failures,
 * Degraded as soon as a correct-but-slow response arrives, Up on any good response.
 */
export function nextState(prevState, consecutiveFailures, result, threshold) {
  if (result === 'fail') {
    const cf = consecutiveFailures + 1;
    return { state: cf >= threshold ? 'down' : prevState, consecutiveFailures: cf };
  }
  return { state: result === 'slow' ? 'degraded' : 'up', consecutiveFailures: 0 };
}
