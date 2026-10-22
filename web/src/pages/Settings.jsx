import { useEffect, useState } from 'react';
import { Download, Upload, Plus, Trash2, Copy } from 'lucide-react';
import { get, put, post, del, api } from '../api.js';
import { useStore } from '../store.jsx';
import { Card, Button, Field, Input, NumberInput, Select, Check, Tabs, Textarea, ErrorBox, Modal, Segmented, useAsync, useToast, useConfirm } from '../components/ui.jsx';
import { dateTime, ago } from '../format.js';

function General({ settings, onSave, readOnly }) {
  const [d, setD] = useState(settings.defaults);
  const [r, setR] = useState(settings.retention);
  return (
    <div className="stack">
      <Card title="Monitor defaults" actions={<span className="small muted">Individual monitors can override these</span>}>
        <div className="form-grid">
          <Field label="Check interval (s)"><NumberInput value={d.intervalSec} onChange={(v) => setD({ ...d, intervalSec: v })} min={10} disabled={readOnly} /></Field>
          <Field label="Timeout (ms)"><NumberInput value={d.timeoutMs} onChange={(v) => setD({ ...d, timeoutMs: v })} disabled={readOnly} /></Field>
          <Field label="Failure threshold"><NumberInput value={d.failureThreshold} onChange={(v) => setD({ ...d, failureThreshold: v })} min={1} disabled={readOnly} /></Field>
          <Field label="Degraded above (ms)" hint="Empty = off"><NumberInput value={d.degradedMs} onChange={(v) => setD({ ...d, degradedMs: v })} disabled={readOnly} /></Field>
        </div>
      </Card>
      <Card title="Data retention">
        <div className="form-grid">
          <Field label="Raw checks (days)"><NumberInput value={r.rawDays} onChange={(v) => setR({ ...r, rawDays: v })} min={1} disabled={readOnly} /></Field>
          <Field label="Hourly rollups (days)"><NumberInput value={r.rollupDays} onChange={(v) => setR({ ...r, rollupDays: v })} min={1} disabled={readOnly} /></Field>
          <Field label="Test runs (days)"><NumberInput value={r.runDays} onChange={(v) => setR({ ...r, runDays: v })} min={1} disabled={readOnly} /></Field>
        </div>
      </Card>
      {!readOnly && <Button variant="primary" onClick={() => onSave({ defaults: d, retention: r })}>Save</Button>}
    </div>
  );
}

function Allowlist({ settings, onSave, readOnly }) {
  const [text, setText] = useState(settings.loadAllowlist.join('\n'));
  return (
    <Card title="Load-test allow-list">
      <p className="secondary" style={{ marginTop: 0 }}>Load, stress, spike and soak tests are refused for any host not listed here – this prevents accidental attacks on third-party APIs.
        One entry per line: <code>api.example.com</code>, <code>*.staging.example.com</code>, <code>localhost:3000</code>.</p>
      <Textarea rows={8} value={text} onChange={setText} disabled={readOnly} />
      {readOnly ? <div className="small muted mt-s">Only admins can change the allow-list.</div>
        : <Button className="mt" variant="primary" onClick={() => onSave({ loadAllowlist: text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) })}>Save allow-list</Button>}
    </Card>
  );
}

function StatusPageSettings({ settings, onSave, readOnly }) {
  const [sp, setSp] = useState(settings.statusPage);
  return (
    <Card title="Public status page">
      <div className="col gap-lg">
        <Check checked={sp.enabled} onChange={(v) => setSp({ ...sp, enabled: v })} label="Enable the read-only status page" disabled={readOnly} />
        <Field label="Title"><Input value={sp.title} onChange={(v) => setSp({ ...sp, title: v })} disabled={readOnly} /></Field>
        <div className="small secondary">Available at <a href="/status" target="_blank" rel="noreferrer">{window.location.origin}/status</a> without login.
          Only monitors with “Show on the public status page” are listed.</div>
        {!readOnly && <div><Button variant="primary" onClick={() => onSave({ statusPage: sp })}>Save</Button></div>}
      </div>
    </Card>
  );
}

function ImportExport() {
  const { can, refresh } = useStore();
  const toast = useToast();
  const [format, setFormat] = useState('yaml');
  const [secrets, setSecrets] = useState(false);
  const [text, setText] = useState('');
  const [mode, setMode] = useState('merge');
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const doImport = async () => {
    setError(null);
    try {
      const r = await api(`/config/import?mode=${mode}`, { method: 'POST', body: text });
      setReport(r);
      refresh();
      toast('Configuration imported');
    } catch (e) { setError(e); }
  };
  return (
    <div className="stack">
      <Card title="Export configuration">
        <p className="secondary" style={{ marginTop: 0 }}>Monitors, channels, network profiles, maintenance windows, saved tests, variables and settings – ready to commit to Git.</p>
        <div className="row wrap">
          <Segmented value={format} onChange={setFormat} options={[{ value: 'yaml', label: 'YAML' }, { value: 'json', label: 'JSON' }]} />
          {can('admin') && <Check checked={secrets} onChange={setSecrets} label="Include secrets (plain text!)" />}
          <a className="btn primary" href={`/api/config/export?format=${format}${secrets ? '&secrets=true' : ''}`}><Download size={16} /> Download</a>
        </div>
      </Card>
      {can('admin') && (
        <Card title="Import configuration">
          <div className="row wrap" style={{ marginBottom: 10 }}>
            <label className="btn sm"><Upload size={14} /> Choose file<input type="file" accept=".yaml,.yml,.json" hidden onChange={(e) => {
              const f = e.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => setText(String(rd.result)); rd.readAsText(f);
            }} /></label>
            <Select value={mode} onChange={setMode} style={{ width: 'auto' }} options={[
              { value: 'merge', label: 'Merge – add & update by name' }, { value: 'replace', label: 'Replace – also delete items not in the file' }]} />
          </div>
          <Textarea rows={10} value={text} onChange={setText} placeholder="Paste YAML or JSON here" />
          {mode === 'replace' && <div className="warn-box mt-s">Replace deletes monitors, channels, windows, saved tests and custom profiles that are not in the file.</div>}
          <Button className="mt" variant="primary" disabled={!text.trim()} onClick={doImport}>Import</Button>
          <ErrorBox error={error} />
          {report && (
            <div className="mt small">
              <div className="ok-box">Created {report.created.length} · updated {report.updated.length} · deleted {report.deleted.length}</div>
              {report.warnings.map((w) => <div key={w} className="warn-box mt-s">{w}</div>)}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function Users() {
  const { user } = useStore();
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const list = useAsync(() => get('/users'), []);
  const [adding, setAdding] = useState(null);
  const [error, setError] = useState(null);
  const update = async (u, patch) => {
    try { await put(`/users/${u.id}`, patch); list.reload(); toast('User updated'); } catch (e) { toast(e.message, 'error'); }
  };
  const add = async () => {
    try { await post('/users', adding); setAdding(null); list.reload(); toast('User created'); } catch (e) { setError(e); }
  };
  const resetPw = async (u) => {
    const pw = window.prompt(`New password for ${u.email} (min 8 characters)`);
    if (pw) update(u, { password: pw });
  };
  return (
    <Card title="Users" pad={false} actions={<Button size="sm" variant="primary" icon={Plus} onClick={() => { setError(null); setAdding({ email: '', name: '', password: '', role: 'viewer' }); }}>Add user</Button>}>
      {confirmNode}
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>User</th><th>Role</th><th>Last login</th><th>Status</th><th /></tr></thead>
          <tbody>
            {(list.data || []).map((u) => (
              <tr key={u.id}>
                <td><strong>{u.name || u.email}</strong><div className="small muted">{u.email}</div></td>
                <td>
                  <Select value={u.role} disabled={u.id === user.id} onChange={(v) => update(u, { role: v })} style={{ width: 'auto' }}
                    options={[{ value: 'admin', label: 'Admin' }, { value: 'editor', label: 'Editor' }, { value: 'viewer', label: 'Viewer' }]} />
                </td>
                <td className="small">{u.lastLoginAt ? ago(u.lastLoginAt) : 'never'}</td>
                <td>{u.disabled ? <span className="badge down">Disabled</span> : <span className="badge up">Active</span>}</td>
                <td className="nowrap" style={{ textAlign: 'right' }}>
                  {u.id !== user.id && <>
                    <Button size="sm" variant="ghost" onClick={() => resetPw(u)}>Reset password</Button>
                    <Button size="sm" variant="ghost" onClick={() => update(u, { disabled: !u.disabled })}>{u.disabled ? 'Enable' : 'Disable'}</Button>
                    <Button size="sm" variant="ghost" icon={Trash2} aria-label="Delete" onClick={async () => {
                      if (await confirm({ title: 'Delete user?', message: u.email, danger: true, confirmLabel: 'Delete' })) { await del(`/users/${u.id}`); list.reload(); }
                    }} />
                  </>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card-body small muted">Admin: everything incl. users, settings and allow-list · Editor: create/edit monitors, tests, channels; run tests; acknowledge alerts · Viewer: read-only.</div>
      {adding && (
        <Modal title="Add user" onClose={() => setAdding(null)} footer={<><Button onClick={() => setAdding(null)}>Cancel</Button><Button variant="primary" onClick={add}>Create</Button></>}>
          <div className="col gap-lg">
            <Field label="Email"><Input type="email" value={adding.email} onChange={(v) => setAdding({ ...adding, email: v })} autoFocus /></Field>
            <Field label="Name"><Input value={adding.name} onChange={(v) => setAdding({ ...adding, name: v })} /></Field>
            <Field label="Initial password" hint="At least 8 characters"><Input type="password" value={adding.password} onChange={(v) => setAdding({ ...adding, password: v })} autoComplete="new-password" /></Field>
            <Field label="Role"><Select value={adding.role} onChange={(v) => setAdding({ ...adding, role: v })} options={[{ value: 'viewer', label: 'Viewer' }, { value: 'editor', label: 'Editor' }, { value: 'admin', label: 'Admin' }]} /></Field>
            <ErrorBox error={error} />
          </div>
        </Modal>
      )}
    </Card>
  );
}

function Tokens() {
  const toast = useToast();
  const list = useAsync(() => get('/tokens'), []);
  const [name, setName] = useState('');
  const [created, setCreated] = useState(null);
  const create = async () => {
    try { const t = await post('/tokens', { name }); setCreated(t.token); setName(''); list.reload(); } catch (e) { toast(e.message, 'error'); }
  };
  const origin = window.location.origin;
  return (
    <div className="stack">
      <Card title="API tokens">
        <p className="secondary" style={{ marginTop: 0 }}>Use a token to call the REST API from CI/CD. A token has the same role as your account.</p>
        <div className="row"><Input value={name} onChange={setName} placeholder="Token name, e.g. GitHub Actions" /><Button variant="primary" disabled={!name} onClick={create}>Create token</Button></div>
        {created && (
          <div className="ok-box mt">
            Copy this token now – it will not be shown again:
            <div className="row mt-s"><code className="pre grow" style={{ margin: 0 }}>{created}</code>
              <Button icon={Copy} onClick={() => { navigator.clipboard?.writeText(created); toast('Copied'); }} aria-label="Copy" /></div>
          </div>
        )}
        <table className="table mt">
          <thead><tr><th>Name</th><th>Token</th><th>Created</th><th>Last used</th><th /></tr></thead>
          <tbody>{(list.data || []).map((t) => (
            <tr key={t.id}><td>{t.name}</td><td className="mono">{t.prefix}…</td><td className="small">{dateTime(t.createdAt)}</td><td className="small">{t.lastUsedAt ? ago(t.lastUsedAt) : 'never'}</td>
              <td style={{ textAlign: 'right' }}><Button size="sm" variant="ghost" icon={Trash2} aria-label="Revoke" onClick={async () => { await del(`/tokens/${t.id}`); list.reload(); }} /></td></tr>
          ))}</tbody>
        </table>
      </Card>
      <Card title="Running tests from CI/CD">
        <p className="secondary" style={{ marginTop: 0 }}>Save a test with pass criteria, then run it by ID and fail the pipeline when <code>passed</code> is false:</p>
        <div className="pre">{`RESULT=$(curl -sf -X POST "${origin}/api/templates/<TEST_ID>/run?wait=true" \\
  -H "Authorization: Bearer $API_PULSE_TOKEN" \\
  -H "Content-Type: application/json" -d '{"confirm": true}')
echo "$RESULT" | jq '.summary.criteria'
test "$(echo "$RESULT" | jq -r '.passed')" = "true"`}</div>
        <p className="small muted">Load tests still require the target to be on the allow-list. Without <code>?wait=true</code> the call returns immediately with the run ID; poll <code>GET /api/runs/&lt;id&gt;</code>.</p>
      </Card>
    </div>
  );
}

function Account() {
  const toast = useToast();
  const [f, setF] = useState({ currentPassword: '', newPassword: '' });
  const [error, setError] = useState(null);
  const save = async () => {
    setError(null);
    try { await post('/auth/password', f); setF({ currentPassword: '', newPassword: '' }); toast('Password changed'); } catch (e) { setError(e); }
  };
  return (
    <Card title="Change password">
      <div className="col gap-lg" style={{ maxWidth: 360 }}>
        <Field label="Current password"><Input type="password" value={f.currentPassword} onChange={(v) => setF({ ...f, currentPassword: v })} autoComplete="current-password" /></Field>
        <Field label="New password"><Input type="password" value={f.newPassword} onChange={(v) => setF({ ...f, newPassword: v })} autoComplete="new-password" /></Field>
        <ErrorBox error={error} />
        <div><Button variant="primary" onClick={save}>Change password</Button></div>
      </div>
    </Card>
  );
}

function SystemInfo() {
  const sys = useAsync(() => get('/system'), []);
  if (!sys.data) return null;
  const s = sys.data;
  return (
    <Card title="System">
      <div className="kpis">
        <div className="kpi"><div className="k">Version</div><div className="v" style={{ fontSize: 18 }}>{s.version}</div></div>
        <div className="kpi"><div className="k">Uptime</div><div className="v" style={{ fontSize: 18 }}>{Math.round(s.uptimeSec / 3600)} h</div></div>
        <div className="kpi"><div className="k">CPU</div><div className="v" style={{ fontSize: 18 }}>{s.cpuPercent}%</div><div className="s">{s.cpuCount} cores</div></div>
        <div className="kpi"><div className="k">Memory</div><div className="v" style={{ fontSize: 18 }}>{s.memoryMb} MB</div></div>
        <div className="kpi"><div className="k">Monitors</div><div className="v" style={{ fontSize: 18 }}>{s.scheduled}/{s.monitors}</div><div className="s">scheduled / total</div></div>
      </div>
      <div className="small muted mt">Data directory: <code>{s.dataDir}</code> – back up this folder (database + encryption key).</div>
    </Card>
  );
}

export default function Settings() {
  const { can } = useStore();
  const toast = useToast();
  const [tab, setTab] = useState('general');
  const [settings, setSettings] = useState(null);
  useEffect(() => { get('/settings').then(setSettings); }, []);
  const save = async (patch) => {
    try { setSettings(await put('/settings', patch)); toast('Settings saved'); } catch (e) { toast(e.message, 'error'); }
  };
  const readOnly = !can('admin');
  const tabs = [
    { value: 'general', label: 'General' },
    { value: 'allowlist', label: 'Load-test allow-list' },
    { value: 'status', label: 'Status page' },
    ...(can('editor') ? [{ value: 'config', label: 'Import / export' }] : []),
    ...(can('admin') ? [{ value: 'users', label: 'Users' }] : []),
    { value: 'tokens', label: 'API tokens & CI' },
    { value: 'account', label: 'My account' },
  ];
  return (
    <div>
      <div className="page-head"><div><h1>Settings</h1>{readOnly && <div className="sub">Some settings can only be changed by an admin.</div>}</div></div>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {settings && tab === 'general' && <div className="stack"><General settings={settings} onSave={save} readOnly={readOnly} /><SystemInfo /></div>}
      {settings && tab === 'allowlist' && <Allowlist settings={settings} onSave={save} readOnly={readOnly} />}
      {settings && tab === 'status' && <StatusPageSettings settings={settings} onSave={save} readOnly={readOnly} />}
      {tab === 'config' && <ImportExport />}
      {tab === 'users' && <Users />}
      {tab === 'tokens' && <Tokens />}
      {tab === 'account' && <Account />}
    </div>
  );
}
