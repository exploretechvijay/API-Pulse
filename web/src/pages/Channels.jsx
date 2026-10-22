import { useState } from 'react';
import { Plus, Pencil, Trash2, Send } from 'lucide-react';
import { get, post, put, del } from '../api.js';
import { useStore } from '../store.jsx';
import { Card, Button, Modal, Field, Input, NumberInput, Select, Check, ErrorBox, KeyValueEditor, Empty, useAsync, useConfirm, useToast } from '../components/ui.jsx';

const TYPES = [
  { value: 'slack', label: 'Slack' }, { value: 'teams', label: 'Microsoft Teams' }, { value: 'email', label: 'Email (SMTP)' }, { value: 'webhook', label: 'Webhook' },
];

function ChannelForm({ channel, onClose, onSaved }) {
  const [c, setC] = useState(channel || { name: '', type: 'slack', enabled: true, isDefault: true, config: {} });
  const [error, setError] = useState(null);
  const set = (patch) => setC((x) => ({ ...x, ...patch }));
  const cfg = (patch) => setC((x) => ({ ...x, config: { ...x.config, ...patch } }));
  const save = async () => {
    try { onSaved(channel?.id ? await put(`/channels/${channel.id}`, c) : await post('/channels', c)); } catch (e) { setError(e); }
  };
  return (
    <Modal title={channel?.id ? 'Edit channel' : 'New alert channel'} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
      <div className="col gap-lg">
        <div className="grid grid-2">
          <Field label="Name"><Input value={c.name} onChange={(v) => set({ name: v })} placeholder="#oncall" autoFocus /></Field>
          <Field label="Type"><Select value={c.type} onChange={(v) => set({ type: v, config: {} })} options={TYPES} disabled={!!channel?.id} /></Field>
        </div>
        {(c.type === 'slack' || c.type === 'teams') && (
          <Field label="Incoming webhook URL" hint={c.type === 'slack' ? 'Slack → Apps → Incoming Webhooks' : 'Teams → Workflows → “Post to a channel when a webhook request is received”'}>
            <Input className="mono" type="password" value={c.config.webhookUrl} onChange={(v) => cfg({ webhookUrl: v })} placeholder="https://hooks…" autoComplete="off" />
          </Field>
        )}
        {c.type === 'slack' && <Field label="Mention (optional)" hint="e.g. <!channel> or <@U123>"><Input value={c.config.mention} onChange={(v) => cfg({ mention: v })} /></Field>}
        {c.type === 'email' && <>
          <div className="grid grid-2">
            <Field label="SMTP host"><Input value={c.config.host} onChange={(v) => cfg({ host: v })} placeholder="smtp.example.com" /></Field>
            <Field label="Port"><NumberInput value={c.config.port ?? 587} onChange={(v) => cfg({ port: v })} /></Field>
            <Field label="Username"><Input value={c.config.username} onChange={(v) => cfg({ username: v })} autoComplete="off" /></Field>
            <Field label="Password"><Input type="password" value={c.config.password} onChange={(v) => cfg({ password: v })} autoComplete="new-password" /></Field>
            <Field label="From"><Input value={c.config.from} onChange={(v) => cfg({ from: v })} placeholder="API Pulse <alerts@example.com>" /></Field>
            <Field label="To" hint="Comma separated"><Input value={c.config.to} onChange={(v) => cfg({ to: v })} placeholder="oncall@example.com" /></Field>
          </div>
          <Check checked={c.config.secure} onChange={(v) => cfg({ secure: v })} label="Use TLS from the start (port 465). Leave off for STARTTLS on 587." />
        </>}
        {c.type === 'webhook' && <>
          <div className="url-row">
            <Select value={c.config.method || 'POST'} onChange={(v) => cfg({ method: v })} options={['POST', 'PUT']} />
            <Input className="mono" value={c.config.url} onChange={(v) => cfg({ url: v })} placeholder="https://example.com/hooks/api-pulse" />
          </div>
          <Field label="Headers"><KeyValueEditor items={c.config.headers || []} onChange={(v) => cfg({ headers: v })} addLabel="Add header" /></Field>
          <Field label="Signing secret (optional)" hint="Adds X-Pulse-Signature: sha256=HMAC(body)"><Input type="password" value={c.config.secret} onChange={(v) => cfg({ secret: v })} autoComplete="off" /></Field>
        </>}
        <div className="col">
          <Check checked={c.enabled} onChange={(v) => set({ enabled: v })} label="Enabled" />
          <Check checked={c.isDefault} onChange={(v) => set({ isDefault: v })} label="Select by default for new monitors" />
        </div>
        <div className="small muted">Secrets are stored encrypted and never shown again.</div>
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

export default function Channels() {
  const { can } = useStore();
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const list = useAsync(() => get('/channels'), []);
  const [editing, setEditing] = useState(null);
  const [testing, setTesting] = useState(null);
  const test = async (c) => {
    setTesting(c.id);
    try {
      const r = await post(`/channels/${c.id}/test`);
      toast(r.ok ? `Test sent to ${c.name}` : `Failed: ${r.error}`, r.ok ? 'info' : 'error');
    } catch (e) { toast(e.message, 'error'); } finally { setTesting(null); }
  };
  const remove = async (c) => {
    if (!(await confirm({ title: 'Delete channel?', message: `"${c.name}" will be removed from all monitors.`, danger: true, confirmLabel: 'Delete' }))) return;
    await del(`/channels/${c.id}`);
    list.reload();
  };
  return (
    <div>
      {confirmNode}
      <div className="page-head">
        <div><h1>Alert channels</h1><div className="sub">Where Down, Degraded and recovery notifications are sent.</div></div>
        {can('editor') && <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>New channel</Button>}
      </div>
      <Card pad={false}>
        {list.data?.length === 0 ? <Empty title="No channels yet">Add Slack, Microsoft Teams, email or a webhook. Alerts always show on the dashboard too.</Empty> : (
          <table className="table">
            <thead><tr><th>Name</th><th>Type</th><th>Target</th><th>Status</th><th /></tr></thead>
            <tbody>
              {(list.data || []).map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.name}</strong>{c.isDefault && <span className="tag" style={{ marginLeft: 6 }}>default</span>}</td>
                  <td>{TYPES.find((t) => t.value === c.type)?.label}</td>
                  <td className="small secondary mono ellipsis" style={{ maxWidth: 280 }}>{c.type === 'email' ? c.config.to : c.type === 'webhook' ? c.config.url : 'webhook (hidden)'}</td>
                  <td>{c.enabled ? <span className="badge up">Enabled</span> : <span className="badge">Disabled</span>}</td>
                  <td className="nowrap" style={{ textAlign: 'right' }}>
                    {can('editor') && <>
                      <Button size="sm" icon={Send} disabled={testing === c.id} onClick={() => test(c)}>{testing === c.id ? 'Sending…' : 'Send test'}</Button>
                      <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(c)} aria-label="Edit" />
                      <Button size="sm" variant="ghost" icon={Trash2} onClick={() => remove(c)} aria-label="Delete" />
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {editing && <ChannelForm channel={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload(); toast('Channel saved'); }} />}
    </div>
  );
}
