import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Pencil, Copy, Pause, Play, Trash2, RefreshCw, ArrowLeft } from 'lucide-react';
import { api, get, post, del, on } from '../api.js';
import { useStore } from '../store.jsx';
import { Button, Card, StatusBadge, Segmented, Check, Pager, useAsync, useToast, useConfirm, ErrorBox } from '../components/ui.jsx';

const INCIDENTS_PER_PAGE = 10;

/** "11:16:42 AM" for today, "20 Oct, 11:16:42 AM" for older checks (older pages span days). */
function checkTime(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString();
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}
import { TimeChart, UptimeBar } from '../components/charts.jsx';
import { ms, pct, ago, dateTime, duration } from '../format.js';

const RANGES = ['1h', '24h', '7d', '30d', '90d'];

export default function MonitorDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const { monitors, can, profiles } = useStore();
  const [range, setRange] = useState('24h');
  const live = monitors?.find((m) => m.id === Number(id));
  const detail = useAsync(() => get(`/monitors/${id}`), [id]);
  const stats = useAsync(() => get(`/monitors/${id}/stats?range=${range}`), [id, range]);
  // recent checks: server-side pagination (newest first)
  const [checkPage, setCheckPage] = useState(0);
  const [checkSize, setCheckSize] = useState(10);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const checks = useAsync(async () => {
    const res = await api(`/monitors/${id}/checks?limit=${checkSize}&offset=${checkPage * checkSize}${onlyProblems ? '&result=problems' : ''}`, { raw: true });
    if (!res.ok) throw new Error(`Could not load checks (${res.status})`);
    return { items: await res.json(), total: Number(res.headers.get('x-total-count') || 0) };
  }, [id, checkPage, checkSize, onlyProblems]);
  // incident log: at most 100 rows from the server, paged here
  const incidents = useAsync(() => get(`/monitors/${id}/alerts`), [id]);
  const [incPage, setIncPage] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setCheckPage(0); setIncPage(0); }, [id]);

  useEffect(() => {
    const offCheck = on('check', ({ monitor, check }) => {
      if (monitor.id !== Number(id)) return;
      if (!onlyProblems || check.result !== 'ok') {
        checks.setData((d) => {
          if (!d) return d;
          // only the newest page changes; older pages keep their rows and just see a higher total
          const items = checkPage === 0 ? [{ ...check, id: `live-${check.ts}` }, ...d.items].slice(0, checkSize) : d.items;
          return { items, total: d.total + 1 };
        });
      }
      if (range === '1h' || range === '24h') stats.reload();
    });
    const offAlert = on('alert', (a) => { if (a.monitorId === Number(id)) incidents.reload(); });
    return () => { offCheck(); offAlert(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, range, checkPage, checkSize, onlyProblems]);

  if (detail.error) return <ErrorBox error={detail.error} />;
  const m = { ...(detail.data || {}), ...(live || {}) };
  if (!detail.data) return <div className="muted">Loading…</div>;

  const act = async (fn, msg) => {
    setBusy(true);
    try { await fn(); if (msg) toast(msg); } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!(await confirm({ title: 'Delete monitor?', message: `"${m.name}" and all its check history will be deleted. This cannot be undone.`, danger: true, confirmLabel: 'Delete' }))) return;
    await act(() => del(`/monitors/${id}`), 'Monitor deleted');
    nav('/');
  };
  const s = stats.data;
  const xFmt = (t) => {
    const d = new Date(t);
    return range === '1h' || range === '24h' ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(range === '7d' ? { hour: '2-digit' } : {}) });
  };
  const profile = profiles.find((p) => p.id === m.networkProfileId);

  return (
    <div>
      {confirmNode}
      <div className="page-head">
        <div className="grow">
          <Link to="/" className="small row"><ArrowLeft size={14} /> Dashboard</Link>
          <div className="row wrap mt-s"><h1>{m.name}</h1><StatusBadge state={m.state} /></div>
          <div className="sub mono small ellipsis">{m.request.method} {m.request.url}</div>
          <div className="row wrap small secondary mt-s">
            <span>Every {m.effective.intervalSec}s</span>·<span>timeout {m.effective.timeoutMs} ms</span>·
            <span>down after {m.effective.failureThreshold} failures</span>
            {m.effective.degradedMs && <>·<span>degraded above {m.effective.degradedMs} ms</span></>}
            {profile && <>·<span className="badge blue">Network: {profile.name}</span></>}
            {m.environment && <span className="tag">{m.environment}</span>}
            {m.tags?.map((t) => <span className="tag" key={t}>#{t}</span>)}
          </div>
        </div>
        {can('editor') && (
          <div className="row wrap">
            <Button icon={RefreshCw} disabled={busy} onClick={() => act(() => post(`/monitors/${id}/check`), 'Check completed')}>Check now</Button>
            <Button icon={Pencil} onClick={() => nav(`/monitors/${id}/edit`)}>Edit</Button>
            <Button icon={Copy} disabled={busy} onClick={() => act(async () => { const c = await post(`/monitors/${id}/clone`); nav(`/monitors/${c.id}/edit`); }, 'Cloned – the copy is paused')}>Clone</Button>
            {m.paused
              ? <Button icon={Play} disabled={busy} onClick={() => act(() => post(`/monitors/${id}/resume`), 'Monitor resumed')}>Resume</Button>
              : <Button icon={Pause} disabled={busy} onClick={() => act(() => post(`/monitors/${id}/pause`), 'Monitor paused')}>Pause</Button>}
            <Button icon={Trash2} variant="danger" onClick={remove} aria-label="Delete" />
          </div>
        )}
      </div>

      {m.lastError && m.state !== 'up' && <div className={m.state === 'down' ? 'error-box' : 'warn-box'} style={{ marginBottom: 16 }}>Last error: {m.lastError}</div>}

      <div className="row between wrap" style={{ marginBottom: 12 }}>
        <h2>Performance</h2>
        <Segmented value={range} onChange={setRange} options={RANGES} />
      </div>

      <div className="kpis">
        <div className="kpi"><div className="k">Uptime ({range})</div><div className="v tabular">{pct(s?.summary.uptime)}</div><div className="s">{s?.summary.checks ?? '—'} checks</div></div>
        <div className="kpi"><div className="k">Avg response</div><div className="v tabular">{ms(s?.summary.avgMs)}</div><div className="s">now {ms(m.lastResponseMs)}</div></div>
        <div className="kpi"><div className="k">p95 response</div><div className="v tabular">{ms(s?.summary.p95Ms)}</div><div className="s">p99 {ms(s?.summary.p99Ms)}</div></div>
        <div className="kpi"><div className="k">Incidents</div><div className="v tabular">{s?.summary.incidents ?? '—'}</div><div className="s">{s?.summary.slowChecks ?? 0} slow checks</div></div>
        <div className="kpi"><div className="k">Last check</div><div className="v" style={{ fontSize: 18 }}>{ago(m.lastCheckAt)}</div><div className="s">HTTP {m.lastStatusCode ?? '—'}</div></div>
      </div>

      <Card title="Response time" className="mt chart-card">
        {s && <TimeChart data={s.series} xFormat={xFmt} yFormat={(v) => ms(v)}
          refLine={m.effective.degradedMs ? { y: m.effective.degradedMs, label: 'Degraded threshold' } : null}
          series={[{ key: 'avg', label: 'Average', color: 'var(--series-1)' }, { key: 'p95', label: 'p95', color: 'var(--series-2)' }]} />}
      </Card>

      <Card title={`Uptime history (${range})`} className="mt">
        {s && <UptimeBar series={s.series} xFormat={(t) => new Date(t).toLocaleString()} />}
      </Card>

      <div className="grid grid-2 mt">
        <Card title="Recent checks" pad={false} actions={
          <Check checked={onlyProblems} onChange={(v) => { setOnlyProblems(v); setCheckPage(0); }} label="Failed / slow only" />
        }>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Time</th><th>Result</th><th>Status</th><th className="num">Response</th><th>Error</th></tr></thead>
              <tbody>
                {(checks.data?.items || []).map((c) => (
                  <tr key={c.id}>
                    <td className="nowrap small">{checkTime(c.ts)}</td>
                    <td><StatusBadge state={c.result === 'ok' ? 'up' : c.result === 'slow' ? 'degraded' : 'down'} /></td>
                    <td className="tabular">{c.statusCode ?? '—'}</td>
                    <td className="num" title={c.timings ? `DNS ${c.timings.dns} · TCP ${c.timings.tcp} · TLS ${c.timings.tls} · TTFB ${c.timings.ttfb} · download ${c.timings.download}` : ''}>{ms(c.responseMs)}</td>
                    <td className="small secondary" style={{ maxWidth: 220 }}><div className="ellipsis" title={c.error || ''}>{c.error || ''}</div></td>
                  </tr>
                ))}
                {checks.data?.items.length === 0 && <tr><td colSpan={5} className="muted">{onlyProblems ? 'No failed or slow checks.' : 'No checks yet.'}</td></tr>}
              </tbody>
            </table>
          </div>
          {checks.data?.total > 0 && (
            <Pager page={checkPage} pageSize={checkSize} total={checks.data.total} onPage={setCheckPage}
              onPageSize={(s) => { setCheckSize(s); setCheckPage(0); }} />
          )}
        </Card>
        <Card title="Incident log" pad={false}>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Started</th><th>Type</th><th>Duration</th><th>Status</th></tr></thead>
              <tbody>
                {(incidents.data || []).slice(incPage * INCIDENTS_PER_PAGE, (incPage + 1) * INCIDENTS_PER_PAGE).map((a) => (
                  <tr key={a.id} title={a.message || ''}>
                    <td className="nowrap small">{dateTime(a.startedAt)}</td>
                    <td><StatusBadge state={a.type} /></td>
                    <td className="tabular">{duration((a.recoveredAt || a.resolvedAt || Date.now()) - a.startedAt)}{!a.recoveredAt && a.status !== 'resolved' ? ' (ongoing)' : ''}</td>
                    <td className="small">
                      {a.status === 'resolved' ? `Resolved by ${a.resolvedBy}` : a.status === 'acknowledged' ? `Acked by ${a.acknowledgedBy}` : 'Active'}
                      {a.suppressed && <span className="tag" style={{ marginLeft: 6 }}>maintenance</span>}
                    </td>
                  </tr>
                ))}
                {incidents.data?.length === 0 && <tr><td colSpan={4} className="muted">No incidents recorded.</td></tr>}
              </tbody>
            </table>
          </div>
          {incidents.data?.length > INCIDENTS_PER_PAGE && (
            <Pager page={incPage} pageSize={INCIDENTS_PER_PAGE} total={incidents.data.length} onPage={setIncPage} />
          )}
        </Card>
      </div>
    </div>
  );
}
