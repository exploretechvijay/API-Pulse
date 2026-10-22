import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, CheckCircle2, AlertTriangle, XCircle, PauseCircle, Search, BellOff } from 'lucide-react';
import { useStore } from '../store.jsx';
import { post } from '../api.js';
import { Button, StatusBadge, StatusDot, Empty, Card, useToast } from '../components/ui.jsx';
import { ms, pct, ago, duration } from '../format.js';

const ORDER = { down: 0, degraded: 1, pending: 2, up: 3, paused: 4 };

function useTick(ms_ = 5000) {
  const [, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set((x) => x + 1), ms_); return () => clearInterval(t); }, [ms_]);
}

export function ActiveAlerts({ limit }) {
  const { alerts, can } = useStore();
  const toast = useToast();
  const list = limit ? alerts.slice(0, limit) : alerts;
  const act = async (a, action) => {
    try { await post(`/alerts/${a.id}/${action}`); toast(action === 'ack' ? 'Alert acknowledged' : 'Alert resolved'); } catch (e) { toast(e.message, 'error'); }
  };
  if (!alerts.length) return <div className="card-body secondary row"><CheckCircle2 size={16} color="var(--good)" /> No active alerts – all quiet.</div>;
  return (
    <div>
      {list.map((a) => (
        <div className="alert-item" key={a.id}>
          <StatusDot state={a.type} />
          <div className="grow">
            <div className="row wrap">
              <Link to={`/monitors/${a.monitorId}`} style={{ fontWeight: 600 }}>{a.monitorName}</Link>
              <StatusBadge state={a.type} />
              {a.status === 'acknowledged' && <span className="badge blue">Acknowledged by {a.acknowledgedBy}</span>}
              {a.suppressed && <span className="badge"><BellOff size={12} /> Maintenance</span>}
              {a.escalatedAt && <span className="badge down">Escalated</span>}
            </div>
            <div className="small secondary ellipsis" title={a.message}>{a.message || '—'}</div>
            <div className="small muted">Started {ago(a.startedAt)} · for {duration(Date.now() - a.startedAt)}</div>
          </div>
          {can('editor') && (
            <div className="row">
              {a.status === 'active' && <Button size="sm" onClick={() => act(a, 'ack')}>Acknowledge</Button>}
              <Button size="sm" onClick={() => act(a, 'resolve')}>Resolve</Button>
            </div>
          )}
        </div>
      ))}
      {limit && alerts.length > limit && <div className="card-body small"><Link to="/alerts">View all {alerts.length} alerts →</Link></div>}
    </div>
  );
}

function Tile({ m }) {
  return (
    <Link to={`/monitors/${m.id}`} className={`tile ${m.state}`}>
      <div className="row">
        <StatusDot state={m.state} />
        <strong className="ellipsis grow" title={m.name}>{m.name}</strong>
        <StatusBadge state={m.state} />
      </div>
      <div className="small muted ellipsis mono" title={m.request?.url}>{m.request?.method} {m.request?.url}</div>
      <div className="metrics">
        <div className="metric"><div className="k">Response</div><div className="v">{ms(m.lastResponseMs)}</div></div>
        <div className="metric"><div className="k">Uptime 24h</div><div className="v">{pct(m.uptime24h)}</div></div>
        <div className="metric"><div className="k">Last check</div><div className="v">{ago(m.lastCheckAt)}</div></div>
      </div>
      {(m.state === 'down' || m.state === 'degraded' || m.consecutiveFailures > 0) && m.lastError && (
        <div className="err ellipsis" title={m.lastError}>
          {m.state !== 'down' && m.consecutiveFailures > 0 ? `Failing ${m.consecutiveFailures}/${m.effective?.failureThreshold}: ` : ''}{m.lastError}
        </div>
      )}
      {(m.environment || m.tags?.length > 0) && (
        <div className="row wrap" style={{ gap: 4 }}>
          {m.environment && <span className="tag">{m.environment}</span>}
          {m.tags?.map((t) => <span className="tag" key={t}>#{t}</span>)}
        </div>
      )}
    </Link>
  );
}

export default function Dashboard() {
  const { monitors, can } = useStore();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  useTick();
  const q = params.get('q') || '';
  const status = params.get('status') || '';
  const env = params.get('env') || '';
  const tag = params.get('tag') || '';
  const setParam = (k, v) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); };

  const all = monitors || [];
  const counts = useMemo(() => {
    const c = { up: 0, degraded: 0, down: 0, paused: 0, pending: 0 };
    for (const m of all) c[m.state] = (c[m.state] || 0) + 1;
    return c;
  }, [all]);
  const envs = [...new Set(all.map((m) => m.environment).filter(Boolean))].sort();
  const tags = [...new Set(all.flatMap((m) => m.tags || []))].sort();

  const shown = all
    .filter((m) => !status || m.state === status)
    .filter((m) => !env || m.environment === env)
    .filter((m) => !tag || m.tags?.includes(tag))
    .filter((m) => !q || `${m.name} ${m.request?.url} ${m.project}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (ORDER[a.state] - ORDER[b.state]) || a.name.localeCompare(b.name));

  const stat = (key, label, Icon, color) => (
    <button type="button" className={`stat ${status === key ? 'on' : ''}`} onClick={() => setParam('status', status === key ? '' : key)} aria-pressed={status === key}>
      <div className="label small secondary"><Icon size={15} color={color} /> {label}</div>
      <div className="value tabular">{counts[key] || 0}</div>
    </button>
  );

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <div className="sub">{all.length} monitor{all.length === 1 ? '' : 's'} · updates live</div>
        </div>
        {can('editor') && <Button variant="primary" icon={Plus} onClick={() => nav('/monitors/new')}>New monitor</Button>}
      </div>

      <div className="summary-bar">
        {stat('up', 'Up', CheckCircle2, 'var(--good)')}
        {stat('degraded', 'Degraded', AlertTriangle, 'var(--warning)')}
        {stat('down', 'Down', XCircle, 'var(--critical)')}
        {stat('paused', 'Paused', PauseCircle, 'var(--muted)')}
      </div>

      <Card title="Active alerts" pad={false} className="mt" actions={<Link to="/alerts" className="small">Alert history</Link>}>
        <ActiveAlerts limit={5} />
      </Card>

      <div className="filters mt">
        <div className="row search" style={{ position: 'relative' }}>
          <Search size={15} style={{ position: 'absolute', left: 10, color: 'var(--muted)' }} />
          <input className="input" style={{ paddingLeft: 32 }} placeholder="Search monitors…" value={q} onChange={(e) => setParam('q', e.target.value)} aria-label="Search monitors" />
        </div>
        <select className="input" value={env} onChange={(e) => setParam('env', e.target.value)} aria-label="Environment">
          <option value="">All environments</option>
          {envs.map((e) => <option key={e}>{e}</option>)}
        </select>
        <select className="input" value={tag} onChange={(e) => setParam('tag', e.target.value)} aria-label="Tag">
          <option value="">All tags</option>
          {tags.map((t) => <option key={t}>{t}</option>)}
        </select>
        <select className="input" value={status} onChange={(e) => setParam('status', e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          {['up', 'degraded', 'down', 'pending', 'paused'].map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
        </select>
        {(q || env || tag || status) && <Button variant="ghost" size="sm" onClick={() => setParams({}, { replace: true })}>Clear filters</Button>}
      </div>

      {monitors === null ? <div className="muted">Loading…</div>
        : all.length === 0 ? (
          <div className="card">
            <Empty title="No monitors yet" action={can('editor') && <Button variant="primary" icon={Plus} onClick={() => nav('/monitors/new')}>Create your first monitor</Button>}>
              A monitor checks one API endpoint on a schedule and tells you when it is down or slow.
            </Empty>
          </div>
        ) : shown.length === 0 ? <div className="card"><Empty title="No monitors match these filters" /></div>
          : <div className="tiles">{shown.map((m) => <Tile key={m.id} m={m} />)}</div>}
    </div>
  );
}
