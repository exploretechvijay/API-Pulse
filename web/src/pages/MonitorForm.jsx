import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, FlaskConical } from 'lucide-react';
import { get, post, put } from '../api.js';
import { useStore } from '../store.jsx';
import { Button, Card, Field, Input, NumberInput, Select, Check, ErrorBox, useToast, StatusBadge } from '../components/ui.jsx';
import RequestEditor from '../components/RequestEditor.jsx';
import { ms } from '../format.js';

const blank = {
  name: '', description: '', environment: '', project: '', tags: [],
  request: { method: 'GET', url: '', headers: [], query: [], bodyType: 'none', body: '' },
  auth: { type: 'none' },
  intervalSec: null, timeoutMs: null, failureThreshold: null,
  rules: { expectedStatus: '200-299', degradedMs: null, bodyContains: '', jsonPath: '', jsonOperator: 'equals', jsonExpected: '' },
  networkProfileId: null,
  alerts: { onDown: true, onDegraded: false, onRecovery: true, channelIds: [], reminderMinutes: 0, escalateAfterMinutes: 0, escalationChannelIds: [] },
  showOnStatusPage: false, paused: false,
};

function ChannelPicker({ channels, value, onChange }) {
  if (!channels.length) return <div className="small muted">No channels yet – <Link to="/channels">add Slack, Teams, email or webhook</Link>.</div>;
  return (
    <div className="row wrap" style={{ gap: 14 }}>
      {channels.map((c) => (
        <Check key={c.id} checked={value.includes(c.id)} label={`${c.name} (${c.type})`}
          onChange={(on) => onChange(on ? [...value, c.id] : value.filter((x) => x !== c.id))} />
      ))}
    </div>
  );
}

export default function MonitorForm() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { profiles } = useStore();
  const [m, setM] = useState(id ? null : blank);
  const [channels, setChannels] = useState([]);
  const [defaults, setDefaults] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    get('/channels').then((cs) => {
      setChannels(cs);
      if (!id) setM((x) => ({ ...x, alerts: { ...x.alerts, channelIds: cs.filter((c) => c.isDefault).map((c) => c.id) } }));
    });
    get('/settings').then((s) => setDefaults(s.defaults));
    if (id) get(`/monitors/${id}`).then((x) => setM({ ...blank, ...x, rules: { ...blank.rules, ...x.rules }, alerts: { ...blank.alerts, ...x.alerts } })).catch(setError);
  }, [id]);

  if (!m) return error ? <ErrorBox error={error} /> : <div className="muted">Loading…</div>;
  const set = (patch) => setM((x) => ({ ...x, ...patch }));
  const setRules = (patch) => setM((x) => ({ ...x, rules: { ...x.rules, ...patch } }));
  const setAlerts = (patch) => setM((x) => ({ ...x, alerts: { ...x.alerts, ...patch } }));

  const save = async (e) => {
    e?.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const out = id ? await put(`/monitors/${id}`, m) : await post('/monitors', m);
      toast(id ? 'Monitor saved' : 'Monitor created – first check is running');
      nav(`/monitors/${out.id}`);
    } catch (err) { setError(err); } finally { setSaving(false); }
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try { setTest(await post('/monitors/test', { ...m, id: id ? Number(id) : undefined })); } catch (err) { setTest({ result: 'fail', error: err.message }); } finally { setTesting(false); }
  };

  return (
    <form onSubmit={save}>
      <div className="page-head">
        <div>
          <Link to={id ? `/monitors/${id}` : '/'} className="small row"><ArrowLeft size={14} /> Back</Link>
          <h1 className="mt-s">{id ? `Edit ${m.name}` : 'New monitor'}</h1>
        </div>
        <div className="row">
          <Button icon={FlaskConical} onClick={runTest} disabled={testing || !m.request.url}>{testing ? 'Testing…' : 'Test request'}</Button>
          <button type="submit" className="btn primary" disabled={saving}>{saving ? 'Saving…' : id ? 'Save changes' : 'Create monitor'}</button>
        </div>
      </div>
      <ErrorBox error={error} />

      <div className="stack mt">
        <Card title="Endpoint">
          <div className="form-grid" style={{ marginBottom: 16 }}>
            <Field label="Name"><Input value={m.name} onChange={(v) => set({ name: v })} placeholder="Payments API – health" required autoFocus={!id} /></Field>
            <Field label="Environment"><Input value={m.environment} onChange={(v) => set({ environment: v })} placeholder="production" list="envs" /></Field>
            <Field label="Project"><Input value={m.project} onChange={(v) => set({ project: v })} placeholder="checkout" /></Field>
            <Field label="Tags" hint="Comma separated"><Input value={Array.isArray(m.tags) ? m.tags.join(', ') : m.tags} onChange={(v) => set({ tags: v.split(',').map((t) => t.trim()).filter(Boolean) })} placeholder="payments, critical" /></Field>
          </div>
          <datalist id="envs"><option value="production" /><option value="staging" /><option value="dev" /></datalist>
          <RequestEditor request={m.request} auth={m.auth} onChange={({ request, auth }) => set({ request, auth })} />
          {test && (
            <div className="mt">
              <div className={test.result === 'ok' ? 'ok-box' : test.result === 'slow' ? 'warn-box' : 'error-box'}>
                <div className="row wrap">
                  <StatusBadge state={test.result === 'ok' ? 'up' : test.result === 'slow' ? 'degraded' : 'down'} />
                  {test.status ? <strong>HTTP {test.status}</strong> : null}
                  {test.timings && <span>{ms(test.timings.total)} (DNS {ms(test.timings.dns)} · TCP {ms(test.timings.tcp)} · TLS {ms(test.timings.tls)} · TTFB {ms(test.timings.ttfb)})</span>}
                </div>
                {test.error && <div className="mt-s">{test.error}</div>}
              </div>
              {test.body && <details className="mt-s"><summary className="small">Response body</summary><div className="pre mt-s">{test.body}</div></details>}
            </div>
          )}
        </Card>

        <Card title="Schedule & success rules">
          <div className="form-grid">
            <Field label="Check interval (seconds)" hint={`10 s – 24 h. Default ${defaults?.intervalSec ?? 60}`}>
              <NumberInput value={m.intervalSec} onChange={(v) => set({ intervalSec: v })} min={10} max={86400} placeholder={String(defaults?.intervalSec ?? 60)} />
            </Field>
            <Field label="Timeout (ms)" hint={`Default ${defaults?.timeoutMs ?? 10000}`}>
              <NumberInput value={m.timeoutMs} onChange={(v) => set({ timeoutMs: v })} min={100} placeholder={String(defaults?.timeoutMs ?? 10000)} />
            </Field>
            <Field label="Down after N consecutive failures" hint={`Avoids false alarms. Default ${defaults?.failureThreshold ?? 3}`}>
              <NumberInput value={m.failureThreshold} onChange={(v) => set({ failureThreshold: v })} min={1} max={100} placeholder={String(defaults?.failureThreshold ?? 3)} />
            </Field>
            <Field label="Expected status code(s)" hint="e.g. 200-299, 301, 4xx">
              <Input className="mono" value={m.rules.expectedStatus} onChange={(v) => setRules({ expectedStatus: v })} />
            </Field>
            <Field label="Degraded above (ms)" hint="Correct but slower than this = Degraded">
              <NumberInput value={m.rules.degradedMs} onChange={(v) => setRules({ degradedMs: v })} min={1} placeholder={defaults?.degradedMs ? String(defaults.degradedMs) : 'off'} />
            </Field>
            <Field label="Body must contain" hint="Plain text match (optional)">
              <Input value={m.rules.bodyContains} onChange={(v) => setRules({ bodyContains: v })} placeholder='"status":"ok"' />
            </Field>
          </div>
          <div className="form-grid mt">
            <Field label="JSON field (optional)" hint="Path like data.status or items[0].id">
              <Input className="mono" value={m.rules.jsonPath} onChange={(v) => setRules({ jsonPath: v })} placeholder="status" />
            </Field>
            {m.rules.jsonPath && <>
              <Field label="Condition">
                <Select value={m.rules.jsonOperator} onChange={(v) => setRules({ jsonOperator: v })} options={[
                  { value: 'equals', label: 'equals' }, { value: 'notEquals', label: 'does not equal' }, { value: 'contains', label: 'contains' }, { value: 'exists', label: 'exists' }]} />
              </Field>
              {m.rules.jsonOperator !== 'exists' && <Field label="Expected value"><Input className="mono" value={m.rules.jsonExpected} onChange={(v) => setRules({ jsonExpected: v })} placeholder="ok" /></Field>}
            </>}
            <Field label="Network profile" hint="Run checks through a simulated network (optional)">
              <Select value={m.networkProfileId ?? ''} onChange={(v) => set({ networkProfileId: v ? Number(v) : null })}
                options={profiles.map((p) => ({ value: p.name === 'No throttling' ? '' : p.id, label: p.name }))} />
            </Field>
          </div>
        </Card>

        <Card title="Alerts">
          <div className="row wrap" style={{ gap: 20 }}>
            <Check checked={m.alerts.onDown} onChange={(v) => setAlerts({ onDown: v })} label="Alert when Down" />
            <Check checked={m.alerts.onDegraded} onChange={(v) => setAlerts({ onDegraded: v })} label="Alert when Degraded" />
            <Check checked={m.alerts.onRecovery} onChange={(v) => setAlerts({ onRecovery: v })} label="Send recovery notice" />
          </div>
          <div className="mt">
            <div className="label" style={{ marginBottom: 8 }}>Notify these channels</div>
            <ChannelPicker channels={channels} value={m.alerts.channelIds} onChange={(v) => setAlerts({ channelIds: v })} />
          </div>
          <div className="form-grid mt">
            <Field label="Remind every (minutes)" hint="While still down and not acknowledged. 0 = off">
              <NumberInput value={m.alerts.reminderMinutes} onChange={(v) => setAlerts({ reminderMinutes: v ?? 0 })} min={0} />
            </Field>
            <Field label="Escalate after (minutes)" hint="If not acknowledged. 0 = off">
              <NumberInput value={m.alerts.escalateAfterMinutes} onChange={(v) => setAlerts({ escalateAfterMinutes: v ?? 0 })} min={0} />
            </Field>
          </div>
          {m.alerts.escalateAfterMinutes > 0 && (
            <div className="mt">
              <div className="label" style={{ marginBottom: 8 }}>Escalation channels</div>
              <ChannelPicker channels={channels} value={m.alerts.escalationChannelIds} onChange={(v) => setAlerts({ escalationChannelIds: v })} />
            </div>
          )}
        </Card>

        <Card title="Other">
          <div className="col">
            <Check checked={m.showOnStatusPage} onChange={(v) => set({ showOnStatusPage: v })} label="Show on the public status page" />
            <Check checked={m.paused} onChange={(v) => set({ paused: v })} label="Paused (no checks, no alerts)" />
            <Field label="Description" className="mt-s"><Input value={m.description} onChange={(v) => set({ description: v })} placeholder="What this endpoint does, who owns it…" /></Field>
          </div>
        </Card>
      </div>
    </form>
  );
}
