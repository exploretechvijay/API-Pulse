import { useState } from 'react';
import { Field, Input, Select, Textarea, KeyValueEditor, Tabs, Check } from './ui.jsx';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/**
 * Edits { request: {method,url,headers,query,bodyType,body,ignoreTls}, auth: {type,...} }.
 * Values may use {{VARIABLE}} placeholders.
 */
export default function RequestEditor({ request, auth, onChange, compact }) {
  const [tab, setTab] = useState('params');
  const r = request || {};
  const a = auth || { type: 'none' };
  const setR = (patch) => onChange({ request: { ...r, ...patch }, auth: a });
  const setA = (patch) => onChange({ request: r, auth: { ...a, ...patch } });
  const count = (l) => (l?.length ? ` (${l.length})` : '');

  return (
    <div className="col gap-lg">
      <div className="url-row">
        <Select value={r.method || 'GET'} onChange={(v) => setR({ method: v })} options={METHODS} aria-label="HTTP method" />
        <Input className="mono" value={r.url} onChange={(v) => setR({ url: v.trim() })} placeholder="https://api.example.com/health  or  {{BASE_URL}}/health" aria-label="URL" />
      </div>
      <div>
        <Tabs value={tab} onChange={setTab} tabs={[
          { value: 'params', label: `Query params${count(r.query)}` },
          { value: 'headers', label: `Headers${count(r.headers)}` },
          { value: 'body', label: 'Body' },
          { value: 'auth', label: `Auth${a.type !== 'none' ? ' ●' : ''}` },
          ...(compact ? [] : [{ value: 'options', label: 'Options' }]),
        ]} />
        {tab === 'params' && <KeyValueEditor items={r.query} onChange={(v) => setR({ query: v })} addLabel="Add parameter" />}
        {tab === 'headers' && <KeyValueEditor items={r.headers} onChange={(v) => setR({ headers: v })} keyPlaceholder="Header" addLabel="Add header" />}
        {tab === 'body' && (
          <div className="col">
            <Select value={r.bodyType || 'none'} onChange={(v) => setR({ bodyType: v })} style={{ maxWidth: 220 }}
              options={[{ value: 'none', label: 'No body' }, { value: 'json', label: 'JSON' }, { value: 'text', label: 'Plain text' }, { value: 'form', label: 'Form (urlencoded)' }]} />
            {r.bodyType && r.bodyType !== 'none' && (
              <Textarea rows={7} value={r.body} onChange={(v) => setR({ body: v })}
                placeholder={r.bodyType === 'json' ? '{\n  "username": "{{USER}}"\n}' : r.bodyType === 'form' ? 'a=1&b={{VALUE}}' : ''} />
            )}
          </div>
        )}
        {tab === 'auth' && (
          <div className="form-grid">
            <Field label="Type">
              <Select value={a.type} onChange={(v) => setA({ type: v })} options={[
                { value: 'none', label: 'None' }, { value: 'bearer', label: 'Bearer token' }, { value: 'basic', label: 'Basic auth' }, { value: 'apiKey', label: 'API key' }]} />
            </Field>
            {a.type === 'bearer' && <Field label="Token" hint="Stored encrypted. Tip: use {{SECRET_NAME}}."><Input className="mono" type="password" value={a.token} onChange={(v) => setA({ token: v })} autoComplete="off" /></Field>}
            {a.type === 'basic' && <>
              <Field label="Username"><Input value={a.username} onChange={(v) => setA({ username: v })} autoComplete="off" /></Field>
              <Field label="Password"><Input type="password" value={a.password} onChange={(v) => setA({ password: v })} autoComplete="new-password" /></Field>
            </>}
            {a.type === 'apiKey' && <>
              <Field label="Key name"><Input className="mono" value={a.key} onChange={(v) => setA({ key: v })} placeholder="X-API-Key" /></Field>
              <Field label="Value"><Input className="mono" type="password" value={a.value} onChange={(v) => setA({ value: v })} autoComplete="off" /></Field>
              <Field label="Send in">
                <Select value={a.in || 'header'} onChange={(v) => setA({ in: v })} options={[{ value: 'header', label: 'Header' }, { value: 'query', label: 'Query parameter' }]} />
              </Field>
            </>}
          </div>
        )}
        {tab === 'options' && (
          <Check checked={r.ignoreTls} onChange={(v) => setR({ ignoreTls: v })} label="Skip TLS certificate verification (self-signed certificates)" />
        )}
      </div>
    </div>
  );
}
