import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, on } from '../api.js';
import { useStore } from '../store.jsx';
import { Card, Segmented, StatusBadge, Button, useAsync, useToast, Modal } from '../components/ui.jsx';
import { ActiveAlerts } from './Dashboard.jsx';
import { dateTime, duration } from '../format.js';

function Notifications({ alert, onClose }) {
  const { data } = useAsync(() => get(`/alerts/${alert.id}/notifications`), [alert.id]);
  return (
    <Modal title={`Notifications – ${alert.monitorName}`} onClose={onClose}>
      {!data ? 'Loading…' : data.length === 0 ? <div className="muted">No notifications were sent for this alert (no channels, suppressed, or not enabled for this alert type).</div> : (
        <table className="table">
          <thead><tr><th>Time</th><th>Channel</th><th>Kind</th><th>Result</th></tr></thead>
          <tbody>{data.map((n) => (
            <tr key={n.id}><td className="small">{dateTime(n.ts)}</td><td>{n.channel}</td><td>{n.kind}</td>
              <td>{n.ok ? <span className="badge up">Sent</span> : <span className="badge down" title={n.error}>Failed</span>}{n.error && <div className="small secondary">{n.error}</div>}</td></tr>
          ))}</tbody>
        </table>
      )}
    </Modal>
  );
}

export default function Alerts() {
  const { can } = useStore();
  const toast = useToast();
  const [view, setView] = useState('open');
  const history = useAsync(() => get('/alerts?status=all&limit=500'), []);
  const [detail, setDetail] = useState(null);
  useEffect(() => on('alert', () => history.reload()), []); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (a, action) => {
    try { await post(`/alerts/${a.id}/${action}`); toast('Done'); } catch (e) { toast(e.message, 'error'); }
  };

  return (
    <div>
      <div className="page-head">
        <div><h1>Alerts</h1><div className="sub">Raised when a monitor goes Down or Degraded; closed automatically on recovery.</div></div>
        <Segmented value={view} onChange={setView} options={[{ value: 'open', label: 'Open' }, { value: 'all', label: 'History' }]} />
      </div>
      {view === 'open' ? <Card pad={false}><ActiveAlerts /></Card> : (
        <Card pad={false}>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Monitor</th><th>Type</th><th>Started</th><th>Duration</th><th>Status</th><th>Error</th><th /></tr></thead>
              <tbody>
                {(history.data || []).map((a) => (
                  <tr key={a.id}>
                    <td><Link to={`/monitors/${a.monitorId}`}>{a.monitorName}</Link>{a.environment && <span className="tag" style={{ marginLeft: 6 }}>{a.environment}</span>}</td>
                    <td><StatusBadge state={a.type} /></td>
                    <td className="small nowrap">{dateTime(a.startedAt)}</td>
                    <td className="tabular">{duration((a.recoveredAt || a.resolvedAt || Date.now()) - a.startedAt)}</td>
                    <td className="small">
                      {a.status === 'resolved' ? <>Resolved by {a.resolvedBy}<div className="muted">{dateTime(a.resolvedAt)}</div></>
                        : a.status === 'acknowledged' ? <>Acknowledged by {a.acknowledgedBy}<div className="muted">{dateTime(a.acknowledgedAt)}</div></> : <span className="badge down">Active</span>}
                      {a.suppressed && <div><span className="tag">maintenance</span></div>}
                    </td>
                    <td className="small secondary" style={{ maxWidth: 260 }}><div className="ellipsis" title={a.message}>{a.message}</div></td>
                    <td className="nowrap">
                      <Button size="sm" variant="ghost" onClick={() => setDetail(a)}>Notifications</Button>
                      {can('editor') && a.status === 'active' && <Button size="sm" onClick={() => act(a, 'ack')}>Ack</Button>}
                      {can('editor') && a.status !== 'resolved' && <Button size="sm" onClick={() => act(a, 'resolve')}>Resolve</Button>}
                    </td>
                  </tr>
                ))}
                {history.data?.length === 0 && <tr><td colSpan={7} className="muted">No alerts yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {detail && <Notifications alert={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
