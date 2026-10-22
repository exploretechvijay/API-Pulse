import Database from 'better-sqlite3';
import { config } from './config.js';

export const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const migrations = [
  // 1: initial schema
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
    disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_login_at INTEGER
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
    created_at INTEGER NOT NULL, last_used_at INTEGER
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE network_profiles (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
    download_kbps REAL NOT NULL DEFAULT 0, upload_kbps REAL NOT NULL DEFAULT 0,
    latency_ms REAL NOT NULL DEFAULT 0, jitter_ms REAL NOT NULL DEFAULT 0, packet_loss REAL NOT NULL DEFAULT 0,
    builtin INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 100,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );

  CREATE TABLE monitors (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    request TEXT NOT NULL, auth_enc TEXT,
    interval_sec INTEGER, timeout_ms INTEGER, failure_threshold INTEGER,
    rules TEXT NOT NULL DEFAULT '{}', tags TEXT NOT NULL DEFAULT '[]',
    project TEXT NOT NULL DEFAULT '', environment TEXT NOT NULL DEFAULT '',
    network_profile_id INTEGER REFERENCES network_profiles(id) ON DELETE SET NULL,
    alert_config TEXT NOT NULL DEFAULT '{}', show_on_status_page INTEGER NOT NULL DEFAULT 0,
    paused INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'pending', consecutive_failures INTEGER NOT NULL DEFAULT 0,
    consecutive_slow INTEGER NOT NULL DEFAULT 0,
    last_check_at INTEGER, last_response_ms REAL, last_status_code INTEGER, last_error TEXT,
    state_changed_at INTEGER, created_by INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );

  CREATE TABLE checks (
    id INTEGER PRIMARY KEY, monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL, result TEXT NOT NULL CHECK (result IN ('ok','slow','fail')),
    status_code INTEGER, response_ms REAL, error TEXT, timings TEXT
  );
  CREATE INDEX idx_checks_monitor_ts ON checks(monitor_id, ts);
  CREATE INDEX idx_checks_ts ON checks(ts);

  CREATE TABLE rollups_hourly (
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE, hour INTEGER NOT NULL,
    total INTEGER NOT NULL, ok INTEGER NOT NULL, slow INTEGER NOT NULL, fail INTEGER NOT NULL,
    avg_ms REAL, min_ms REAL, max_ms REAL, p95_ms REAL,
    PRIMARY KEY (monitor_id, hour)
  );

  CREATE TABLE channels (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('email','slack','teams','webhook')),
    config_enc TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );

  CREATE TABLE alerts (
    id INTEGER PRIMARY KEY, monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('down','degraded')),
    status TEXT NOT NULL CHECK (status IN ('active','acknowledged','resolved')),
    message TEXT, started_at INTEGER NOT NULL, recovered_at INTEGER,
    acknowledged_by TEXT, acknowledged_at INTEGER, resolved_by TEXT, resolved_at INTEGER,
    suppressed INTEGER NOT NULL DEFAULT 0, last_notified_at INTEGER, reminders_sent INTEGER NOT NULL DEFAULT 0,
    escalated_at INTEGER
  );
  CREATE INDEX idx_alerts_monitor ON alerts(monitor_id, started_at);
  CREATE INDEX idx_alerts_status ON alerts(status);

  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY, alert_id INTEGER REFERENCES alerts(id) ON DELETE CASCADE,
    channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL, channel_name TEXT,
    kind TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT, ts INTEGER NOT NULL
  );

  CREATE TABLE maintenance_windows (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
    recurrence TEXT NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none','daily','weekly')),
    monitor_ids TEXT NOT NULL DEFAULT '[]', created_by INTEGER, created_at INTEGER NOT NULL
  );

  CREATE TABLE variables (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, value_enc TEXT NOT NULL,
    is_secret INTEGER NOT NULL DEFAULT 1, description TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );

  CREATE TABLE test_templates (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('latency','load')),
    config TEXT NOT NULL, schedule TEXT NOT NULL DEFAULT '{}', pass_criteria TEXT NOT NULL DEFAULT '{}',
    last_scheduled_at INTEGER, created_by INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );

  CREATE TABLE test_runs (
    id INTEGER PRIMARY KEY, template_id INTEGER REFERENCES test_templates(id) ON DELETE SET NULL,
    name TEXT NOT NULL, kind TEXT NOT NULL, config TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','running','completed','stopped','failed')),
    trigger TEXT NOT NULL DEFAULT 'manual', started_at INTEGER NOT NULL, finished_at INTEGER,
    summary TEXT, headline TEXT, timeseries TEXT, warnings TEXT NOT NULL DEFAULT '[]', error TEXT,
    passed INTEGER, raw_file TEXT, created_by INTEGER, created_by_email TEXT
  );
  CREATE INDEX idx_runs_started ON test_runs(started_at);

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, user_id INTEGER, user_email TEXT,
    action TEXT NOT NULL, entity_type TEXT, entity_id TEXT, details TEXT
  );
  CREATE INDEX idx_audit_ts ON audit_log(ts);
  `,
];

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get();
  let v = row ? row.version : 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  for (; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v]);
      db.prepare('UPDATE schema_version SET version = ?').run(v + 1);
    })();
    console.log(`[db] applied migration ${v + 1}`);
  }
}

const BUILTIN_PROFILES = [
  // name, down kbps, up kbps, latency ms (RTT), jitter, loss %
  ['No throttling', 0, 0, 0, 0, 0, 'Your machine\'s real connection'],
  ['Fibre / Fast Wi-Fi', 100000, 50000, 5, 0, 0, '100 Mbps / 50 Mbps, 5 ms'],
  ['4G', 20000, 10000, 50, 0, 0, '20 Mbps / 10 Mbps, 50 ms'],
  ['Fast 3G', 1600, 750, 150, 0, 0, '1.6 Mbps / 750 kbps, 150 ms'],
  ['Slow 3G', 400, 400, 400, 0, 1, '400 kbps, 400 ms, 1% loss'],
  ['2G / Edge', 250, 50, 800, 0, 2, '250 / 50 kbps, 800 ms, 2% loss'],
  ['Offline-flaky', 1000, 500, 300, 0, 10, '1 Mbps / 500 kbps, 300 ms, 10% loss'],
];

export const DEFAULT_SETTINGS = {
  defaults: { intervalSec: 60, timeoutMs: 10000, failureThreshold: 3, degradedMs: null },
  retention: { rawDays: 30, rollupDays: 365, runDays: 365 },
  loadAllowlist: ['localhost', '127.0.0.1', '::1'],
  statusPage: { enabled: false, title: 'Service Status' },
};

function seed() {
  const now = Date.now();
  const ins = db.prepare(`INSERT OR IGNORE INTO network_profiles
    (name, description, download_kbps, upload_kbps, latency_ms, jitter_ms, packet_loss, builtin, sort, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`);
  BUILTIN_PROFILES.forEach(([name, d, u, l, j, p, desc], i) => ins.run(name, desc, d, u, l, j, p, i, now, now));
  const setIns = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) setIns.run(k, JSON.stringify(v));
}

migrate();
seed();

// ---------- helpers ----------
export const now = () => Date.now();
export const j = (v, d = null) => { if (v == null) return d; try { return JSON.parse(v); } catch { return d; } };

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const val = row ? j(row.value) : null;
  const def = DEFAULT_SETTINGS[key];
  if (def && typeof def === 'object' && !Array.isArray(def)) return { ...def, ...(val || {}) };
  return val ?? def;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

export function profileFromRow(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, description: r.description, builtin: !!r.builtin,
    downloadKbps: r.download_kbps, uploadKbps: r.upload_kbps, latencyMs: r.latency_ms,
    jitterMs: r.jitter_ms, packetLoss: r.packet_loss,
  };
}

export function getProfile(id) {
  if (id == null) return null;
  return profileFromRow(db.prepare('SELECT * FROM network_profiles WHERE id = ?').get(id));
}
