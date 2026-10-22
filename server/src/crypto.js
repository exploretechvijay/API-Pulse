// AES-256-GCM encryption for secrets at rest.
// Key: APP_SECRET env (any string, hashed to 32 bytes) or an auto-generated
// key file in the data directory (created on first start, chmod 600).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

function loadKey() {
  if (config.appSecret) return crypto.createHash('sha256').update(config.appSecret).digest();
  const file = path.join(config.dataDir, 'secret.key');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
    console.log(`[crypto] generated encryption key at ${file} – back it up together with the database`);
  }
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
}

const KEY = loadKey();
const PREFIX = 'enc:v1:';

export function encrypt(plain) {
  if (plain == null) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
}

export function decrypt(value) {
  if (value == null) return null;
  if (!String(value).startsWith(PREFIX)) return value;
  const buf = Buffer.from(value.slice(PREFIX.length), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

export const encryptJson = (obj) => encrypt(JSON.stringify(obj ?? {}));
export const decryptJson = (v) => (v ? JSON.parse(decrypt(v)) : {});

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const hmac = (secret, body) => crypto.createHmac('sha256', secret).update(body).digest('hex');

/** Placeholder returned to clients instead of real secret values. */
export const SECRET_MASK = '••••••••';
