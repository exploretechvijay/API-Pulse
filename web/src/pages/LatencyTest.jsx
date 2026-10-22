import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, Save } from 'lucide-react';
import { post } from '../api.js';
import { useStore } from '../store.jsx';
import { Button, Card, Field, NumberInput, Input, Check, ErrorBox } from '../components/ui.jsx';
import RequestEditor from '../components/RequestEditor.jsx';
import SavedTests, { SaveTestModal } from '../components/SavedTests.jsx';
import { kbps } from '../format.js';

const blank = {
  request: { method: 'GET', url: '', headers: [], query: [], bodyType: 'none', body: '' },
  auth: { type: 'none' }, count: 20, delayMs: 0, timeoutMs: 30000, keepAlive: false, successStatus: '200-399', profileIds: [],
};

export function ProfileChooser({ profiles, value, onChange, multi = true }) {
  return (
    <div className="grid grid-3" style={{ gap: 8 }}>
      {profiles.map((p) => {
        const on = multi ? value.includes(p.id) : value === p.id;
        return (
          <label key={p.id} className="card" style={{ padding: '8px 10px', cursor: 'pointer', borderColor: on ? 'var(--accent)' : undefined, background: on ? 'var(--accent-soft)' : undefined }}>
            <div className="row">
              <input type={multi ? 'checkbox' : 'radio'} checked={on} name="profile"
                onChange={() => onChange(multi ? (on ? value.filter((x) => x !== p.id) : [...value, p.id]) : p.id)} />
              <strong className="small">{p.name}</strong>
            </div>
            <div className="small muted" style={{ marginLeft: 22 }}>
              {p.name === 'No throttling' ? 'Real connection' : `↓${kbps(p.downloadKbps)} ↑${kbps(p.uploadKbps)} · ${p.latencyMs} ms${p.packetLoss ? ` · ${p.packetLoss}% loss` : ''}`}
            </div>
          </label>
        );
      })}
    </div>
  );
}

export default function LatencyTest() {
  const nav = useNavigate();
  const { profiles, can } = useStore();
  const [cfg, setCfg] = useState(blank);
  const [template, setTemplate] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const set = (patch) => setCfg((c) => ({ ...c, ...patch }));
  const noThrottle = profiles.find((p) => p.name === 'No throttling');
  const ids = cfg.profileIds.length ? cfg.profileIds : noThrottle ? [noThrottle.id] : [];

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post('/tests/run', { kind: 'latency', config: { ...cfg, profileIds: ids }, name: template?.name });
      nav(`/runs/${r.id}`);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  return (
    <div>
      <div className="page-head">
        <div><h1>Latency test</h1><div className="sub">Send requests to one endpoint and see how long each phase takes – on real or simulated networks.</div></div>
        {can('editor') && (
          <div className="row">
            <Button icon={Save} onClick={() => setSaving(true)} disabled={!cfg.request.url}>{template ? 'Update saved test' : 'Save as test'}</Button>
            <Button variant="primary" icon={Play} onClick={run} disabled={busy || !cfg.request.url}>{busy ? 'Starting…' : 'Run test'}</Button>
          </div>
        )}
      </div>
      {template && <div className="info-box" style={{ marginBottom: 16 }}>Editing saved test <strong>{template.name}</strong>. <a href="#new" onClick={(e) => { e.preventDefault(); setTemplate(null); setCfg(blank); }}>Start a new test instead</a></div>}
      <ErrorBox error={error} />
      <div className="stack mt">
        <Card title="Request"><RequestEditor request={cfg.request} auth={cfg.auth} onChange={(v) => set(v)} /></Card>
        <Card title="Network profiles" actions={<span className="small muted">Pick several to compare them side by side</span>}>
          <ProfileChooser profiles={profiles} value={ids} onChange={(v) => set({ profileIds: v })} />
        </Card>
        <Card title="Options">
          <div className="form-grid">
            <Field label="Number of requests" hint="1 – 10,000 per profile"><NumberInput value={cfg.count} onChange={(v) => set({ count: v })} min={1} max={10000} /></Field>
            <Field label="Delay between requests (ms)"><NumberInput value={cfg.delayMs} onChange={(v) => set({ delayMs: v })} min={0} /></Field>
            <Field label="Timeout (ms)"><NumberInput value={cfg.timeoutMs} onChange={(v) => set({ timeoutMs: v })} min={100} /></Field>
            <Field label="Success status codes"><Input className="mono" value={cfg.successStatus} onChange={(v) => set({ successStatus: v })} /></Field>
          </div>
          <div className="mt"><Check checked={cfg.keepAlive} onChange={(v) => set({ keepAlive: v })} label="Reuse connections (keep-alive) – off measures DNS/TCP/TLS on every request" /></div>
        </Card>
        <SavedTests kind="latency" reloadKey={reloadKey} onLoad={(t) => { setTemplate(t); setCfg({ ...blank, ...t.config }); window.scrollTo(0, 0); }} />
      </div>
      {saving && <SaveTestModal kind="latency" config={{ ...cfg, profileIds: ids }} template={template} onClose={() => setSaving(false)}
        onSaved={(t) => { setSaving(false); setTemplate(t); setReloadKey((k) => k + 1); }} />}
    </div>
  );
}
