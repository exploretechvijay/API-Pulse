import { useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { get, post, put, del } from '../api.js';
import { useStore } from '../store.jsx';
import { Card, Button, Modal, Field, Input, Select, Check, ErrorBox, Empty, useAsync, useConfirm, useToast } from '../components/ui.jsx';
import { dateTime } from '../format.js';

const toLocal = (ts) => { const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };

function WindowForm({ win, onClose, onSaved }) {
  const { monitors } = useStore();
  const now = Date.now();
  const [w, setW] = useState(win || { name: '', startsAt: now, endsAt: now + 3600_000, recurrence: 'none', monitorIds: [] });
  const [error, setError] = useState(null);
  const set = (patch) => setW((x) => ({ ...x, ...patch }));
  const save = async () => {
    try { onSaved(win?.id ? await put(`/maintenance/${win.id}`, w) : await post('/maintenance', w)); } catch (e) { setError(e); }
  };
  return (
    <Modal title={win?.id ? 'Edit maintenance window' : 'New maintenance window'} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
      <div className="col gap-lg">
        <Field label="Name"><Input value={w.name} onChange={(v) => set({ name: v })} placeholder="Database upgrade" autoFocus /></Field>
        <div className="grid grid-2">
          <Field label="Starts"><input type="datetime-local" className="input" value={toLocal(w.startsAt)} onChange={(e) => set({ startsAt: new Date(e.target.value).getTime() })} /></Field>
          <Field label="Ends"><input type="datetime-local" className="input" value={toLocal(w.endsAt)} onChange={(e) => set({ endsAt: new Date(e.target.value).getTime() })} /></Field>
        </div>
        <Field label="Repeat" hint="Recurring windows repeat the same time span">
          <Select value={w.recurrence} onChange={(v) => set({ recurrence: v })} options={[{ value: 'none', label: 'Once' }, { value: 'daily', label: 'Every day' }, { value: 'weekly', label: 'Every week' }]} />
        </Field>
        <div>
          <div className="label">Monitors</div>
          <div className="small muted" style={{ marginBottom: 6 }}>None selected = all monitors</div>
          <div className="col" style={{ maxHeight: 220, overflowY: 'auto' }}>
            {(monitors || []).map((m) => (
              <Check key={m.id} checked={w.monitorIds.includes(m.id)} label={m.name}
                onChange={(on) => set({ monitorIds: on ? [...w.monitorIds, m.id] : w.monitorIds.filter((x) => x !== m.id) })} />
            ))}
          </div>
        </div>
        <div className="small muted">During a window, alerts are still recorded on the dashboard but no notifications are sent.</div>
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

export default function Maintenance() {
  const { can, monitors } = useStore();
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const list = useAsync(() => get('/maintenance'), []);
  const [editing, setEditing] = useState(null);
  const name = (id) => monitors?.find((m) => m.id === id)?.name || `#${id}`;
  const remove = async (w) => {
    if (!(await confirm({ title: 'Delete window?', message: `"${w.name}" will be deleted.`, danger: true, confirmLabel: 'Delete' }))) return;
    await del(`/maintenance/${w.id}`);
    list.reload();
  };
  return (
    <div>
      {confirmNode}
      <div className="page-head">
        <div><h1>Maintenance windows</h1><div className="sub">Silence notifications during planned downtime.</div></div>
        {can('editor') && <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>New window</Button>}
      </div>
      <Card pad={false}>
        {list.data?.length === 0 ? <Empty title="No maintenance windows" /> : (
          <table className="table">
            <thead><tr><th>Name</th><th>When</th><th>Repeats</th><th>Monitors</th><th>Status</th><th /></tr></thead>
            <tbody>
              {(list.data || []).map((w) => (
                <tr key={w.id}>
                  <td><strong>{w.name}</strong></td>
                  <td className="small">{dateTime(w.startsAt)} → {dateTime(w.endsAt)}</td>
                  <td>{w.recurrence === 'none' ? 'Once' : w.recurrence}</td>
                  <td className="small">{w.monitorIds.length ? w.monitorIds.map(name).join(', ') : 'All monitors'}</td>
                  <td>{w.active ? <span className="badge degraded">Active now</span> : w.recurrence === 'none' && w.endsAt < Date.now() ? <span className="badge">Ended</span> : <span className="badge blue">Scheduled</span>}</td>
                  <td className="nowrap" style={{ textAlign: 'right' }}>
                    {can('editor') && <><Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(w)} aria-label="Edit" /><Button size="sm" variant="ghost" icon={Trash2} onClick={() => remove(w)} aria-label="Delete" /></>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {editing && <WindowForm win={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload(); toast('Saved'); }} />}
    </div>
  );
}
