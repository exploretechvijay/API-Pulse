// Channel adapters (ALR-04): email (SMTP), Slack, Microsoft Teams, generic webhook.

import nodemailer from 'nodemailer';
import { db, j, now } from '../db.js';
import { encryptJson, decryptJson, hmac, SECRET_MASK } from '../crypto.js';
import { badRequest, str } from '../util.js';
import { config } from '../config.js';

export const CHANNEL_TYPES = ['email', 'slack', 'teams', 'webhook'];
const SECRET_FIELDS = ['password', 'webhookUrl', 'secret'];

export function maskConfig(cfg) {
  const c = { ...cfg };
  for (const f of SECRET_FIELDS) if (c[f]) c[f] = SECRET_MASK;
  if (Array.isArray(c.headers)) c.headers = c.headers.map((h) => ({ ...h, value: h.value ? SECRET_MASK : '' }));
  return c;
}

function unmask(incoming, prev) {
  const c = { ...incoming };
  for (const f of SECRET_FIELDS) if (c[f] === SECRET_MASK) c[f] = prev?.[f] ?? '';
  if (Array.isArray(c.headers)) {
    c.headers = c.headers.map((h) => (h.value === SECRET_MASK
      ? { ...h, value: (prev?.headers || []).find((p) => p.key === h.key)?.value ?? '' } : h));
  }
  return c;
}

export function toChannel(row, { withSecrets = false } = {}) {
  const cfg = decryptJson(row.config_enc);
  return { id: row.id, name: row.name, type: row.type, enabled: !!row.enabled, isDefault: !!row.is_default,
    config: withSecrets ? cfg : maskConfig(cfg), createdAt: row.created_at, updatedAt: row.updated_at };
}

export function channelColumns(body, existing) {
  const type = body.type ?? existing?.type;
  if (!CHANNEL_TYPES.includes(type)) throw badRequest(`Channel type must be one of ${CHANNEL_TYPES.join(', ')}`);
  const prevCfg = existing ? decryptJson(existing.config_enc) : {};
  const cfg = unmask(body.config ?? prevCfg, prevCfg);
  const clean = {};
  if (type === 'email') {
    clean.host = str(cfg.host, { required: true, name: 'SMTP host' });
    clean.port = Number(cfg.port || 587);
    clean.secure = !!cfg.secure;
    clean.username = str(cfg.username);
    clean.password = str(cfg.password);
    clean.from = str(cfg.from, { required: true, name: 'From address' });
    clean.to = str(cfg.to, { required: true, name: 'Recipients' });
  } else if (type === 'slack' || type === 'teams') {
    clean.webhookUrl = str(cfg.webhookUrl, { required: true, name: 'Webhook URL' });
    if (!/^https?:\/\//.test(clean.webhookUrl)) throw badRequest('Webhook URL must start with https://');
    if (type === 'slack') clean.mention = str(cfg.mention, { max: 200 });
  } else {
    clean.url = str(cfg.url, { required: true, name: 'URL' });
    if (!/^https?:\/\//.test(clean.url)) throw badRequest('URL must start with http:// or https://');
    clean.method = ['POST', 'PUT'].includes(cfg.method) ? cfg.method : 'POST';
    clean.headers = Array.isArray(cfg.headers) ? cfg.headers.filter((h) => h?.key) : [];
    clean.secret = str(cfg.secret);
  }
  return {
    name: str(body.name ?? existing?.name, { required: true, name: 'Name', max: 200 }),
    type,
    config_enc: encryptJson(clean),
    enabled: (body.enabled ?? (existing ? !!existing.enabled : true)) ? 1 : 0,
    is_default: (body.isDefault ?? (existing ? !!existing.is_default : false)) ? 1 : 0,
  };
}

// ---------------- message formatting ----------------

const EMOJI = { down: '🔴', degraded: '🟠', recovered: '🟢', reminder: '🔁', escalation: '🚨', test: '🧪' };
const COLOR = { down: 'D93025', degraded: 'F29900', recovered: '1E8E3E', reminder: 'D93025', escalation: 'A50E0E', test: '1A73E8' };

function fmtDuration(ms) {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function describe(evt) {
  const { kind, monitor, alert } = evt;
  const name = monitor?.name || 'Test monitor';
  const titles = {
    down: `${name} is DOWN`,
    degraded: `${name} is DEGRADED`,
    recovered: `${name} has RECOVERED`,
    reminder: `Reminder: ${name} is still ${alert?.type?.toUpperCase()}`,
    escalation: `ESCALATION: ${name} is ${alert?.type?.toUpperCase()} and unacknowledged`,
    test: 'API Pulse test notification',
  };
  const facts = [];
  if (monitor) {
    facts.push(['URL', `${monitor.request?.method || 'GET'} ${monitor.request?.url || ''}`]);
    if (monitor.environment) facts.push(['Environment', monitor.environment]);
  }
  if (alert?.message) facts.push([kind === 'recovered' ? 'Last error' : 'Error', alert.message]);
  if (kind === 'recovered' && alert?.startedAt) facts.push(['Downtime', fmtDuration(now() - alert.startedAt)]);
  if (['reminder', 'escalation'].includes(kind) && alert?.startedAt) facts.push(['Duration', fmtDuration(now() - alert.startedAt)]);
  if (evt.check?.statusCode) facts.push(['Status code', String(evt.check.statusCode)]);
  if (evt.check?.responseMs != null) facts.push(['Response time', `${Math.round(evt.check.responseMs)} ms`]);
  facts.push(['Time', new Date().toISOString()]);
  if (kind === 'test') facts.push(['Message', 'If you can read this, the channel is configured correctly.']);
  const link = config.baseUrl && monitor?.id ? `${config.baseUrl.replace(/\/$/, '')}/monitors/${monitor.id}` : null;
  return { title: `${EMOJI[kind] || ''} ${titles[kind] || kind}`.trim(), facts, link, color: COLOR[kind] || '666666' };
}

async function post(url, body, headers = {}, method = 'POST') {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, { method, headers: { 'content-type': 'application/json', ...headers }, body, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  } finally {
    clearTimeout(t);
  }
}

const senders = {
  async slack(cfg, evt) {
    const d = describe(evt);
    const text = `${cfg.mention && evt.kind !== 'recovered' ? cfg.mention + ' ' : ''}*${d.title}*`;
    const fields = d.facts.map(([k, v]) => `*${k}:* ${v}`).join('\n');
    await post(cfg.webhookUrl, JSON.stringify({
      text: d.title,
      attachments: [{ color: `#${d.color}`, blocks: [
        { type: 'section', text: { type: 'mrkdwn', text } },
        { type: 'section', text: { type: 'mrkdwn', text: fields } },
        ...(d.link ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in API Pulse' }, url: d.link }] }] : []),
      ] }],
    }));
  },

  async teams(cfg, evt) {
    const d = describe(evt);
    // Adaptive Card – accepted by Teams Workflows webhooks and legacy incoming webhooks
    await post(cfg.webhookUrl, JSON.stringify({
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
          body: [
            { type: 'TextBlock', size: 'Large', weight: 'Bolder', text: d.title, wrap: true,
              color: ['down', 'reminder', 'escalation'].includes(evt.kind) ? 'Attention' : evt.kind === 'recovered' ? 'Good' : evt.kind === 'degraded' ? 'Warning' : 'Default' },
            { type: 'FactSet', facts: d.facts.map(([title, value]) => ({ title, value })) },
          ],
          actions: d.link ? [{ type: 'Action.OpenUrl', title: 'Open in API Pulse', url: d.link }] : [],
        },
      }],
    }));
  },

  async webhook(cfg, evt) {
    const d = describe(evt);
    const payload = JSON.stringify({
      event: evt.kind,
      title: d.title,
      monitor: evt.monitor ? { id: evt.monitor.id, name: evt.monitor.name, url: evt.monitor.request?.url,
        environment: evt.monitor.environment, tags: evt.monitor.tags, state: evt.monitor.state } : null,
      alert: evt.alert ? { id: evt.alert.id, type: evt.alert.type, status: evt.alert.status, message: evt.alert.message,
        startedAt: evt.alert.startedAt } : null,
      check: evt.check || null,
      link: d.link,
      timestamp: new Date().toISOString(),
    });
    const headers = {};
    for (const h of cfg.headers || []) headers[h.key] = h.value;
    if (cfg.secret) headers['x-pulse-signature'] = `sha256=${hmac(cfg.secret, payload)}`;
    await post(cfg.url, payload, headers, cfg.method || 'POST');
  },

  async email(cfg, evt) {
    const d = describe(evt);
    const transport = nodemailer.createTransport({
      host: cfg.host, port: cfg.port, secure: cfg.secure,
      auth: cfg.username ? { user: cfg.username, pass: cfg.password } : undefined,
      connectionTimeout: 10_000, greetingTimeout: 10_000,
    });
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const rows = d.facts.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#555"><b>${esc(k)}</b></td><td style="padding:4px 0">${esc(v)}</td></tr>`).join('');
    await transport.sendMail({
      from: cfg.from,
      to: cfg.to,
      subject: d.title.replace(/^\p{Extended_Pictographic}\s*/u, '[API Pulse] '),
      text: `${d.title}\n\n${d.facts.map(([k, v]) => `${k}: ${v}`).join('\n')}${d.link ? `\n\n${d.link}` : ''}`,
      html: `<div style="font-family:system-ui,sans-serif"><h2 style="color:#${d.color};margin:0 0 12px">${esc(d.title)}</h2>
        <table>${rows}</table>${d.link ? `<p><a href="${esc(d.link)}">Open in API Pulse</a></p>` : ''}</div>`,
    });
  },
};

/** Send one event to one channel row. Never throws; returns {ok, error}. */
export async function sendToChannel(row, evt, alertId = null) {
  let ok = true;
  let error = null;
  try {
    await senders[row.type](decryptJson(row.config_enc), evt);
  } catch (e) {
    ok = false;
    error = e.message || String(e);
    console.error(`[channels] ${row.type} "${row.name}" failed: ${error}`);
  }
  db.prepare('INSERT INTO notifications (alert_id, channel_id, channel_name, kind, ok, error, ts) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(alertId, row.id, row.name, evt.kind, ok ? 1 : 0, error, now());
  return { ok, error };
}

export function channelRows(ids) {
  if (!ids?.length) return [];
  return db.prepare(`SELECT * FROM channels WHERE enabled = 1 AND id IN (${ids.map(() => '?').join(',')})`).all(...ids);
}

export const parseIds = (v) => j(v, []);
