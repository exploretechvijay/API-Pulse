import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, Trash2, Pencil } from 'lucide-react';
import { get, post, del } from '../api.js';
import { useStore } from '../store.jsx';
import { put } from '../api.js';
import { Card, Button, useAsync, useToast, useConfirm, Empty, Modal, Field, Input, NumberInput, Check, Select, ErrorBox } from './ui.jsx';
import { ago } from '../format.js';

/** Save the current editor config as a reusable test, with optional schedule + pass criteria. */
export function SaveTestModal({ kind, config, template, onClose, onSaved }) {
  const [name, setName] = useState(template?.name || '');
  const [schedule, setSchedule] = useState(template?.schedule || { enabled: false, type: 'daily', time: '02:00', everyMinutes: 60 });
  const [pc, setPc] = useState(template?.passCriteria || {});
  const [error, setError] = useState(null);
  const toast = useToast();
  const sc = (patch) => setSchedule((s) => ({ ...s, ...patch }));
  const save = async (asNew) => {
    try {
      const body = { name, kind, config, schedule, passCriteria: pc };
      const t = template && !asNew ? await put(`/templates/${template.id}`, body) : await post('/templates', body);
      toast('Test saved');
      onSaved(t);
    } catch (e) { setError(e); }
  };
  return (
    <Modal title={template ? 'Update saved test' : 'Save as test'} onClose={onClose} footer={<>
      <Button onClick={onClose}>Cancel</Button>
      {template && <Button onClick={() => save(true)}>Save as new</Button>}
      <Button variant="primary" onClick={() => save(false)} disabled={!name}>{template ? 'Update' : 'Save'}</Button>
    </>}>
      <div className="col gap-lg">
        <Field label="Name"><Input value={name} onChange={setName} autoFocus placeholder="Checkout API – nightly" /></Field>
        <div>
          <div className="label">Pass criteria (optional – used for CI/CD and scheduled runs)</div>
          <div className="form-grid mt-s">
            <Field label="Max p95 (ms)"><NumberInput value={pc.maxP95Ms} onChange={(v) => setPc({ ...pc, maxP95Ms: v })} /></Field>
            <Field label="Max p99 (ms)"><NumberInput value={pc.maxP99Ms} onChange={(v) => setPc({ ...pc, maxP99Ms: v })} /></Field>
            <Field label="Max avg (ms)"><NumberInput value={pc.maxAvgMs} onChange={(v) => setPc({ ...pc, maxAvgMs: v })} /></Field>
            <Field label="Max error rate (%)"><NumberInput value={pc.maxErrorRate} onChange={(v) => setPc({ ...pc, maxErrorRate: v })} /></Field>
            {kind === 'load' && <Field label="Min throughput (req/s)"><NumberInput value={pc.minRps} onChange={(v) => setPc({ ...pc, minRps: v })} /></Field>}
          </div>
        </div>
        <div>
          <Check checked={schedule.enabled} onChange={(v) => sc({ enabled: v })} label="Run automatically on a schedule" />
          {schedule.enabled && (
            <div className="form-grid mt-s">
              <Field label="Repeat"><Select value={schedule.type} onChange={(v) => sc({ type: v })} options={[{ value: 'daily', label: 'Daily at a time' }, { value: 'interval', label: 'Every N minutes' }]} /></Field>
              {schedule.type === 'daily'
                ? <Field label="Time (server time)"><Input type="time" value={schedule.time} onChange={(v) => sc({ time: v })} /></Field>
                : <Field label="Every (minutes)"><NumberInput value={schedule.everyMinutes} onChange={(v) => sc({ everyMinutes: v })} min={5} /></Field>}
            </div>
          )}
          {schedule.enabled && kind === 'load' && <div className="warn-box mt-s">Scheduled load tests run without a confirmation prompt. The target must still be on the allow-list.</div>}
        </div>
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

/** List of saved tests (templates) of one kind with one-click re-run (CFG-02). */
export default function SavedTests({ kind, onLoad, reloadKey, onRunLoad }) {
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useStore();
  const [confirm, confirmNode] = useConfirm();
  const list = useAsync(() => get(`/templates?kind=${kind}`), [kind, reloadKey]);
  const [busy, setBusy] = useState(null);

  const run = async (t) => {
    if (kind === 'load') return onRunLoad(t);
    setBusy(t.id);
    try { const r = await post(`/templates/${t.id}/run`); nav(`/runs/${r.id}`); } catch (e) { toast(e.message, 'error'); } finally { setBusy(null); }
  };
  const remove = async (t) => {
    if (!(await confirm({ title: 'Delete saved test?', message: `"${t.name}" will be deleted. Past runs are kept.`, danger: true, confirmLabel: 'Delete' }))) return;
    await del(`/templates/${t.id}`);
    list.reload();
  };

  return (
    <Card title="Saved tests" pad={false}>
      {confirmNode}
      {!list.data?.length ? <Empty title="No saved tests">Configure a test and click “Save as test” to re-run it with one click, schedule it, or trigger it from CI.</Empty> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>Schedule</th><th>Last run</th><th /></tr></thead>
            <tbody>
              {list.data.map((t) => (
                <tr key={t.id}>
                  <td><strong>{t.name}</strong><div className="small muted">ID {t.id}</div></td>
                  <td className="small">{t.schedule.enabled ? (t.schedule.type === 'daily' ? `Daily at ${t.schedule.time}` : `Every ${t.schedule.everyMinutes} min`) : <span className="muted">Manual</span>}</td>
                  <td className="small">
                    {t.lastRun ? <a href={`/runs/${t.lastRun.id}`} onClick={(e) => { e.preventDefault(); nav(`/runs/${t.lastRun.id}`); }}>
                      {ago(t.lastRun.started_at)} · {t.lastRun.status}{t.lastRun.passed === 1 ? ' · passed' : t.lastRun.passed === 0 ? ' · FAILED' : ''}
                    </a> : <span className="muted">never</span>}
                  </td>
                  <td className="nowrap" style={{ textAlign: 'right' }}>
                    {can('editor') && <>
                      <Button size="sm" variant="primary" icon={Play} disabled={busy === t.id} onClick={() => run(t)}>Run</Button>
                      <Button size="sm" variant="ghost" icon={Pencil} onClick={() => onLoad(t)} aria-label="Edit" title="Load into editor" />
                      <Button size="sm" variant="ghost" icon={Trash2} onClick={() => remove(t)} aria-label="Delete" />
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
