import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { get } from '../api.js';
import { Card, ErrorBox, useAsync } from '../components/ui.jsx';
import { TimeChart } from '../components/charts.jsx';
import { ProfileBadges } from './RunDetail.jsx';
import { ms, num, pct, dateTime } from '../format.js';

/** Difference cell: for "lower is better" metrics, an increase is a regression. */
function Delta({ a, b, lowerIsBetter = true, format = (v) => v }) {
  if (a == null || b == null) return <td className="num muted">—</td>;
  const d = b - a;
  const rel = a ? (d / a) * 100 : 0;
  const worse = lowerIsBetter ? d > 0 : d < 0;
  const notable = Math.abs(rel) >= 5;
  return (
    <td className="num" style={{ color: notable ? (worse ? 'var(--critical-ink)' : 'var(--good-ink)') : 'var(--text-2)' }}>
      {d > 0 ? '+' : ''}{format(d)} ({rel > 0 ? '+' : ''}{rel.toFixed(1)}%) {notable ? (worse ? '▲ worse' : '▼ better') : ''}
    </td>
  );
}

function Row({ label, a, b, format, lowerIsBetter }) {
  return (
    <tr><td>{label}</td><td className="num">{format(a)}</td><td className="num">{format(b)}</td><Delta a={a} b={b} format={format} lowerIsBetter={lowerIsBetter} /></tr>
  );
}

export default function Compare() {
  const [params] = useSearchParams();
  const a = useAsync(() => get(`/runs/${params.get('a')}`), [params.get('a')]);
  const b = useAsync(() => get(`/runs/${params.get('b')}`), [params.get('b')]);
  const merged = useMemo(() => {
    if (a.data?.kind !== 'load' || b.data?.kind !== 'load') return [];
    const ta = a.data.timeseries || []; const tb = b.data.timeseries || [];
    return Array.from({ length: Math.max(ta.length, tb.length) }, (_, i) => ({ t: i + 1, a_rps: ta[i]?.rps, b_rps: tb[i]?.rps, a_p95: ta[i]?.p95, b_p95: tb[i]?.p95 }));
  }, [a.data, b.data]);

  if (a.error || b.error) return <ErrorBox error={a.error || b.error} />;
  if (!a.data || !b.data) return <div className="muted">Loading…</div>;
  const A = a.data; const B = b.data;
  const head = (
    <thead><tr><th>Metric</th><th className="num">A · #{A.id}</th><th className="num">B · #{B.id}</th><th className="num">Change (B vs A)</th></tr></thead>
  );

  return (
    <div>
      <div className="page-head">
        <div>
          <Link to="/runs" className="small row"><ArrowLeft size={14} /> Test runs</Link>
          <h1 className="mt-s">Compare runs</h1>
          <div className="sub">Green = better, red = worse (changes under 5% are shown neutral).</div>
        </div>
      </div>
      <div className="grid grid-2">
        {[['A', A], ['B', B]].map(([k, r]) => (
          <Card key={k} title={<span>{k}: <Link to={`/runs/${r.id}`}>{r.name}</Link></span>}>
            <div className="row wrap small secondary"><ProfileBadges run={r} /> {dateTime(r.startedAt)} · {r.kind === 'load' ? `${r.config.mode}, ${r.config.loadType}` : `${r.config.count} requests`}</div>
          </Card>
        ))}
      </div>

      {A.kind === 'latency' && A.summary && B.summary && (
        A.summary.profiles.map((pa) => {
          const pb = B.summary.profiles.find((x) => x.profile.name === pa.profile.name);
          if (!pb) return null;
          return (
            <Card key={pa.profile.name} title={`Network: ${pa.profile.name}`} pad={false} className="mt">
              <table className="table">{head}<tbody>
                {['avg', 'median', 'p90', 'p95', 'p99', 'max'].map((k) => <Row key={k} label={k} a={pa.stats[k]} b={pb.stats[k]} format={(v) => ms(v)} />)}
                <Row label="Error rate" a={pa.errorRate} b={pb.errorRate} format={(v) => pct(v)} />
                {['dns', 'tcp', 'tls', 'ttfb', 'download'].map((k) => <Row key={k} label={`Phase: ${k}`} a={pa.phases[k]} b={pb.phases[k]} format={(v) => ms(v)} />)}
              </tbody></table>
            </Card>
          );
        })
      )}

      {A.kind === 'load' && A.summary && B.summary && <>
        <Card title="Summary" pad={false} className="mt">
          <table className="table">{head}<tbody>
            <Row label="Total requests" a={A.summary.totalRequests} b={B.summary.totalRequests} format={(v) => num(v)} lowerIsBetter={false} />
            <Row label="Throughput avg (req/s)" a={A.summary.throughput.avg} b={B.summary.throughput.avg} format={(v) => num(v, 1)} lowerIsBetter={false} />
            <Row label="Throughput peak (req/s)" a={A.summary.throughput.peak} b={B.summary.throughput.peak} format={(v) => num(v)} lowerIsBetter={false} />
            <Row label="Sustained (req/s)" a={A.summary.throughput.sustained} b={B.summary.throughput.sustained} format={(v) => num(v, 1)} lowerIsBetter={false} />
            {['avg', 'p50', 'p90', 'p95', 'p99', 'max'].map((k) => <Row key={k} label={`Latency ${k}`} a={A.summary.latency[k]} b={B.summary.latency[k]} format={(v) => ms(v)} />)}
            <Row label="Error rate" a={A.summary.errorRate} b={B.summary.errorRate} format={(v) => pct(v)} />
            {(A.summary.breakingPoint || B.summary.breakingPoint) && <Row label="Breaking point (load level)" a={A.summary.breakingPoint?.level} b={B.summary.breakingPoint?.level} format={(v) => num(v)} lowerIsBetter={false} />}
            {(A.summary.maxSustainable || B.summary.maxSustainable) && <Row label="Max sustainable (req/s)" a={A.summary.maxSustainable?.rps} b={B.summary.maxSustainable?.rps} format={(v) => num(v, 1)} lowerIsBetter={false} />}
          </tbody></table>
        </Card>
        <div className="grid grid-2 mt">
          <Card title="Throughput over time" className="chart-card">
            <TimeChart data={merged} xFormat={(t) => `${t}s`} yFormat={(v) => num(v)} series={[{ key: 'a_rps', label: `A #${A.id}`, color: 'var(--series-1)' }, { key: 'b_rps', label: `B #${B.id}`, color: 'var(--series-2)' }]} />
          </Card>
          <Card title="p95 latency over time" className="chart-card">
            <TimeChart data={merged} xFormat={(t) => `${t}s`} yFormat={(v) => ms(v)} series={[{ key: 'a_p95', label: `A #${A.id}`, color: 'var(--series-1)' }, { key: 'b_p95', label: `B #${B.id}`, color: 'var(--series-2)' }]} />
          </Card>
        </div>
      </>}
    </div>
  );
}
