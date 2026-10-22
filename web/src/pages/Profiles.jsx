import { useState } from 'react';
import { Plus, Pencil, Trash2, Lock } from 'lucide-react';
import { get, post, put, del } from '../api.js';
import { useStore } from '../store.jsx';
import { Card, Button, Modal, Field, Input, NumberInput, ErrorBox, useAsync, useConfirm, useToast } from '../components/ui.jsx';
import { kbps } from '../format.js';

function ProfileForm({ profile, onClose, onSaved }) {
  const [p, setP] = useState(profile || { name: '', description: '', downloadKbps: 1000, uploadKbps: 500, latencyMs: 100, jitterMs: 0, packetLoss: 0 });
  const [error, setError] = useState(null);
  const set = (patch) => setP((x) => ({ ...x, ...patch }));
  const save = async () => {
    try { onSaved(profile?.id ? await put(`/profiles/${profile.id}`, p) : await post('/profiles', p)); } catch (e) { setError(e); }
  };
  return (
    <Modal title={profile?.id ? 'Edit network profile' : 'New network profile'} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
      <div className="col gap-lg">
        <Field label="Name"><Input value={p.name} onChange={(v) => set({ name: v })} placeholder="Rural India 3G" autoFocus /></Field>
        <div className="grid grid-2">
          <Field label="Download (kbps)" hint="0 = unlimited · 1000 kbps = 1 Mbps"><NumberInput value={p.downloadKbps} onChange={(v) => set({ downloadKbps: v })} min={0} /></Field>
          <Field label="Upload (kbps)" hint="0 = unlimited"><NumberInput value={p.uploadKbps} onChange={(v) => set({ uploadKbps: v })} min={0} /></Field>
          <Field label="Added latency – round trip (ms)"><NumberInput value={p.latencyMs} onChange={(v) => set({ latencyMs: v })} min={0} /></Field>
          <Field label="Jitter (ms)" hint="Random ± variation per packet"><NumberInput value={p.jitterMs} onChange={(v) => set({ jitterMs: v })} min={0} /></Field>
          <Field label="Packet loss (%)" hint="Lost segments add a retransmission delay"><NumberInput value={p.packetLoss} onChange={(v) => set({ packetLoss: v })} min={0} max={100} step="0.1" /></Field>
        </div>
        <Field label="Description"><Input value={p.description} onChange={(v) => set({ description: v })} /></Field>
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

export default function Profiles() {
  const { can, setProfiles } = useStore();
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const list = useAsync(() => get('/profiles'), []);
  const [editing, setEditing] = useState(null);
  const refresh = async () => { const l = await list.reload(); if (l) setProfiles(l); };
  const remove = async (p) => {
    if (!(await confirm({ title: 'Delete profile?', message: `"${p.name}" will be deleted.`, danger: true, confirmLabel: 'Delete' }))) return;
    try { await del(`/profiles/${p.id}`); refresh(); } catch (e) { toast(e.message, 'error'); }
  };

  return (
    <div>
      {confirmNode}
      <div className="page-head">
        <div><h1>Network profiles</h1><div className="sub">Simulate real-world connections so tests reflect what users actually experience.</div></div>
        {can('editor') && <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>New profile</Button>}
      </div>
      <Card pad={false}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Profile</th><th>Download</th><th>Upload</th><th className="num">Latency (RTT)</th><th className="num">Jitter</th><th className="num">Packet loss</th><th /></tr></thead>
            <tbody>
              {(list.data || []).map((p) => (
                <tr key={p.id}>
                  <td><strong>{p.name}</strong> {p.builtin && <span className="tag" title="Built-in preset"><Lock size={10} /> preset</span>}<div className="small muted">{p.description}</div></td>
                  <td>{kbps(p.downloadKbps)}</td><td>{kbps(p.uploadKbps)}</td>
                  <td className="num">{p.latencyMs} ms</td><td className="num">{p.jitterMs} ms</td><td className="num">{p.packetLoss}%</td>
                  <td className="nowrap" style={{ textAlign: 'right' }}>
                    {can('editor') && (p.builtin
                      ? <Button size="sm" variant="ghost" onClick={() => setEditing({ ...p, id: undefined, name: `${p.name} (custom)`, builtin: false })}>Duplicate</Button>
                      : <><Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(p)} aria-label="Edit" /><Button size="sm" variant="ghost" icon={Trash2} onClick={() => remove(p)} aria-label="Delete" /></>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <div className="small muted mt">
        How the simulation works: each connection is routed through an in-process throttle. Bandwidth limits both request and response bytes,
        latency is added as a round-trip delay to the TCP handshake, TLS handshake and every response, and lost packets add a TCP retransmission
        delay (at least 200 ms). DNS lookups pay one round trip.
      </div>
      {editing && <ProfileForm profile={editing.id || editing.name ? editing : null} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); toast('Profile saved'); }} />}
    </div>
  );
}
