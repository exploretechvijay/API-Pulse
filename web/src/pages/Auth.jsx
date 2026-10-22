import { useState } from 'react';
import { post } from '../api.js';
import { Field, Input, ErrorBox } from '../components/ui.jsx';
import { Logo } from '../components/Layout.jsx';

function Shell({ title, sub, children }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="row" style={{ justifyContent: 'center', marginBottom: 20, gap: 10 }}>
          <Logo size={32} /><h1>API Pulse</h1>
        </div>
        <div className="card card-pad">
          <h2>{title}</h2>
          {sub && <p className="secondary small" style={{ margin: '6px 0 0' }}>{sub}</p>}
          <div className="mt">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function Login({ onDone }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try { onDone((await post('/auth/login', { email, password })).user); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Shell title="Sign in">
      <form className="col gap-lg" onSubmit={submit}>
        <Field label="Email"><Input type="email" value={email} onChange={setEmail} autoFocus autoComplete="username" required /></Field>
        <Field label="Password"><Input type="password" value={password} onChange={setPassword} autoComplete="current-password" required /></Field>
        <ErrorBox error={error} />
        <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </Shell>
  );
}

export function Setup({ onDone }) {
  const [f, setF] = useState({ name: '', email: '', password: '', confirm: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (f.password !== f.confirm) return setError(new Error('Passwords do not match'));
    setBusy(true);
    setError(null);
    try { onDone((await post('/auth/setup', f)).user); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Shell title="Create the admin account" sub="This is a fresh installation. The first account becomes the administrator.">
      <form className="col gap-lg" onSubmit={submit}>
        <Field label="Name"><Input value={f.name} onChange={set('name')} autoFocus /></Field>
        <Field label="Email"><Input type="email" value={f.email} onChange={set('email')} required autoComplete="username" /></Field>
        <Field label="Password" hint="At least 8 characters"><Input type="password" value={f.password} onChange={set('password')} required autoComplete="new-password" /></Field>
        <Field label="Confirm password"><Input type="password" value={f.confirm} onChange={set('confirm')} required autoComplete="new-password" /></Field>
        <ErrorBox error={error} />
        <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
      </form>
    </Shell>
  );
}
