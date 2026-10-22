import { useState } from 'react';
import { get } from '../api.js';
import { Card, Input, useAsync } from '../components/ui.jsx';
import { dateTime } from '../format.js';

export default function Audit() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const list = useAsync(() => get(`/audit?limit=500${query ? `&q=${encodeURIComponent(query)}` : ''}`), [query]);
  return (
    <div>
      <div className="page-head">
        <div><h1>Audit log</h1><div className="sub">Who created, changed or ran each monitor and test.</div></div>
        <form onSubmit={(e) => { e.preventDefault(); setQuery(q); }}><Input value={q} onChange={setQ} placeholder="Search action, user, details…" style={{ width: 280 }} /></form>
      </div>
      <Card pad={false}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Object</th><th>Details</th></tr></thead>
            <tbody>
              {(list.data || []).map((a) => (
                <tr key={a.id}>
                  <td className="small nowrap">{dateTime(a.ts)}</td>
                  <td className="small">{a.userEmail}</td>
                  <td><code>{a.action}</code></td>
                  <td className="small">{a.entityType}{a.entityId ? ` #${a.entityId}` : ''}</td>
                  <td className="small secondary mono" style={{ maxWidth: 380 }}><div className="ellipsis" title={a.details ? JSON.stringify(a.details) : ''}>{a.details ? JSON.stringify(a.details) : ''}</div></td>
                </tr>
              ))}
              {list.data?.length === 0 && <tr><td colSpan={5} className="muted">Nothing found.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
