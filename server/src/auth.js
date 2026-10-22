import bcrypt from 'bcryptjs';
import { db, now } from './db.js';
import { config } from './config.js';
import { sha256, randomToken } from './crypto.js';
import { HttpError } from './util.js';

const COOKIE = 'pulse_session';
const ROLE_LEVEL = { viewer: 1, editor: 2, admin: 3 };

export const hashPassword = (p) => bcrypt.hashSync(p, 10);
export const verifyPassword = (p, h) => bcrypt.compareSync(p, h);

export function publicUser(u) {
  return u && { id: u.id, email: u.email, name: u.name, role: u.role, disabled: !!u.disabled,
    createdAt: u.created_at, lastLoginAt: u.last_login_at };
}

export function userCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

export function createUser({ email, name = '', password, role = 'viewer' }) {
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(400, 'A valid email is required');
  if (!password || password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (!ROLE_LEVEL[role]) throw new HttpError(400, 'Invalid role');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'A user with this email already exists');
  const r = db.prepare('INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(email.trim(), name.trim(), hashPassword(password), role, now());
  return db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
}

export function createSession(res, userId) {
  const token = randomToken();
  const expires = now() + config.sessionTtlHours * 3600_000;
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, now(), expires);
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), userId);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, expires: new Date(expires), path: '/' });
}

export function destroySession(req, res) {
  const token = readCookie(req, COOKIE);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.clearCookie(COOKIE, { path: '/' });
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** Resolves req.user from session cookie or "Authorization: Bearer <api token>". */
export function authenticate(req, _res, next) {
  req.user = null;
  const auth = req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) {
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    const row = db.prepare(`SELECT u.*, t.id AS token_id FROM api_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?`).get(sha256(token));
    if (row && !row.disabled) {
      db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now(), row.token_id);
      req.user = row;
      req.viaToken = true;
    }
    return next();
  }
  const token = readCookie(req, COOKIE);
  if (token) {
    const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), now());
    if (row && !row.disabled) req.user = row;
  }
  next();
}

export function requireRole(role) {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Login required'));
    if (ROLE_LEVEL[req.user.role] < ROLE_LEVEL[role]) return next(new HttpError(403, `Requires ${role} role`));
    next();
  };
}

export const requireLogin = requireRole('viewer');
export const requireEditor = requireRole('editor');
export const requireAdmin = requireRole('admin');

export function createApiToken(userId, name) {
  const token = 'ap_' + randomToken(24);
  db.prepare('INSERT INTO api_tokens (user_id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, name, sha256(token), token.slice(0, 7), now());
  return token;
}

/** Bootstrap an admin from ADMIN_EMAIL / ADMIN_PASSWORD on first start. */
export function bootstrapAdmin() {
  if (userCount() === 0 && config.adminEmail && config.adminPassword) {
    createUser({ email: config.adminEmail, name: 'Administrator', password: config.adminPassword, role: 'admin' });
    console.log(`[auth] created admin user ${config.adminEmail}`);
  }
}

// purge expired sessions hourly
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now()), 3600_000).unref();
