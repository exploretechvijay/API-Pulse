import { db, now } from './db.js';
import { encrypt, decrypt, SECRET_MASK } from './crypto.js';
import { badRequest, str } from './util.js';

/** Loads all stored variables, decrypted. */
export function loadVariables() {
  const out = {};
  for (const r of db.prepare('SELECT name, value_enc FROM variables').all()) {
    try { out[r.name] = decrypt(r.value_enc); } catch { /* wrong key – leave unresolved */ }
  }
  return out;
}

export function toVariable(r, { reveal = false } = {}) {
  let value = SECRET_MASK;
  if (!r.is_secret || reveal) { try { value = decrypt(r.value_enc); } catch { value = ''; } }
  return { id: r.id, name: r.name, value, isSecret: !!r.is_secret, description: r.description, createdAt: r.created_at, updatedAt: r.updated_at };
}

export function upsertVariable(body, existing) {
  const name = str(body.name ?? existing?.name, { required: true, max: 100, name: 'Name' }).trim();
  if (!/^[A-Za-z_][\w.-]*$/.test(name)) throw badRequest('Name may contain letters, digits, _, . and - and must not start with a digit');
  const isSecret = body.isSecret ?? (existing ? !!existing.is_secret : true);
  let valueEnc;
  if (body.value === undefined || (body.value === SECRET_MASK && existing)) valueEnc = existing?.value_enc ?? encrypt('');
  else valueEnc = encrypt(String(body.value));
  const desc = str(body.description ?? existing?.description, { max: 500 });
  const t = now();
  if (existing) {
    db.prepare('UPDATE variables SET name = ?, value_enc = ?, is_secret = ?, description = ?, updated_at = ? WHERE id = ?')
      .run(name, valueEnc, isSecret ? 1 : 0, desc, t, existing.id);
    return existing.id;
  }
  if (db.prepare('SELECT 1 FROM variables WHERE name = ?').get(name)) throw badRequest(`Variable ${name} already exists`);
  return db.prepare('INSERT INTO variables (name, value_enc, is_secret, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, valueEnc, isSecret ? 1 : 0, desc, t, t).lastInsertRowid;
}
