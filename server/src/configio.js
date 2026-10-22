// Export / import of the full configuration as JSON or YAML (CFG-03, US-10).
// References between objects use names, not database ids, so a file can be
// committed to Git and applied to another installation.

import yaml from 'js-yaml';
import { db, j, now, getSetting, setSetting, profileFromRow } from './db.js';
import { decryptJson, decrypt, SECRET_MASK } from './crypto.js';
import { monitorColumns, insertMonitor, updateMonitor, maskAuth } from './monitor/model.js';
import { channelColumns, maskConfig } from './alerts/channels.js';
import { templateColumns, maskTestConfig } from './tests/manager.js';
import { upsertVariable } from './variables.js';
import { badRequest } from './util.js';

const REDACTED = SECRET_MASK;

export function exportConfig({ includeSecrets = false } = {}) {
  const profiles = db.prepare('SELECT * FROM network_profiles').all().map(profileFromRow);
  const profileName = (id) => profiles.find((p) => p.id === id)?.name ?? null;
  const channels = db.prepare('SELECT * FROM channels ORDER BY id').all();
  const channelName = (id) => channels.find((c) => c.id === id)?.name;
  const monitors = db.prepare('SELECT * FROM monitors ORDER BY id').all();
  const monitorName = (id) => monitors.find((m) => m.id === id)?.name;

  const testCfg = (kind, cfg) => {
    const c = includeSecrets ? structuredClone(cfg) : maskTestConfig(kind, cfg);
    if (kind === 'latency') { c.profiles = (c.profileIds || []).map(profileName).filter(Boolean); delete c.profileIds; }
    else { c.profile = profileName(c.profileId); delete c.profileId; }
    return c;
  };

  return {
    apiPulse: 1,
    exportedAt: new Date().toISOString(),
    settings: {
      defaults: getSetting('defaults'),
      retention: getSetting('retention'),
      loadAllowlist: getSetting('loadAllowlist'),
      statusPage: getSetting('statusPage'),
    },
    networkProfiles: profiles.filter((p) => !p.builtin).map(({ id, builtin, ...p }) => p),
    variables: db.prepare('SELECT * FROM variables ORDER BY name').all().map((v) => ({
      name: v.name, value: v.is_secret && !includeSecrets ? REDACTED : decrypt(v.value_enc), isSecret: !!v.is_secret, description: v.description,
    })),
    channels: channels.map((c) => ({
      name: c.name, type: c.type, enabled: !!c.enabled, isDefault: !!c.is_default,
      config: includeSecrets ? decryptJson(c.config_enc) : maskConfig(decryptJson(c.config_enc)),
    })),
    monitors: monitors.map((m) => {
      const alerts = j(m.alert_config, {});
      const auth = decryptJson(m.auth_enc);
      return {
        name: m.name, description: m.description || undefined, request: j(m.request),
        auth: includeSecrets ? auth : maskAuth(auth),
        intervalSec: m.interval_sec ?? undefined, timeoutMs: m.timeout_ms ?? undefined, failureThreshold: m.failure_threshold ?? undefined,
        rules: j(m.rules, {}), tags: j(m.tags, []), project: m.project || undefined, environment: m.environment || undefined,
        networkProfile: profileName(m.network_profile_id) ?? undefined, showOnStatusPage: !!m.show_on_status_page, paused: !!m.paused,
        alerts: {
          onDown: alerts.onDown, onDegraded: alerts.onDegraded, onRecovery: alerts.onRecovery,
          channels: (alerts.channelIds || []).map(channelName).filter(Boolean),
          reminderMinutes: alerts.reminderMinutes, escalateAfterMinutes: alerts.escalateAfterMinutes,
          escalationChannels: (alerts.escalationChannelIds || []).map(channelName).filter(Boolean),
        },
      };
    }),
    maintenanceWindows: db.prepare('SELECT * FROM maintenance_windows ORDER BY id').all().map((w) => ({
      name: w.name, startsAt: new Date(w.starts_at).toISOString(), endsAt: new Date(w.ends_at).toISOString(),
      recurrence: w.recurrence, monitors: j(w.monitor_ids, []).map(monitorName).filter(Boolean),
    })),
    tests: db.prepare('SELECT * FROM test_templates ORDER BY id').all().map((t) => ({
      name: t.name, kind: t.kind, config: testCfg(t.kind, decryptJson(t.config)),
      schedule: j(t.schedule, {}), passCriteria: j(t.pass_criteria, {}),
    })),
  };
}

export function serialize(obj, format) {
  return format === 'json' ? JSON.stringify(obj, null, 2) : yaml.dump(obj, { lineWidth: 140, noRefs: true, skipInvalid: true });
}

export function parseConfigText(text) {
  let doc;
  try { doc = yaml.load(text); } catch (e) { throw badRequest(`Could not parse file: ${e.message}`); }
  if (!doc || typeof doc !== 'object') throw badRequest('Config file is empty or not an object');
  return doc;
}

/**
 * Applies a config document. mode "merge" upserts by name; "replace" also deletes
 * monitors/channels/windows/tests/custom profiles that are not in the file.
 */
export function importConfig(doc, { mode = 'merge', userId = null } = {}) {
  const report = { created: [], updated: [], deleted: [], warnings: [] };
  const tx = db.transaction(() => {
    const t = now();
    if (doc.settings) {
      for (const k of ['defaults', 'retention', 'statusPage']) if (doc.settings[k]) setSetting(k, { ...getSetting(k), ...doc.settings[k] });
      if (Array.isArray(doc.settings.loadAllowlist)) setSetting('loadAllowlist', doc.settings.loadAllowlist.map(String));
    }

    // network profiles
    const pNames = new Set();
    for (const p of doc.networkProfiles || []) {
      if (!p?.name) continue;
      pNames.add(p.name);
      const ex = db.prepare('SELECT * FROM network_profiles WHERE name = ?').get(p.name);
      if (ex?.builtin) { report.warnings.push(`Profile "${p.name}" is built in and was not changed`); continue; }
      const vals = [Number(p.downloadKbps) || 0, Number(p.uploadKbps) || 0, Number(p.latencyMs) || 0, Number(p.jitterMs) || 0, Number(p.packetLoss) || 0, p.description || ''];
      if (ex) {
        db.prepare('UPDATE network_profiles SET download_kbps=?, upload_kbps=?, latency_ms=?, jitter_ms=?, packet_loss=?, description=?, updated_at=? WHERE id=?').run(...vals, t, ex.id);
        report.updated.push(`profile ${p.name}`);
      } else {
        db.prepare('INSERT INTO network_profiles (download_kbps, upload_kbps, latency_ms, jitter_ms, packet_loss, description, name, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(...vals, p.name, t, t);
        report.created.push(`profile ${p.name}`);
      }
    }
    const profileId = (name) => (name ? db.prepare('SELECT id FROM network_profiles WHERE name = ?').get(name)?.id ?? null : null);

    // variables
    for (const v of doc.variables || []) {
      if (!v?.name) continue;
      const ex = db.prepare('SELECT * FROM variables WHERE name = ?').get(v.name);
      if (v.value === REDACTED && !ex) report.warnings.push(`Variable ${v.name} was exported without its value – set it in the UI`);
      upsertVariable({ ...v, value: v.value === REDACTED ? (ex ? REDACTED : '') : v.value }, ex);
      (ex ? report.updated : report.created).push(`variable ${v.name}`);
    }

    // channels
    const cNames = new Set();
    for (const c of doc.channels || []) {
      if (!c?.name) continue;
      cNames.add(c.name);
      const ex = db.prepare('SELECT * FROM channels WHERE name = ?').get(c.name);
      let cols;
      try { cols = channelColumns(c, ex); } catch (e) { report.warnings.push(`Channel "${c.name}": ${e.message}`); continue; }
      if (ex) {
        db.prepare('UPDATE channels SET name=?, type=?, config_enc=?, enabled=?, is_default=?, updated_at=? WHERE id=?').run(cols.name, cols.type, cols.config_enc, cols.enabled, cols.is_default, t, ex.id);
        report.updated.push(`channel ${c.name}`);
      } else {
        db.prepare('INSERT INTO channels (name, type, config_enc, enabled, is_default, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(cols.name, cols.type, cols.config_enc, cols.enabled, cols.is_default, t, t);
        report.created.push(`channel ${c.name}`);
      }
    }
    const channelIds = (names) => (names || []).map((n) => db.prepare('SELECT id FROM channels WHERE name = ?').get(n)?.id).filter(Boolean);

    // monitors
    const mNames = new Set();
    for (const m of doc.monitors || []) {
      if (!m?.name) continue;
      mNames.add(m.name);
      const ex = db.prepare('SELECT * FROM monitors WHERE name = ?').get(m.name);
      const body = {
        ...m,
        networkProfileId: profileId(m.networkProfile),
        alerts: { ...(m.alerts || {}), channelIds: channelIds(m.alerts?.channels), escalationChannelIds: channelIds(m.alerts?.escalationChannels) },
      };
      if (!ex && body.auth) for (const f of ['token', 'password', 'value']) if (body.auth[f] === REDACTED) { body.auth[f] = ''; report.warnings.push(`Monitor "${m.name}": ${f} was redacted – set it in the UI`); }
      let cols;
      try { cols = monitorColumns(body, ex); } catch (e) { report.warnings.push(`Monitor "${m.name}": ${e.message}`); continue; }
      if (ex) { updateMonitor(ex.id, cols); report.updated.push(`monitor ${m.name}`); }
      else { insertMonitor(cols, userId); report.created.push(`monitor ${m.name}`); }
    }
    const monitorIds = (names) => (names || []).map((n) => db.prepare('SELECT id FROM monitors WHERE name = ?').get(n)?.id).filter(Boolean);

    // maintenance windows
    const wNames = new Set();
    for (const w of doc.maintenanceWindows || []) {
      if (!w?.name) continue;
      wNames.add(w.name);
      const s = Date.parse(w.startsAt); const e = Date.parse(w.endsAt);
      if (!s || !e || e <= s) { report.warnings.push(`Maintenance window "${w.name}": invalid start/end`); continue; }
      const rec = ['none', 'daily', 'weekly'].includes(w.recurrence) ? w.recurrence : 'none';
      const ids = JSON.stringify(monitorIds(w.monitors));
      const ex = db.prepare('SELECT id FROM maintenance_windows WHERE name = ?').get(w.name);
      if (ex) { db.prepare('UPDATE maintenance_windows SET starts_at=?, ends_at=?, recurrence=?, monitor_ids=? WHERE id=?').run(s, e, rec, ids, ex.id); report.updated.push(`window ${w.name}`); }
      else { db.prepare('INSERT INTO maintenance_windows (name, starts_at, ends_at, recurrence, monitor_ids, created_by, created_at) VALUES (?,?,?,?,?,?,?)').run(w.name, s, e, rec, ids, userId, t); report.created.push(`window ${w.name}`); }
    }

    // saved tests
    const tNames = new Set();
    for (const tpl of doc.tests || []) {
      if (!tpl?.name) continue;
      tNames.add(tpl.name);
      const cfg = { ...(tpl.config || {}) };
      if (tpl.kind === 'latency') { cfg.profileIds = (cfg.profiles || []).map(profileId).filter(Boolean); delete cfg.profiles; }
      else { cfg.profileId = profileId(cfg.profile); delete cfg.profile; }
      const ex = db.prepare('SELECT * FROM test_templates WHERE name = ?').get(tpl.name);
      let cols;
      try { cols = templateColumns({ ...tpl, config: cfg }, ex); } catch (e) { report.warnings.push(`Test "${tpl.name}": ${e.message}`); continue; }
      if (ex) { db.prepare('UPDATE test_templates SET name=?, kind=?, config=?, schedule=?, pass_criteria=?, updated_at=? WHERE id=?').run(cols.name, cols.kind, cols.config, cols.schedule, cols.pass_criteria, t, ex.id); report.updated.push(`test ${tpl.name}`); }
      else { db.prepare('INSERT INTO test_templates (name, kind, config, schedule, pass_criteria, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run(cols.name, cols.kind, cols.config, cols.schedule, cols.pass_criteria, userId, t, t); report.created.push(`test ${tpl.name}`); }
    }

    if (mode === 'replace') {
      const del = (table, names, label, extra = '') => {
        for (const r of db.prepare(`SELECT id, name FROM ${table} ${extra}`).all()) {
          if (!names.has(r.name)) { db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(r.id); report.deleted.push(`${label} ${r.name}`); }
        }
      };
      del('monitors', mNames, 'monitor');
      del('channels', cNames, 'channel');
      del('maintenance_windows', wNames, 'window');
      del('test_templates', tNames, 'test');
      del('network_profiles', pNames, 'profile', 'WHERE builtin = 0');
    }
  });
  tx();
  return report;
}
