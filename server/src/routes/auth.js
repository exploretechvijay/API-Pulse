import { Router } from 'express';
import { db, now } from '../db.js';
import { ah, HttpError, badRequest, str } from '../util.js';
import { audit } from '../audit.js';
import {
  createUser, createSession, destroySession, publicUser, userCount, verifyPassword, hashPassword,
  requireLogin, requireAdmin, createApiToken,
} from '../auth.js';

const r = Router();

// simple in-memory login throttle: 10 failures per email+IP per 15 min
const failures = new Map();
const key = (req, email) => `${req.ip}|${String(email).toLowerCase()}`;

r.get('/auth/status', (req, res) => {
  res.json({ needsSetup: userCount() === 0, user: publicUser(req.user) });
});

r.post('/auth/setup', ah(async (req, res) => {
  if (userCount() > 0) throw new HttpError(409, 'Setup has already been completed');
  const u = createUser({ email: req.body.email, name: req.body.name, password: req.body.password, role: 'admin' });
  audit(u, 'user.setup', 'user', u.id);
  createSession(res, u.id);
  res.json({ user: publicUser(u) });
}));

r.post('/auth/login', ah(async (req, res) => {
  const { email, password } = req.body || {};
  const k = key(req, email);
  const f = failures.get(k);
  if (f && f.count >= 10 && Date.now() - f.first < 15 * 60_000) throw new HttpError(429, 'Too many failed attempts – try again in 15 minutes');
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim());
  if (!u || u.disabled || !verifyPassword(String(password || ''), u.password_hash)) {
    const cur = f && Date.now() - f.first < 15 * 60_000 ? f : { count: 0, first: Date.now() };
    cur.count++;
    failures.set(k, cur);
    throw new HttpError(401, 'Invalid email or password');
  }
  failures.delete(k);
  createSession(res, u.id);
  audit(u, 'user.login', 'user', u.id);
  res.json({ user: publicUser(u) });
}));

r.post('/auth/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

r.get('/auth/me', requireLogin, (req, res) => res.json({ user: publicUser(req.user) }));

r.post('/auth/password', requireLogin, ah(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!verifyPassword(String(currentPassword || ''), req.user.password_hash)) throw badRequest('Current password is incorrect');
  if (!newPassword || newPassword.length < 8) throw badRequest('New password must be at least 8 characters');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), req.user.id);
  audit(req.user, 'user.password', 'user', req.user.id);
  res.json({ ok: true });
}));

// ---- users (admin) ----
r.get('/users', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM users ORDER BY email').all().map(publicUser));
});

r.post('/users', requireAdmin, ah(async (req, res) => {
  const u = createUser(req.body || {});
  audit(req.user, 'user.create', 'user', u.id, { email: u.email, role: u.role });
  res.status(201).json(publicUser(u));
}));

r.put('/users/:id', requireAdmin, ah(async (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) throw new HttpError(404, 'User not found');
  const role = req.body.role ?? u.role;
  if (!['admin', 'editor', 'viewer'].includes(role)) throw badRequest('Invalid role');
  const disabled = req.body.disabled ?? !!u.disabled;
  if (u.id === req.user.id && (role !== 'admin' || disabled)) throw badRequest('You cannot demote or disable yourself');
  const name = str(req.body.name ?? u.name, { max: 200 });
  db.prepare('UPDATE users SET name = ?, role = ?, disabled = ? WHERE id = ?').run(name, role, disabled ? 1 : 0, u.id);
  if (req.body.password) {
    if (req.body.password.length < 8) throw badRequest('Password must be at least 8 characters');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  }
  if (disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  audit(req.user, 'user.update', 'user', u.id, { role, disabled, passwordReset: !!req.body.password });
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)));
}));

r.delete('/users/:id', requireAdmin, ah(async (req, res) => {
  if (Number(req.params.id) === req.user.id) throw badRequest('You cannot delete yourself');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) throw new HttpError(404, 'User not found');
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  audit(req.user, 'user.delete', 'user', u.id, { email: u.email });
  res.json({ ok: true });
}));

// ---- API tokens (for CI/CD, US-12) ----
r.get('/tokens', requireLogin, (req, res) => {
  res.json(db.prepare('SELECT id, name, prefix, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY id DESC')
    .all(req.user.id).map((t) => ({ id: t.id, name: t.name, prefix: t.prefix, createdAt: t.created_at, lastUsedAt: t.last_used_at })));
});

r.post('/tokens', requireLogin, ah(async (req, res) => {
  if (req.viaToken) throw new HttpError(403, 'API tokens cannot create other tokens');
  const name = str(req.body.name, { required: true, max: 100, name: 'Name' });
  const token = createApiToken(req.user.id, name);
  audit(req.user, 'token.create', 'token', null, { name });
  res.status(201).json({ token, name, createdAt: now() });
}));

r.delete('/tokens/:id', requireLogin, ah(async (req, res) => {
  const r2 = db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!r2.changes) throw new HttpError(404, 'Token not found');
  audit(req.user, 'token.delete', 'token', req.params.id);
  res.json({ ok: true });
}));

export default r;
