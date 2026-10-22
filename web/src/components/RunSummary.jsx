import { CheckCircle2, AlertTriangle, XCircle, Info, Copy, Lightbulb, ArrowDown } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useToast } from './ui.jsx';
import { insightsToText } from '../insights.js';
import { ms, num, pct } from '../format.js';

const ICON = { good: CheckCircle2, ok: CheckCircle2, info: Info, warn: AlertTriangle, bad: XCircle };
const COLOR = { good: 'var(--good)', ok: 'var(--good)', info: 'var(--accent)', warn: 'var(--warning-ink)', bad: 'var(--critical)' };
const BOX = { good: 'ok-box', ok: 'ok-box', info: 'info-box', warn: 'warn-box', bad: 'error-box' };
const PRIORITY = { high: 'down', medium: 'degraded', low: '' };

const GLOSSARY = [
  ['median', 'Median (p50)', 'The “typical” request: half of the requests were faster, half slower.'],
  ['p95', 'p95', '95 out of 100 requests were at least this fast. A good measure of what most users experience, including slower moments.'],
  ['p99', 'p99', '99 out of 100 requests were at least this fast – the experience of the unluckiest 1%.'],
  ['errors', 'Error rate', 'Share of requests that failed or returned an unexpected status code.'],
  ['phases', 'DNS / TCP / TLS', 'Steps to open a connection: find the server’s address, connect to it, and set up encryption. Skipped when a connection is reused.'],
  ['ttfb', 'TTFB', 'Time to first byte – from sending the request until the server starts answering. Mostly server processing time plus one network round trip.'],
  ['throughput', 'Throughput (req/s)', 'How many requests the API completed per second.'],
  ['vus', 'Virtual users (VUs)', 'Simulated clients that each send requests one after another, as fast as the API answers.'],
  ['breaking', 'Breaking point', 'The load at which errors or latency went past the limits you set.'],
];

/**
 * For each glossary term: the value measured in *this* run, or where it is measured instead.
 * Returns { value } or { elsewhere: text, link: { to, label } }.
 */
function measuredIn(run) {
  const s = run.summary;
  if (run.kind === 'latency') {
    const p = s.profiles.find((x) => x.profile.name === 'No throttling') || s.profiles[0];
    const on = s.profiles.length > 1 ? ` (${p.profile.name})` : '';
    const ph = p.phases || {};
    const loadOnly = { elsewhere: 'Not part of a latency test – measured by a Load test.', link: { to: '/tests/load', label: 'Open Load test' } };
    return {
      median: { value: `${ms(p.stats.median)}${on}` },
      p95: { value: `${ms(p.stats.p95)}${on}` },
      p99: { value: `${ms(p.stats.p99)}${on}` },
      errors: { value: `${pct(p.errorRate)}${on}` },
      phases: run.config?.keepAlive
        ? { elsewhere: 'Not measured here – this run reused connections. Turn off “Reuse connections” to measure them.' }
        : { value: `DNS ${ms(ph.dns)} · TCP ${ms(ph.tcp)} · TLS ${ms(ph.tls)}${on}` },
      ttfb: { value: `${ms(ph.ttfb)}${on}` },
      throughput: loadOnly,
      vus: loadOnly,
      breaking: { elsewhere: 'Not part of a latency test – found by a Load test in Stress mode.', link: { to: '/tests/load', label: 'Open Load test' } },
    };
  }
  const L = s.latency || {};
  const latencyOnly = { elsewhere: 'Not measured in load tests (they reuse connections) – see a Latency test.', link: { to: '/tests/latency', label: 'Open Latency test' } };
  const levels = (s.stages || []).map((x) => x.level);
  // after a stress test breaks, whole-run numbers include many instant failures
  const w = s.mode === 'stress' && s.breakingPoint ? ' (whole run, incl. failures after the breaking point)' : '';
  return {
    median: { value: ms(L.p50) + w },
    p95: { value: ms(L.p95) + w },
    p99: { value: ms(L.p99) + w },
    errors: { value: pct(s.errorRate) + w },
    phases: latencyOnly,
    ttfb: latencyOnly,
    throughput: { value: s.maxSustainable && w ? `${num(s.maxSustainable.rps, 0)} at the healthy limit` : `${num(s.throughput?.avg, 0)} avg · ${num(s.throughput?.peak)} peak` },
    vus: run.config?.loadType === 'rps'
      ? { value: `Not used – this run set a request rate (up to ${num(Math.max(0, ...levels))} req/s) instead of virtual users.` }
      : { value: levels.length ? `${num(Math.min(...levels))}${Math.max(...levels) !== Math.min(...levels) ? ` → ${num(Math.max(...levels))}` : ''}` : '—' },
    breaking: s.mode !== 'stress'
      ? { elsewhere: `Not part of a ${s.mode} test – found by the Stress mode.`, link: { to: '/tests/load', label: 'Open Load test' } }
      : s.breakingPoint ? { value: `${num(s.breakingPoint.level)} ${run.config?.loadType === 'rps' ? 'req/s' : 'virtual users'}` }
        : { value: 'Not reached – the API stayed healthy up to the maximum load' },
  };
}

/** Compact one-line verdict for the top of the page. */
export function VerdictBanner({ insights }) {
  if (!insights) return null;
  const v = insights.verdict;
  const Icon = ICON[v.level];
  return (
    <div className={BOX[v.level]} style={{ marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <Icon size={18} />
      <strong>{v.title}</strong>
      <span className="grow" />
      <a href="#summary" className="small row" onClick={(e) => { e.preventDefault(); document.getElementById('summary')?.scrollIntoView({ behavior: 'smooth' }); }}>
        Read the summary & how to improve <ArrowDown size={13} />
      </a>
    </div>
  );
}

export default function RunSummary({ run, insights }) {
  const toast = useToast();
  if (!insights) return null;
  let values = {};
  try { values = measuredIn(run); } catch { /* older run without full data */ }
  const v = insights.verdict;
  const VIcon = ICON[v.level];
  const copy = async () => {
    try { await navigator.clipboard.writeText(insightsToText(run, insights)); toast('Summary copied – paste it into Slack, Teams or a ticket'); } catch { toast('Could not copy to clipboard', 'error'); }
  };

  return (
    <div className="card" id="summary" style={{ scrollMarginTop: 16 }}>
      <div className="card-head">
        <div className="card-title row"><Lightbulb size={17} color="var(--accent)" /> Summary & recommendations</div>
        <button type="button" className="btn sm" onClick={copy}><Copy size={14} /> Copy as text</button>
      </div>
      <div className="card-body stack">
        <div className={BOX[v.level]} style={{ padding: '14px 16px' }}>
          <div className="row" style={{ fontSize: 16, fontWeight: 650 }}><VIcon size={20} /> {v.title}</div>
          <div style={{ marginTop: 6, color: 'var(--text)' }}>{v.text}</div>
        </div>

        <div>
          <h3 style={{ marginBottom: 10 }}>What we found</h3>
          <div className="col" style={{ gap: 12 }}>
            {insights.findings.map((f) => {
              const Icon = ICON[f.level] || Info;
              return (
                <div key={f.title} className="row top" style={{ gap: 10 }}>
                  <Icon size={17} color={COLOR[f.level]} style={{ flexShrink: 0, marginTop: 2 }} aria-label={f.level} />
                  <div>
                    <div style={{ fontWeight: 600 }}>{f.title}</div>
                    {f.text && <div className="secondary small">{f.text}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div>
          <h3 style={{ marginBottom: 10 }}>How to improve</h3>
          {insights.recommendations.length === 0
            ? <div className="secondary">Nothing urgent – the results look healthy. Save this test and re-run it after each release to catch regressions early.</div>
            : (
              <ol style={{ margin: 0, paddingLeft: 22 }} className="col">
                {insights.recommendations.map((r) => (
                  <li key={r.title} style={{ marginBottom: 6 }}>
                    <div className="row wrap" style={{ gap: 8 }}>
                      <strong>{r.title}</strong>
                      <span className={`badge ${PRIORITY[r.priority]}`}>{r.priority} priority</span>
                    </div>
                    <div className="secondary small" style={{ marginTop: 2 }}>{r.text}</div>
                  </li>
                ))}
              </ol>
            )}
        </div>

        <details>
          <summary className="small" style={{ cursor: 'pointer', fontWeight: 600 }}>New to performance testing? What these terms mean – and their values in this test</summary>
          <div className="table-wrap">
            <table className="table mt-s">
              <thead><tr><th>Term</th><th>Meaning</th><th>In this test</th></tr></thead>
              <tbody>
                {GLOSSARY.map(([key, term, desc]) => {
                  const m = values[key] || {};
                  return (
                    <tr key={key}>
                      <td className="nowrap" style={{ fontWeight: 600, verticalAlign: 'top' }}>{term}</td>
                      <td className="secondary" style={{ verticalAlign: 'top' }}>{desc}</td>
                      <td style={{ verticalAlign: 'top', minWidth: 180 }}>
                        {m.value != null
                          ? <strong className="tabular">{m.value}</strong>
                          : <span className="small secondary">{m.elsewhere} {m.link && <Link to={m.link.to}>{m.link.label} →</Link>}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
        <div className="small muted">This summary is generated automatically from the measured numbers using common performance guidelines. Confirm the cause with your server logs and monitoring before making big changes.</div>
      </div>
    </div>
  );
}
