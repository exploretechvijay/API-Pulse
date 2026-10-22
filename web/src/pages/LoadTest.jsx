import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, Save, Plus, Trash2, ShieldAlert, Upload, ArrowUp, ArrowDown } from 'lucide-react';
import { post } from '../api.js';
import { useStore } from '../store.jsx';
import { Button, Card, Field, NumberInput, Input, Select, Check, ErrorBox, Segmented, Modal, Textarea } from '../components/ui.jsx';
import RequestEditor from '../components/RequestEditor.jsx';
import SavedTests, { SaveTestModal } from '../components/SavedTests.jsx';
import { duration } from '../format.js';

const MODES = [
  { value: 'fixed', label: 'Fixed', help: 'Hold a constant load for a set time – check the API meets its SLA.' },
  { value: 'ramp', label: 'Ramp-up', help: 'Increase load in steps from a start value to a target – see how latency grows with traffic.' },
  { value: 'stress', label: 'Stress', help: 'Keep increasing load until a stop condition is hit – find the breaking point and max throughput.' },
  { value: 'spike', label: 'Spike', help: 'Jump suddenly from low to very high load, then back – test behaviour under bursts and recovery.' },
  { value: 'soak', label: 'Soak', help: 'Hold moderate load for hours – catch memory leaks and slow degradation.' },
];

const newStep = (i) => ({ name: `Step ${i + 1}`, request: { method: 'GET', url: '', headers: [], query: [], bodyType: 'none', body: '' }, auth: { type: 'none' }, expectStatus: '', extract: [] });

const blank = {
  mode: 'fixed', loadType: 'vus', vus: 10, rps: 50, durationSec: 60, maxVus: 1000, thinkTimeMs: 0, timeoutMs: 30000, keepAlive: true,
  successStatus: '200-399', profileId: null, csv: '', csvMode: 'sequential',
  ramp: { start: 1, target: 50, step: 10, stepDurationSec: 30, holdSec: 30 },
  stress: { start: 10, step: 10, stepDurationSec: 20, max: 500, stopErrorRate: 5, stopP95Ms: null, stopOnPlateau: true, plateauPct: 5, plateauSteps: 2 },
  spike: { base: 5, peak: 100, baseDurationSec: 30, spikeDurationSec: 30, recoveryDurationSec: 60 },
  steps: [newStep(0)],
};

function StepEditor({ step, index, total, onChange, onRemove, onMove }) {
  const set = (patch) => onChange({ ...step, ...patch });
  return (
    <div className="step-card">
      <div className="row between" style={{ marginBottom: 12 }}>
        <div className="row grow">
          <span className="badge blue">{index + 1}</span>
          <input className="input" style={{ maxWidth: 260 }} value={step.name} onChange={(e) => set({ name: e.target.value })} aria-label="Step name" />
        </div>
        {total > 1 && <div className="row">
          <Button size="sm" variant="ghost" icon={ArrowUp} disabled={index === 0} onClick={() => onMove(-1)} aria-label="Move up" />
          <Button size="sm" variant="ghost" icon={ArrowDown} disabled={index === total - 1} onClick={() => onMove(1)} aria-label="Move down" />
          <Button size="sm" variant="ghost" icon={Trash2} onClick={onRemove} aria-label="Remove step" />
        </div>}
      </div>
      <RequestEditor compact request={step.request} auth={step.auth} onChange={({ request, auth }) => set({ request, auth })} />
      {total > 1 && (
        <div className="mt">
          <Field label="Expected status (optional)" hint="Overrides the test's success codes for this step" className="mt-s">
            <Input className="mono" value={step.expectStatus} onChange={(v) => set({ expectStatus: v })} placeholder="200-299" style={{ maxWidth: 220 }} />
          </Field>
          <div className="label mt">Save values from the response for later steps</div>
          {step.extract.map((ex, i) => (
            <div className="row mt-s" key={i}>
              <input className="input mono" style={{ maxWidth: 160 }} placeholder="variable" value={ex.var}
                onChange={(e) => set({ extract: step.extract.map((x, j) => (j === i ? { ...x, var: e.target.value } : x)) })} />
              <select className="input" style={{ maxWidth: 140 }} value={ex.source}
                onChange={(e) => set({ extract: step.extract.map((x, j) => (j === i ? { ...x, source: e.target.value } : x)) })}>
                <option value="json">JSON path</option><option value="header">Header</option><option value="regex">Regex</option>
              </select>
              <input className="input mono grow" placeholder={ex.source === 'json' ? 'data.token' : ex.source === 'header' ? 'x-request-id' : 'token=(\\w+)'} value={ex.path}
                onChange={(e) => set({ extract: step.extract.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)) })} />
              <Button variant="ghost" icon={Trash2} onClick={() => set({ extract: step.extract.filter((_, j) => j !== i) })} aria-label="Remove" />
            </div>
          ))}
          <Button size="sm" className="mt-s" icon={Plus} onClick={() => set({ extract: [...step.extract, { var: '', source: 'json', path: '' }] })}>Extract a value</Button>
          {step.extract.length > 0 && <div className="small muted mt-s">Use it in later steps as {'{{'}{step.extract[0].var || 'variable'}{'}}'}</div>}
        </div>
      )}
    </div>
  );
}

function ConfirmRun({ pf, cfg, onCancel, onConfirm, busy }) {
  const [ok, setOk] = useState(false);
  const est = pf.estimate?.durationSec ? `about ${duration(pf.estimate.durationSec * 1000)}` : pf.estimate?.maxDurationSec ? `up to ${duration(pf.estimate.maxDurationSec * 1000)}` : '';
  return (
    <Modal title="Confirm load test" onClose={onCancel} footer={<>
      <Button onClick={onCancel}>Cancel</Button>
      <Button variant="danger solid" disabled={!pf.allowed || !ok || busy} onClick={onConfirm}>{busy ? 'Starting…' : 'Start load test'}</Button>
    </>}>
      <div className="col gap-lg">
        <div className="row top"><ShieldAlert size={20} color="var(--warning-ink)" />
          <div>This will send a large amount of traffic. Only test APIs you own or have permission to test.</div></div>
        <div>
          <div className="label">Target hosts</div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
            {pf.targets.map((h) => (
              <li key={h} className="mono">{h} {pf.notAllowed.includes(h) ? <span className="badge down">not on allow-list</span> : <span className="badge up">allowed</span>}
                {pf.productionHosts.includes(h) && <span className="badge degraded" style={{ marginLeft: 6 }}>production</span>}</li>
            ))}
          </ul>
        </div>
        {!pf.allowed && <div className="error-box">Load tests are refused for hosts that are not on the allow-list. An admin can add them under Settings → Load-test allow-list.</div>}
        {pf.productionHosts.length > 0 && <div className="warn-box"><strong>Production warning:</strong> {pf.productionHosts.join(', ')} looks like a production system (it is monitored as production or its name says so). Real users may be affected.</div>}
        <div className="small secondary">Mode <strong>{cfg.mode}</strong> · {cfg.loadType === 'rps' ? 'arrival rate' : 'virtual users'} · {est}</div>
        {pf.allowed && <Check checked={ok} onChange={setOk} label="I own this API or have permission to load test it" />}
      </div>
    </Modal>
  );
}

export default function LoadTest() {
  const nav = useNavigate();
  const { profiles, can } = useStore();
  const [cfg, setCfg] = useState(blank);
  const [template, setTemplate] = useState(null);
  const [pf, setPf] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const set = (patch) => setCfg((c) => ({ ...c, ...patch }));
  const sub = (key) => (patch) => setCfg((c) => ({ ...c, [key]: { ...c[key], ...patch } }));
  const unit = cfg.loadType === 'rps' ? 'req/s' : 'VUs';
  const csvCols = cfg.csv ? cfg.csv.split(/\r?\n/)[0].split(',').map((s) => s.trim().replace(/^"|"$/g, '')) : [];
  const csvRows = cfg.csv ? cfg.csv.split(/\r?\n/).filter((l) => l.trim()).length - 1 : 0;

  const start = async (c = cfg) => {
    setError(null);
    try { setPf({ ...(await post('/tests/preflight', { kind: 'load', config: c })), cfg: c }); } catch (e) { setError(e); }
  };
  const confirmRun = async () => {
    setBusy(true);
    try {
      const r = pf.templateId
        ? await post(`/templates/${pf.templateId}/run`, { confirm: true })
        : await post('/tests/run', { kind: 'load', config: pf.cfg, confirm: true, name: template?.name });
      nav(`/runs/${r.id}`);
    } catch (e) { setError(e); setPf(null); } finally { setBusy(false); }
  };
  const loadCsv = (file) => {
    const reader = new FileReader();
    reader.onload = () => set({ csv: String(reader.result) });
    reader.readAsText(file);
  };
  const moveStep = (i, d) => {
    const s = cfg.steps.slice();
    [s[i], s[i + d]] = [s[i + d], s[i]];
    set({ steps: s });
  };

  return (
    <div>
      <div className="page-head">
        <div><h1>Load test</h1><div className="sub">Measure throughput and find the breaking point – no scripting needed.</div></div>
        {can('editor') && (
          <div className="row">
            <Button icon={Save} onClick={() => setSaving(true)} disabled={!cfg.steps[0].request.url}>{template ? 'Update saved test' : 'Save as test'}</Button>
            <Button variant="primary" icon={Play} onClick={() => start()} disabled={!cfg.steps.every((s) => s.request.url)}>Run test…</Button>
          </div>
        )}
      </div>
      {template && <div className="info-box" style={{ marginBottom: 16 }}>Editing saved test <strong>{template.name}</strong>. <a href="#new" onClick={(e) => { e.preventDefault(); setTemplate(null); setCfg(blank); }}>Start a new test instead</a></div>}
      <ErrorBox error={error} />

      <div className="stack mt">
        <Card title="Load pattern">
          <Segmented value={cfg.mode} onChange={(v) => set({ mode: v })} options={MODES.map((m) => ({ value: m.value, label: m.label }))} />
          <p className="secondary small">{MODES.find((m) => m.value === cfg.mode).help}</p>
          <div className="row wrap" style={{ marginBottom: 14 }}>
            <span className="label">Load measured in</span>
            <Segmented value={cfg.loadType} onChange={(v) => set({ loadType: v })} options={[{ value: 'vus', label: 'Virtual users' }, { value: 'rps', label: 'Requests / second' }]} />
          </div>
          <div className="form-grid">
            {(cfg.mode === 'fixed' || cfg.mode === 'soak') && <>
              {cfg.loadType === 'vus'
                ? <Field label="Virtual users (concurrency)"><NumberInput value={cfg.vus} onChange={(v) => set({ vus: v })} min={1} /></Field>
                : <Field label="Target requests / second"><NumberInput value={cfg.rps} onChange={(v) => set({ rps: v })} min={1} /></Field>}
              <Field label="Duration (seconds)" hint={duration((cfg.durationSec || 0) * 1000)}><NumberInput value={cfg.durationSec} onChange={(v) => set({ durationSec: v })} min={1} /></Field>
            </>}
            {cfg.mode === 'ramp' && <>
              <Field label={`Start (${unit})`}><NumberInput value={cfg.ramp.start} onChange={(v) => sub('ramp')({ start: v })} /></Field>
              <Field label={`Target (${unit})`}><NumberInput value={cfg.ramp.target} onChange={(v) => sub('ramp')({ target: v })} /></Field>
              <Field label={`Step size (${unit})`}><NumberInput value={cfg.ramp.step} onChange={(v) => sub('ramp')({ step: v })} /></Field>
              <Field label="Step duration (s)"><NumberInput value={cfg.ramp.stepDurationSec} onChange={(v) => sub('ramp')({ stepDurationSec: v })} /></Field>
              <Field label="Hold at target (s)"><NumberInput value={cfg.ramp.holdSec} onChange={(v) => sub('ramp')({ holdSec: v })} /></Field>
            </>}
            {cfg.mode === 'stress' && <>
              <Field label={`Start (${unit})`}><NumberInput value={cfg.stress.start} onChange={(v) => sub('stress')({ start: v })} /></Field>
              <Field label={`Increase per step (${unit})`}><NumberInput value={cfg.stress.step} onChange={(v) => sub('stress')({ step: v })} /></Field>
              <Field label="Step duration (s)"><NumberInput value={cfg.stress.stepDurationSec} onChange={(v) => sub('stress')({ stepDurationSec: v })} /></Field>
              <Field label={`Hard maximum (${unit})`}><NumberInput value={cfg.stress.max} onChange={(v) => sub('stress')({ max: v })} /></Field>
            </>}
            {cfg.mode === 'spike' && <>
              <Field label={`Baseline (${unit})`}><NumberInput value={cfg.spike.base} onChange={(v) => sub('spike')({ base: v })} /></Field>
              <Field label={`Spike (${unit})`}><NumberInput value={cfg.spike.peak} onChange={(v) => sub('spike')({ peak: v })} /></Field>
              <Field label="Baseline duration (s)"><NumberInput value={cfg.spike.baseDurationSec} onChange={(v) => sub('spike')({ baseDurationSec: v })} /></Field>
              <Field label="Spike duration (s)"><NumberInput value={cfg.spike.spikeDurationSec} onChange={(v) => sub('spike')({ spikeDurationSec: v })} /></Field>
              <Field label="Recovery duration (s)"><NumberInput value={cfg.spike.recoveryDurationSec} onChange={(v) => sub('spike')({ recoveryDurationSec: v })} /></Field>
            </>}
          </div>
          {cfg.mode === 'stress' && (
            <div className="mt">
              <div className="label">Stop when any of these happens</div>
              <div className="form-grid mt-s">
                <Field label="Error rate above (%)" hint="Empty = ignore"><NumberInput value={cfg.stress.stopErrorRate} onChange={(v) => sub('stress')({ stopErrorRate: v })} min={0} max={100} /></Field>
                <Field label="p95 latency above (ms)" hint="Empty = ignore"><NumberInput value={cfg.stress.stopP95Ms} onChange={(v) => sub('stress')({ stopP95Ms: v })} min={1} /></Field>
                <Field label="Throughput stops rising" hint={`Less than ${cfg.stress.plateauPct}% growth for ${cfg.stress.plateauSteps} steps`}>
                  <Check checked={cfg.stress.stopOnPlateau} onChange={(v) => sub('stress')({ stopOnPlateau: v })} label="Enabled" />
                </Field>
                {cfg.stress.stopOnPlateau && <>
                  <Field label="Min growth per step (%)"><NumberInput value={cfg.stress.plateauPct} onChange={(v) => sub('stress')({ plateauPct: v })} min={0} /></Field>
                  <Field label="For N steps"><NumberInput value={cfg.stress.plateauSteps} onChange={(v) => sub('stress')({ plateauSteps: v })} min={1} /></Field>
                </>}
              </div>
              <div className="small muted mt-s">The test also always stops at the hard maximum.</div>
            </div>
          )}
        </Card>

        <Card title="Scenario" actions={<span className="small muted">One step = a single endpoint. Add steps for flows like “log in, then call the API with the token”.</span>}>
          {cfg.steps.map((s, i) => (
            <StepEditor key={i} step={s} index={i} total={cfg.steps.length}
              onChange={(v) => set({ steps: cfg.steps.map((x, j) => (j === i ? v : x)) })}
              onRemove={() => set({ steps: cfg.steps.filter((_, j) => j !== i) })}
              onMove={(d) => moveStep(i, d)} />
          ))}
          <Button className="mt" icon={Plus} onClick={() => set({ steps: [...cfg.steps, newStep(cfg.steps.length)] })} disabled={cfg.steps.length >= 20}>Add step</Button>
        </Card>

        <Card title="Test data (CSV, optional)" actions={<label className="btn sm"><Upload size={14} /> Upload CSV<input type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files[0] && loadCsv(e.target.files[0])} /></label>}>
          <Textarea rows={4} value={cfg.csv} onChange={(v) => set({ csv: v })} placeholder={'username,password\nalice,secret1\nbob,secret2'} />
          {csvCols.length > 0 && (
            <div className="row wrap mt-s small">
              <span className="secondary">{csvRows} row(s). Columns usable as variables:</span>
              {csvCols.map((c) => <code key={c} className="tag">{`{{${c}}}`}</code>)}
              <span className="grow" />
              <Select value={cfg.csvMode} onChange={(v) => set({ csvMode: v })} style={{ width: 'auto' }}
                options={[{ value: 'sequential', label: 'Rows in order' }, { value: 'random', label: 'Random row' }]} />
            </div>
          )}
        </Card>

        <Card title="Options">
          <div className="form-grid">
            <Field label="Network profile">
              <Select value={cfg.profileId ?? ''} onChange={(v) => set({ profileId: v ? Number(v) : null })}
                options={profiles.map((p) => ({ value: p.name === 'No throttling' ? '' : p.id, label: p.name }))} />
            </Field>
            <Field label="Think time between iterations (ms)"><NumberInput value={cfg.thinkTimeMs} onChange={(v) => set({ thinkTimeMs: v })} min={0} /></Field>
            <Field label="Request timeout (ms)"><NumberInput value={cfg.timeoutMs} onChange={(v) => set({ timeoutMs: v })} min={100} /></Field>
            <Field label="Success status codes"><Input className="mono" value={cfg.successStatus} onChange={(v) => set({ successStatus: v })} /></Field>
            {cfg.loadType === 'rps' && <Field label="Max concurrent requests" hint="Requests beyond this are dropped and reported"><NumberInput value={cfg.maxVus} onChange={(v) => set({ maxVus: v })} min={1} /></Field>}
          </div>
          <div className="mt"><Check checked={cfg.keepAlive} onChange={(v) => set({ keepAlive: v })} label="Reuse connections (keep-alive)" /></div>
          <div className="small muted mt-s">Results depend on this machine’s CPU and network. API Pulse warns you when the machine itself becomes the bottleneck.</div>
        </Card>

        <SavedTests kind="load" reloadKey={reloadKey}
          onLoad={(t) => { setTemplate(t); setCfg({ ...blank, ...t.config, steps: t.config.steps?.length ? t.config.steps : blank.steps }); window.scrollTo(0, 0); }}
          onRunLoad={async (t) => {
            try { setPf({ ...(await post('/tests/preflight', { kind: 'load', config: t.config })), cfg: t.config, templateId: t.id }); } catch (e) { setError(e); }
          }} />
      </div>

      {pf && <ConfirmRun pf={pf} cfg={pf.cfg} busy={busy} onCancel={() => setPf(null)} onConfirm={confirmRun} />}
      {saving && <SaveTestModal kind="load" config={cfg} template={template} onClose={() => setSaving(false)}
        onSaved={(t) => { setSaving(false); setTemplate(t); setReloadKey((k) => k + 1); }} />}
    </div>
  );
}
