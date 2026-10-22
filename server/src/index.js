import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import express from 'express';
import { config } from './config.js';
import { db } from './db.js';
import { authenticate, bootstrapAdmin, requireLogin } from './auth.js';
import { HttpError } from './util.js';
import { addClient } from './events.js';
import { startScheduler, stopScheduler } from './monitor/scheduler.js';
import { startMaintenanceJobs } from './monitor/stats.js';
import { startAlertTicker } from './alerts/service.js';
import { recoverRuns, startTestScheduler } from './tests/manager.js';
import { importConfig, parseConfigText } from './configio.js';
import authRoutes from './routes/auth.js';
import monitorRoutes from './routes/monitors.js';
import alertRoutes from './routes/alerts.js';
import testRoutes from './routes/tests.js';
import adminRoutes from './routes/admin.js';
import publicRoutes from './routes/public.js';

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', true);

app.use((req, res, next) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('content-security-policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
  next();
});

app.use('/api', express.json({ limit: '20mb' }));
app.use('/api', authenticate);

// CSRF defence for cookie sessions: state-changing requests must come from our own origin.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.viaToken) return next();
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return next(new HttpError(403, 'Cross-origin request blocked'));
    } catch {
      return next(new HttpError(403, 'Invalid origin'));
    }
  }
  next();
});

app.get('/api/stream', requireLogin, (req, res) => addClient(res));
app.use('/api', publicRoutes);
app.use('/api', authRoutes);
app.use('/api', monitorRoutes);
app.use('/api', alertRoutes);
app.use('/api', testRoutes);
app.use('/api', adminRoutes);
app.use('/api', (req, res, next) => next(new HttpError(404, `No such endpoint: ${req.method} ${req.path}`)));
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

// static dashboard (SPA)
if (fs.existsSync(config.webDist)) {
  app.use(express.static(config.webDist, { index: false, maxAge: '1h' }));
  app.get('*', (req, res) => res.sendFile(path.join(config.webDist, 'index.html')));
} else {
  app.get('/', (req, res) => res.type('text').send('API Pulse server is running. The web UI is not built – run "npm run build".'));
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err.type === 'entity.too.large') err = new HttpError(413, 'Request body too large');
  if (err instanceof SyntaxError && 'body' in err) err = new HttpError(400, 'Invalid JSON body');
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 && !(err instanceof HttpError) ? 'Internal server error' : err.message, details: err.details });
});

// ---------------- boot ----------------
recoverRuns();
bootstrapAdmin();
if (config.configFile) {
  try {
    const report = importConfig(parseConfigText(fs.readFileSync(config.configFile, 'utf8')), { mode: 'merge' });
    console.log(`[config] applied ${config.configFile}: ${report.created.length} created, ${report.updated.length} updated`);
    for (const w of report.warnings) console.warn(`[config] ${w}`);
  } catch (e) {
    console.error(`[config] could not apply ${config.configFile}: ${e.message}`);
  }
}

const useTls = config.tlsCertFile && config.tlsKeyFile;
const server = useTls
  ? https.createServer({ cert: fs.readFileSync(config.tlsCertFile), key: fs.readFileSync(config.tlsKeyFile) }, app)
  : http.createServer(app);
server.keepAliveTimeout = 65_000;

server.listen(config.port, config.host, () => {
  console.log(`API Pulse ${config.version} listening on ${useTls ? 'https' : 'http'}://${config.host}:${config.port} (data: ${config.dataDir})`);
  startScheduler();
  startAlertTicker();
  startMaintenanceJobs();
  startTestScheduler();
});

function shutdown(sig) {
  console.log(`[server] ${sig} received, shutting down`);
  stopScheduler();
  server.close();
  setTimeout(() => { db.close(); process.exit(0); }, 1500).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
