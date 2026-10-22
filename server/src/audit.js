import { db } from './db.js';

const ins = db.prepare(`INSERT INTO audit_log (ts, user_id, user_email, action, entity_type, entity_id, details)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);

/**
 * Record who did what (PRD: Auditability).
 * @param {object|null} user  req.user or null for system actions
 */
export function audit(user, action, entityType, entityId, details) {
  ins.run(Date.now(), user?.id ?? null, user?.email ?? 'system', action, entityType ?? null,
    entityId == null ? null : String(entityId), details ? JSON.stringify(details) : null);
}
