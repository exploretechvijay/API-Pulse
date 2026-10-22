import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { GitCompare } from 'lucide-react';
import { get, on } from '../api.js';
import { Card, Segmented, Button, Empty, useAsync } from '../components/ui.jsx';
import { RunStatus } from './RunDetail.jsx';
import { ms, num, pct, dateTime, duration } from '../format.js';

function Headline({ run }) {
  const h = run.headline;
  if (!h) return <span className="muted">—</span>;
  if (run.kind === 'load') {
    return <span className="small tabular">{num(h.requests)} req · {num(h.rps, 1)} req/s · p95 {ms(h.p95)} · {pct(h.errorRate)} errors{h.breakingPoint ? ` · broke at ${num(h.breakingPoint.level)}` : ''}</span>;
  }
  return <span className="small tabular">{h.profiles?.map((p) => `${p.name}: p95 ${ms(p.p95)}`).join(' · ')}</span>;
}

export default function Runs() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [kind, setKind] = useState('');
  const [selected, setSelected] = useState(() => (params.get('compare') ? [Number(params.get('compare'))] : []));
  const runs = useAsync(() => get(`/runs?limit=300${kind ? `&kind=${kind}` : ''}`), [kind]);
  useEffect(() => on('run', (e) => { if (e.type === 'started' || e.type === 'finished') runs.reload(); }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s.slice(-1), id]));
  const sel = (runs.data || []).filter((r) => selected.includes(r.id));
  const canCompare = sel.length === 2 && sel[0].kind === sel[1].kind;

  return (
    <div>
      <div className="page-head">
        <div><h1>Test runs</h1><div className="sub">History of every latency and load test. Select two runs of the same kind to compare them.</div></div>
        <div className="row wrap">
          <Segmented value={kind} onChange={setKind} options={[{ value: '', label: 'All' }, { value: 'latency', label: 'Latency' }, { value: 'load', label: 'Load' }]} />
          <Button variant="primary" icon={GitCompare} disabled={!canCompare} onClick={() => nav(`/runs/compare?a=${selected[0]}&b=${selected[1]}`)}>
            Compare {selected.length ? `(${selected.length}/2)` : ''}
          </Button>
        </div>
      </div>
      {params.get('compare') && selected.length === 1 && <div className="info-box" style={{ marginBottom: 12 }}>Select one more run to compare with run #{selected[0]}.</div>}
      {sel.length === 2 && !canCompare && <div className="warn-box" style={{ marginBottom: 12 }}>Only runs of the same kind can be compared.</div>}
      <Card pad={false}>
        {runs.data?.length === 0 ? <Empty title="No test runs yet">Run a latency or load test and its results will be kept here.</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th style={{ width: 30 }} /><th>Run</th><th>Status</th><th>Started</th><th>Duration</th><th>Results</th><th>Pass</th></tr></thead>
              <tbody>
                {(runs.data || []).map((r) => (
                  <tr key={r.id} className="click" onClick={() => nav(`/runs/${r.id}`)}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selected.includes(r.id)} onChange={() => toggle(r.id)} disabled={r.status === 'running'} aria-label={`Select run ${r.id}`} />
                    </td>
                    <td><strong>{r.name}</strong><div className="small muted">#{r.id} · {r.kind === 'load' ? `${r.config?.mode} load` : 'latency'} · {r.config?.profileNames?.join(', ')} · {r.trigger}</div></td>
                    <td><RunStatus run={r} /></td>
                    <td className="small nowrap">{dateTime(r.startedAt)}</td>
                    <td className="tabular">{duration((r.finishedAt || Date.now()) - r.startedAt)}</td>
                    <td><Headline run={r} /></td>
                    <td>{r.passed === true ? <span className="badge up">Pass</span> : r.passed === false ? <span className="badge down">Fail</span> : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
