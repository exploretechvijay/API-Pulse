# API Pulse — Development Plan

Source: `API Pulse — Business Requirements Document.md` (PRD v1.0, Oct 18 2026).
Decision on open question #1: **self-hosted only** (no SaaS, no multi-tenancy, no billing).

## 1. Architecture

```
┌──────────────────────────── single Docker container ────────────────────────────┐
│  Node.js 20 process                                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐  ┌───────────────────────┐  │
│  │ REST API    │  │ Scheduler +  │  │ Alert       │  │ Test manager          │  │
│  │ (Express)   │  │ monitor      │  │ service +   │  │  └─ worker_threads    │  │
│  │ + SSE hub   │  │ checker      │  │ channels    │  │     (latency / load   │  │
│  └─────────────┘  └──────────────┘  └─────────────┘  │      engine)          │  │
│         │                │                 │         └───────────────────────┘  │
│         └────────────── SQLite (WAL) ──────┴── data/ volume (db, raw run files) │
│  Static React SPA (built by Vite) served from the same port                     │
└─────────────────────────────────────────────────────────────────────────────────┘
       optional: Caddy reverse proxy in docker-compose for automatic HTTPS
```

| Concern | Choice | Why |
| --- | --- | --- |
| Backend | Node.js 20, Express, ESM JavaScript | PRD-suggested stack, one language end to end |
| Storage | SQLite (better-sqlite3, WAL mode) | Zero-ops for self-hosting; hourly rollups keep it small |
| Live updates | Server-Sent Events | One-way push is all the dashboard needs; works through proxies |
| HTTP client | Node `http/https` + custom Agent | Exact phase timings (DNS/TCP/TLS/TTFB/download) and pluggable throttling |
| Network simulation | In-process throttled socket under TLS | Bandwidth, latency, jitter, packet loss applied to both directions (NET-03) |
| Load engine | Own engine in `worker_threads`, keep-alive agents | Open question #2: no external binary to ship; raw results kept for exact percentiles |
| Frontend | React 18, React Router, Recharts, Vite | PRD-suggested |
| Auth | Email + password (bcrypt), HttpOnly session cookie, API tokens for CI | Roles: admin / editor / viewer |
| Secrets | AES-256-GCM at rest, key from `APP_SECRET` or auto-generated key file | Masked in UI, API and logs |

## 2. Data model (SQLite)

`users`, `sessions`, `api_tokens`, `settings`, `monitors`, `checks` (raw), `rollups_hourly`,
`alerts`, `notifications`, `channels`, `maintenance_windows`, `network_profiles`, `variables`,
`test_templates`, `test_runs`, `audit_log`.

## 3. Work breakdown (build order)

| # | Milestone | PRD items |
| --- | --- | --- |
| 1 | Project skeleton, DB schema & migrations, config, crypto, auth + roles, audit log | Security, Auditability |
| 2 | HTTP client with phase timings + network simulator + preset/custom profiles | LAT-03, NET-01..04, MON-09 |
| 3 | Monitors CRUD, scheduler, rule evaluation, state machine (Up/Degraded/Down, N failures) | MON-01..09, CFG-04 |
| 4 | Alerts: state-change alerts, ack/resolve, channels (email, Slack, Teams, webhook), rules, reminders, maintenance windows, escalation | ALR-01..07 |
| 5 | SSE hub, dashboard API, uptime/latency series, hourly rollups, retention job | DSH-01..07, Data retention |
| 6 | Latency tests (multi-profile, percentiles, phases, histogram, timeline) | LAT-01..05 |
| 7 | Load engine: Fixed (VU/RPS), Ramp-up, Stress w/ stop conditions, Spike, Soak; live stats; stop; multi-step scenarios + CSV data; allow-list + confirmation; CPU self-overhead warning; raw result export | LOAD-01..08, Responsible load testing, Self-overhead |
| 8 | Templates, run history, run comparison, scheduled tests, CI/CD run endpoint with pass/fail | CFG-02, CFG-06, US-09, US-12 |
| 9 | Variables & secrets `{{NAME}}`, config import/export JSON/YAML | CFG-03, CFG-05 |
| 10 | React UI for all of the above, light/dark, mobile; public status page | DSH-08, DSH-09, CFG-01 |
| 11 | Docker image, compose (+ optional Caddy HTTPS), healthcheck, auto-restart, README | Deployment, Availability |
| 12 | Verification: unit tests (stats, throttle, rules), mock API, run MVP acceptance criteria | Acceptance criteria |

## 4. Explicitly deferred

- Distributed load workers (LOAD-09), SMS/phone alerts (ALR-08), non-HTTP protocols — PRD v2.0.
- SSO (open question #4) — not in MVP; local accounts + API tokens.
- Multi-region monitoring (open question #5).

## 5. Status (Oct 18, 2026)

Milestones 1–12 are implemented. Every P0 and P1 requirement is implemented, plus these P2 items: MON-09, ALR-07, DSH-09, CFG-06 and US-12.
Not built: ALR-08 (SMS/phone; use a webhook to an SMS gateway) and LOAD-09 (distributed workers).
All MVP acceptance criteria below were verified end to end against the running app.

## 6. Acceptance verification (MVP)

| Criterion | How it is verified |
| --- | --- |
| New monitor checks within one interval, no restart | Scheduler starts a monitor on create; first check runs immediately |
| Stopped API → red tile within interval × threshold + 2 s | Mock API `/toggle`; SSE push on every check |
| Down + recovery reach Slack and email | Channel adapters + "Send test" button; webhook test against mock receiver |
| Slow 3G latency clearly higher than unthrottled | Latency test across both profiles on the mock API |
| Stress stops at configured error rate, reports breaking load | Mock API `/capacity` endpoint that fails above N concurrent requests |
| Load refused for hosts not on allow-list | Server-side check in the run endpoint (403) |
| Percentiles match offline calculation | Nearest-rank method; raw results downloadable as CSV; unit test |
