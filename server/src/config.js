import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const env = process.env;
const bool = (v, d = false) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

const dataDir = path.resolve(env.DATA_DIR || path.join(root, 'data'));
fs.mkdirSync(path.join(dataDir, 'runs'), { recursive: true });

export const config = {
  root,
  port: Number(env.PORT || 8080),
  host: env.HOST || '0.0.0.0',
  dataDir,
  dbFile: path.join(dataDir, 'api-pulse.db'),
  runsDir: path.join(dataDir, 'runs'),
  webDist: path.resolve(env.WEB_DIST || path.join(root, 'web', 'dist')),
  appSecret: env.APP_SECRET || '',
  tlsCertFile: env.TLS_CERT_FILE || '',
  tlsKeyFile: env.TLS_KEY_FILE || '',
  secureCookies: bool(env.SECURE_COOKIES, !!env.TLS_CERT_FILE),
  trustProxy: bool(env.TRUST_PROXY, false),
  sessionTtlHours: Number(env.SESSION_TTL_HOURS || 168),
  adminEmail: env.ADMIN_EMAIL || '',
  adminPassword: env.ADMIN_PASSWORD || '',
  configFile: env.CONFIG_FILE || '',
  baseUrl: env.BASE_URL || '',
  cpuWarnPercent: Number(env.CPU_WARN_PERCENT || 85),
  version: '1.0.0',
};
