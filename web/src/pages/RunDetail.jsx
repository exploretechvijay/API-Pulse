import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Square, Download, Trash2, GitCompare, Wifi } from 'lucide-react';
import { get, post, del, on } from '../api.js';
import { useStore } from '../store.jsx';
import { Button, Card, ErrorBox, useToast, useConfirm } from '../components/ui.jsx';
import { TimeChart, Histogram, makeBins, PhaseBar, PHASES } from '../components/charts.jsx';
import { ms, num, pct, bytes, dateTime, duration, STOP_REASON } from '../format.js';
import RunSummary, { VerdictBanner } from '../components/RunSummary.jsx';
import { runInsights } from '../insights.js';

export const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)', 'var(--series-7)'];

export function RunStatus({ run }) {
  const cls = { running: 'blue', completed: 'up', stopped: 'degraded', failed: 'down' }[run.status] || '';
  return <span className={`badge ${cls}`}>{run.status === 'running' ? 'Running…' : run.status[0].toUpperCase() + run.status.slice(1)}</span>;
}

export function ProfileBadges({ run }) {
  const names = run.config?.profileNames || [];
  return names.map((n) => (
    <span key={n} className={`badge ${n === 'No throttling' ? '' : 'blue'}`} title="Network profile used for this run"><Wifi size={12} /> {n}</span>
  ));
}

function Criteria({ criteria }) {
  if (!criteria?.checks?.length) return null;
  return (
    <div className={criteria.passed ? 'ok-box' : 'error-box'} style={{ marginBottom: 16 }}>
      <strong>{criteria.passed ? 'PASSED' : 'FAILED'}</strong> pass criteria
      <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
        {criteria.checks.map((c) => <li key={c.name}>{c.passed ? '✓' : '✗'} {c.name} — actual {c.actual ?? '—'}</li>)}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- latency

function LatencyResults({ run, progress }) {
  const s = run.summary;
  const profiles = s?.profiles || [];
  const bins = useMemo(() => makeBins(profiles.flatMap((p) => p.requests.filter((r) => r[2] != null).map((r) => r[2]))), [profiles]);
  const timeline = useMemo(() => {
    const max = Math.max(0, ...profiles.map((p) => p.requests.length));
    return Array.from({ length: max }, (_, i) => {
      const row = { i: i + 1 };
      profiles.forEach((p, pi) => { row[`p${pi}`] = p.requests[i]?.[2] ?? null; });
      return row;
    });
  }, [profiles]);
  const maxPhase = Math.max(1, ...profiles.map((p) => PHASES.reduce((a, ph) => a + (p.phases[ph.key] || 0), 0)));

  if (!s) {
    const done = progress?.done || 0;
    const total = progress?.total || run.config?.count * (run.config?.profileNames?.length || 1);
    return (
      <Card title="Running…">
        <div className="progress"><div style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>
        <div className="small secondary mt-s">{done} / {total} requests</div>
      </Card>
    );
  }
  const series = profiles.map((p, i) => ({ key: `p${i}`, label: p.profile.name, color: SERIES[i % SERIES.length] }));

  return (
    <div className="stack">
      <Card title="Results by network profile" pad={false}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Profile</th><th className="num">Requests</th><th className="num">Min</th><th className="num">Avg</th><th className="num">Median</th>
              <th className="num">p90</th><th className="num">p95</th><th className="num">p99</th><th className="num">Max</th><th className="num">Errors</th></tr></thead>
            <tbody>
              {profiles.map((p, i) => (
                <tr key={p.profile.id ?? i}>
                  <td><span className="row"><span className="sw" style={{ width: 10, height: 10, borderRadius: 3, background: SERIES[i % SERIES.length], display: 'inline-block' }} /><strong>{p.profile.name}</strong></span></td>
                  <td className="num">{p.sent}</td><td className="num">{ms(p.stats.min)}</td><td className="num">{ms(p.stats.avg)}</td>
                  <td className="num">{ms(p.stats.median)}</td><td className="num">{ms(p.stats.p90)}</td><td className="num"><strong>{ms(p.stats.p95)}</strong></td>
                  <td className="num">{ms(p.stats.p99)}</td><td className="num">{ms(p.stats.max)}</td>
                  <td className="num">{pct(p.errorRate)}{Object.keys(p.errorsByType).length > 0 && <div className="small muted">{Object.entries(p.errorsByType).map(([k, v]) => `${k}: ${v}`).join(', ')}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Where the time goes (average per request)">
        <div className="legend" style={{ padding: '0 0 12px' }}>
          {PHASES.map((p) => <span className="item" key={p.key}><span className="sw box" style={{ background: p.color }} />{p.label}</span>)}
        </div>
        <div className="col gap-lg">
          {profiles.map((p) => (
            <div key={p.profile.id ?? p.profile.name}>
              <div className="row between small"><strong>{p.profile.name}</strong>
                <span className="secondary tabular">{PHASES.map((ph) => `${ph.short} ${ms(p.phases[ph.key])}`).join(' · ')}</span></div>
              <div className="mt-s"><PhaseBar phases={p.phases} max={maxPhase} /></div>
            </div>
          ))}
        </div>
        {!run.config?.keepAlive && <div className="small muted mt">Each request opened a new connection, so DNS, TCP and TLS are measured every time.</div>}
      </Card>

      <Card title="Response time per request" className="chart-card">
        <TimeChart data={timeline} xKey="i" series={series} xFormat={(v) => `#${v}`} yFormat={(v) => ms(v)} />
      </Card>

      <div className={`grid ${profiles.length > 1 ? 'grid-2' : ''}`}>
        {profiles.map((p, i) => (
          <Card key={p.profile.id ?? i} title={`Distribution – ${p.profile.name}`} className="chart-card">
            <Histogram values={p.requests.filter((r) => r[2] != null).map((r) => r[2])} bins={bins} color={SERIES[i % SERIES.length]} />
          </Card>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- load

function LoadResults({ run, ticks }) {
  const s = run.summary;
  const ts = (s ? run.timeseries : ticks) || [];
  const last = ts[ts.length - 1];
  const fmtT = (t) => `${t}s`;
  const levelLabel = run.config?.loadType === 'rps' ? 'Target rate (req/s)' : 'Virtual users';

  return (
    <div className="stack">
      {s?.breakingPoint && (
        <div className="error-box">
          <strong>Breaking point:</strong> {num(s.breakingPoint.level)} {run.config.loadType === 'rps' ? 'req/s target' : 'virtual users'} —
          {' '}{STOP_REASON[s.breakingPoint.reason]} (error rate {pct(s.breakingPoint.errorRate)}, p95 {ms(s.breakingPoint.p95)}).
          {s.maxSustainable && <> Max sustainable throughput: <strong>{num(s.maxSustainable.rps, 1)} req/s</strong> at {num(s.maxSustainable.level)} {run.config.loadType === 'rps' ? 'req/s target' : 'VUs'}.</>}
        </div>
      )}
      {s && s.mode === 'stress' && !s.breakingPoint && s.stopReason === 'max_load_reached' && (
        <div className="ok-box">The API did not break up to the hard maximum of {num(run.config.stress?.max)}. Max sustainable throughput: <strong>{num(s.maxSustainable?.rps, 1)} req/s</strong>.</div>
      )}

      <div className="kpis">
        {s ? <>
          <div className="kpi"><div className="k">Total requests</div><div className="v tabular">{num(s.totalRequests)}</div><div className="s">{duration(s.durationSec * 1000)}</div></div>
          <div className="kpi"><div className="k">Throughput (avg)</div><div className="v tabular">{num(s.throughput.avg, 1)}</div><div className="s">req/s · peak {num(s.throughput.peak)}</div></div>
          <div className="kpi"><div className="k">Sustained</div><div className="v tabular">{num(s.throughput.sustained, 1)}</div><div className="s">median req/s</div></div>
          <div className="kpi"><div className="k">p95 latency</div><div className="v tabular">{ms(s.latency.p95)}</div><div className="s">p99 {ms(s.latency.p99)}</div></div>
          <div className="kpi"><div className="k">Error rate</div><div className="v tabular" style={{ color: s.errorRate > 0 ? 'var(--critical-ink)' : undefined }}>{pct(s.errorRate)}</div><div className="s">{num(s.totalErrors)} errors</div></div>
          <div className="kpi"><div className="k">Data received</div><div className="v" style={{ fontSize: 18 }}>{bytes(s.bytesReceived)}</div><div className="s">request bodies {bytes(s.bytesSent)}</div></div>
        </> : <>
          <div className="kpi"><div className="k">Requests / s (now)</div><div className="v tabular">{num(last?.rps)}</div></div>
          <div className="kpi"><div className="k">p95 (last second)</div><div className="v tabular">{ms(last?.p95)}</div></div>
          <div className="kpi"><div className="k">Error rate (last second)</div><div className="v tabular">{pct(last?.errorRate)}</div></div>
          <div className="kpi"><div className="k">{levelLabel}</div><div className="v tabular">{num(last?.level)}</div><div className="s">{num(last?.vus)} active</div></div>
          <div className="kpi"><div className="k">Elapsed</div><div className="v tabular">{ts.length}s</div></div>
          <div className="kpi"><div className="k">Load generator CPU</div><div className="v tabular" style={{ color: last?.cpu > 85 ? 'var(--critical-ink)' : undefined }}>{pct(last?.cpu, 0)}</div><div className="s">thread busy {pct(last?.elu, 0)}</div></div>
        </>}
      </div>

      <div className="grid grid-2">
        <Card title="Throughput (requests / second)" className="chart-card">
          <TimeChart data={ts} series={[{ key: 'rps', label: 'Requests/s', color: 'var(--series-1)' }]} xFormat={fmtT} yFormat={(v) => num(v)} area />
        </Card>
        <Card title="Response time" className="chart-card">
          <TimeChart data={ts} xFormat={fmtT} yFormat={(v) => ms(v)} series={[
            { key: 'p50', label: 'p50', color: 'var(--series-1)' }, { key: 'p95', label: 'p95', color: 'var(--series-2)' }, { key: 'p99', label: 'p99', color: 'var(--series-3)' }]} />
        </Card>
        <Card title="Error rate (%)" className="chart-card">
          <TimeChart data={ts} series={[{ key: 'errorRate', label: 'Error rate', color: 'var(--critical)' }]} xFormat={fmtT} yFormat={(v) => `${v}%`} area />
        </Card>
        <Card title={run.config?.loadType === 'rps' ? 'Load (target rate & in-flight requests)' : 'Active virtual users'} className="chart-card">
          <TimeChart data={ts} xFormat={fmtT} yFormat={(v) => num(v)} series={run.config?.loadType === 'rps'
            ? [{ key: 'level', label: 'Target req/s', color: 'var(--series-1)' }, { key: 'inflight', label: 'In flight', color: 'var(--series-2)' }]
            : [{ key: 'vus', label: 'Active VUs', color: 'var(--series-1)' }]} />
        </Card>
      </div>

      {s && <>
        <div className="grid grid-2">
          <Card title="Latency percentiles" pad={false}>
            <table className="table"><tbody>
              {[['Min', 'min'], ['Average', 'avg'], ['Median (p50)', 'p50'], ['p90', 'p90'], ['p95', 'p95'], ['p99', 'p99'], ['Max', 'max'], ['Std deviation', 'stddev']].map(([l, k]) => (
                <tr key={k}><td>{l}</td><td className="num">{ms(s.latency[k])}</td></tr>
              ))}
            </tbody></table>
          </Card>
          <Card title="Responses & errors" pad={false}>
            <table className="table">
              <thead><tr><th>Status / error</th><th className="num">Count</th><th className="num">Share</th></tr></thead>
              <tbody>
                {Object.entries(s.statusCodes).map(([k, v]) => <tr key={k}><td>HTTP {k}</td><td className="num">{num(v)}</td><td className="num">{pct((v / s.totalRequests) * 100)}</td></tr>)}
                {Object.entries(s.errorsByType).filter(([k]) => !k.startsWith('HTTP')).map(([k, v]) => (
                  <tr key={k}><td><span className="badge down">{k.replace(/_/g, ' ')}</span></td><td className="num">{num(v)}</td><td className="num">{pct((v / s.totalRequests) * 100)}</td></tr>
                ))}
              </tbody>
            </table>
            {s.droppedIterations > 0 && <div className="card-body warn-box">{num(s.droppedIterations)} iterations dropped (concurrency limit reached).</div>}
          </Card>
        </div>

        {s.stages?.length > 1 && (
          <Card title={s.mode === 'stress' ? 'Stress steps' : 'Stages'} pad={false}>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>#</th><th className="num">{run.config.loadType === 'rps' ? 'Target req/s' : 'VUs'}</th><th className="num">Achieved req/s</th><th className="num">Requests</th>
                  <th className="num">Avg</th><th className="num">p95</th><th className="num">p99</th><th className="num">Error rate</th><th>Result</th></tr></thead>
                <tbody>
                  {s.stages.map((st) => (
                    <tr key={st.index}>
                      <td>{st.index + 1}</td><td className="num">{num(st.level)}</td><td className="num">{num(st.rps, 1)}</td><td className="num">{num(st.requests)}</td>
                      <td className="num">{ms(st.avg)}</td><td className="num">{ms(st.p95)}</td><td className="num">{ms(st.p99)}</td><td className="num">{pct(st.errorRate)}</td>
                      <td>{st.passed ? <span className="badge up">OK</span> : <span className="badge down">{STOP_REASON[st.violation] || st.violation}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {s.perStep && (
          <Card title="Scenario steps" pad={false}>
            <table className="table">
              <thead><tr><th>Step</th><th className="num">Requests</th><th className="num">Errors</th><th className="num">Avg</th><th className="num">p95</th><th className="num">p99</th></tr></thead>
              <tbody>{s.perStep.map((p) => (
                <tr key={p.name}><td>{p.name}</td><td className="num">{num(p.requests)}</td><td className="num">{num(p.errors)}</td><td className="num">{ms(p.avg)}</td><td className="num">{ms(p.p95)}</td><td className="num">{ms(p.p99)}</td></tr>
              ))}</tbody>
            </table>
          </Card>
        )}

        <Card title="Load generator health" className="chart-card">
          <TimeChart data={ts} xFormat={fmtT} yFormat={(v) => `${v}%`} yDomain={[0, 100]} refLine={{ y: 85, label: '85% – results may be unreliable' }}
            series={[{ key: 'cpu', label: 'Machine CPU', color: 'var(--series-1)' }, { key: 'elu', label: 'Generator thread busy', color: 'var(--series-2)' }]} />
        </Card>
      </>}
    </div>
  );
}

// ---------------------------------------------------------------- page

export default function RunDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useStore();
  const [confirm, confirmNode] = useConfirm();
  const [run, setRun] = useState(null);
  const [error, setError] = useState(null);
  const [ticks, setTicks] = useState([]);
  const [progress, setProgress] = useState(null);
  const insights = useMemo(() => { try { return runInsights(run); } catch { return null; } }, [run]);

  useEffect(() => {
    let alive = true;
    setRun(null); setTicks([]); setProgress(null);
    const load = () => get(`/runs/${id}`).then((r) => { if (!alive) return; setRun(r); if (r.live) setTicks(r.live.timeseries); }).catch(setError);
    load();
    const off = on('run', (e) => {
      if (e.id !== Number(id)) return;
      if (e.type === 'tick') setTicks((t) => [...t, e.data]);
      else if (e.type === 'progress') setProgress(e.data);
      else if (e.type === 'finished') load();
    });
    return () => { alive = false; off(); };
  }, [id]);

  if (error) return <ErrorBox error={error} />;
  if (!run) return <div className="muted">Loading…</div>;

  const stop = async () => {
    try { await post(`/runs/${id}/stop`); toast('Stopping…'); } catch (e) { toast(e.message, 'error'); }
  };
  const remove = async () => {
    if (!(await confirm({ title: 'Delete run?', message: 'The results of this run will be deleted.', danger: true, confirmLabel: 'Delete' }))) return;
    await del(`/runs/${id}`);
    nav('/runs');
  };
  const elapsed = (run.finishedAt || Date.now()) - run.startedAt;

  return (
    <div>
      {confirmNode}
      <div className="page-head">
        <div className="grow">
          <Link to="/runs" className="small row"><ArrowLeft size={14} /> Test runs</Link>
          <div className="row wrap mt-s"><h1>{run.name}</h1><RunStatus run={run} /></div>
          <div className="row wrap small secondary mt-s">
            <span className="badge">{run.kind === 'load' ? `${run.config.mode} load` : 'latency'}</span>
            <ProfileBadges run={run} />
            <span>Started {dateTime(run.startedAt)}</span>·<span>{duration(elapsed)}</span>·<span>by {run.createdBy}</span>·<span>{run.trigger}</span>
            {run.summary?.stopReason && <>·<span>{STOP_REASON[run.summary.stopReason] || run.summary.stopReason}</span></>}
          </div>
        </div>
        <div className="row wrap">
          {run.status === 'running' && can('editor') && <Button variant="danger solid" icon={Square} onClick={stop}>Stop now</Button>}
          {run.hasRaw && <a className="btn" href={`/api/runs/${id}/raw`}><Download size={16} /> Raw results (CSV)</a>}
          {run.status !== 'running' && <Button icon={GitCompare} onClick={() => nav(`/runs?compare=${id}`)}>Compare…</Button>}
          {run.status !== 'running' && can('editor') && <Button icon={Trash2} variant="danger" onClick={remove} aria-label="Delete run" />}
        </div>
      </div>

      {run.error && <div className="error-box" style={{ marginBottom: 16 }}><strong>Run failed:</strong> <span className="mono small">{run.error.split('\n')[0]}</span></div>}
      {run.warnings?.map((w) => <div className="warn-box" key={w} style={{ marginBottom: 12 }}>⚠ {w}</div>)}
      <Criteria criteria={run.summary?.criteria} />
      <VerdictBanner insights={insights} />

      {run.kind === 'latency' ? <LatencyResults run={run} progress={progress} /> : <LoadResults run={run} ticks={ticks} />}
      {insights && <div className="mt"><RunSummary run={run} insights={insights} /></div>}
      <details className="mt">
        <summary className="small secondary">Test configuration</summary>
        <div className="pre mt-s">{JSON.stringify(run.config, null, 2)}</div>
      </details>
    </div>
  );
}
