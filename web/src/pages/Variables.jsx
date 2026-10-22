import { useState } from 'react';
import { Plus, Pencil, Trash2, Lock } from 'lucide-react';
import { get, post, put, del } from '../api.js';
import { useStore } from '../store.jsx';
import { Card, Button, Modal, Field, Input, Check, ErrorBox, Empty, useAsync, useConfirm, useToast } from '../components/ui.jsx';

function VarForm({ v, onClose, onSaved }) {
  const [x, setX] = useState(v ? { ...v, value: v.isSecret ? '' : v.value } : { name: '', value: '', isSecret: true, description: '' });
  const [error, setError] = useState(null);
  const set = (patch) => setX((s) => ({ ...s, ...patch }));
  const save = async () => {
    const body = { ...x };
    if (v?.isSecret && x.value === '') body.value = '••••••••'; // keep existing secret
    try { onSaved(v?.id ? await put(`/variables/${v.id}`, body) : await post('/variables', body)); } catch (e) { setError(e); }
  };
  return (
    <Modal title={v?.id ? `Edit ${v.name}` : 'New variable'} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
      <div className="col gap-lg">
        <Field label="Name" hint="Use it anywhere as {{NAME}}"><Input className="mono" value={x.name} onChange={(val) => set({ name: val })} placeholder="API_TOKEN" autoFocus /></Field>
        <Field label="Value" hint={v?.isSecret ? 'Leave empty to keep the current secret' : undefined}>
          <Input className="mono" type={x.isSecret ? 'password' : 'text'} value={x.value} onChange={(val) => set({ value: val })} autoComplete="off" />
        </Field>
        <Check checked={x.isSecret} onChange={(val) => set({ isSecret: val })} label="Secret – hide the value in the UI and exports" />
        <Field label="Description"><Input value={x.description} onChange={(val) => set({ description: val })} /></Field>
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

export default function Variables() {
  const { can } = useStore();
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const list = useAsync(() => get('/variables'), []);
  const [editing, setEditing] = useState(null);
  const remove = async (v) => {
    if (!(await confirm({ title: 'Delete variable?', message: `Monitors and tests using {{${v.name}}} will fail until it is re-created.`, danger: true, confirmLabel: 'Delete' }))) return;
    await del(`/variables/${v.id}`);
    list.reload();
  };
  return (
    <div>
      {confirmNode}
      <div className="page-head">
        <div><h1>Variables & secrets</h1><div className="sub">Reusable values for URLs, headers, bodies and auth – e.g. <code>{'{{BASE_URL}}'}</code>, <code>{'{{API_TOKEN}}'}</code>. All values are encrypted at rest.</div></div>
        {can('editor') && <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>New variable</Button>}
      </div>
      <Card pad={false}>
        {list.data?.length === 0 ? <Empty title="No variables yet">Store base URLs per environment and tokens as secrets, then reference them with {'{{NAME}}'}.</Empty> : (
          <table className="table">
            <thead><tr><th>Name</th><th>Value</th><th>Description</th><th /></tr></thead>
            <tbody>
              {(list.data || []).map((v) => (
                <tr key={v.id}>
                  <td className="mono"><strong>{`{{${v.name}}}`}</strong></td>
                  <td className="mono small">{v.isSecret ? <span className="row muted"><Lock size={12} /> hidden</span> : v.value}</td>
                  <td className="small secondary">{v.description}</td>
                  <td className="nowrap" style={{ textAlign: 'right' }}>
                    {can('editor') && <><Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(v)} aria-label="Edit" /><Button size="sm" variant="ghost" icon={Trash2} onClick={() => remove(v)} aria-label="Delete" /></>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <div className="small muted mt">Built-in dynamic values: {'{{$timestamp}}'}, {'{{$timestampMs}}'}, {'{{$isoTimestamp}}'}, {'{{$uuid}}'}, {'{{$randomInt}}'}.</div>
      {editing && <VarForm v={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload(); toast('Saved'); }} />}
    </div>
  );
}
