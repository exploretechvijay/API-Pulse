import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { StatusBadge } from '../components/ui.jsx';
import { Logo } from '../components/Layout.jsx';
import { pct, ago } from '../format.js';

/** Public, read-only status page (DSH-09). No login required. */
export default function StatusPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    const load = () => fetch('/api/public/status').then(async (r) => {
      if (!r.ok) throw new Error(r.status === 404 ? 'The status page is not enabled.' : 'Could not load status.');
      setData(await r.json());
      setError(null);
    }).catch(setError);
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  if (error) return <div className="auth-page"><div className="card card-pad">{error.message}</div></div>;
  if (!data) return null;
  const down = data.monitors.filter((m) => m.state === 'down').length;
  const degraded = data.monitors.filter((m) => m.state === 'degraded').length;
  const overall = down ? { cls: 'error-box', Icon: XCircle, text: 'Some systems are down' }
    : degraded ? { cls: 'warn-box', Icon: AlertTriangle, text: 'Some systems are degraded' }
      : { cls: 'ok-box', Icon: CheckCircle2, text: 'All systems operational' };

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '32px 16px' }}>
      <div className="row" style={{ gap: 10, marginBottom: 24 }}><Logo size={28} /><h1>{data.title}</h1></div>
      <div className={overall.cls} style={{ fontSize: 16, padding: 16, display: 'flex', gap: 10, alignItems: 'center' }}>
        <overall.Icon size={20} /> <strong>{overall.text}</strong>
      </div>
      <div className="card mt" style={{ overflow: 'hidden' }}>
        {data.monitors.map((m) => (
          <div key={m.name} style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
            <div className="row between">
              <strong>{m.name}</strong>
              <div className="row"><span className="small secondary">{pct(m.uptime90d)} uptime (90 days)</span><StatusBadge state={m.state} /></div>
            </div>
            <div className="uptime-bar mt-s" style={{ height: 26 }}>
              {m.days.map((d) => (
                <div key={d.t} className={`cell ${d.uptime == null ? '' : d.uptime >= 99.9 ? 'good' : d.uptime >= 95 ? 'warn' : 'bad'}`}
                  title={`${new Date(d.t).toLocaleDateString()}: ${d.uptime == null ? 'no data' : `${d.uptime}% uptime`}`} />
              ))}
            </div>
            <div className="row between small muted mt-s"><span>90 days ago</span><span>Today</span></div>
          </div>
        ))}
        {data.monitors.length === 0 && <div className="card-body muted">No services published yet.</div>}
      </div>
      {data.incidents.length > 0 && (
        <div className="card mt card-pad">
          <h2>Current incidents</h2>
          {data.incidents.map((i) => <div key={i.monitor + i.since} className="mt-s">{i.monitor} is <strong>{i.type}</strong> since {ago(i.since)}</div>)}
        </div>
      )}
      <div className="small muted mt" style={{ textAlign: 'center' }}>Updated {ago(data.updatedAt)} · Powered by API Pulse</div>
    </div>
  );
}
