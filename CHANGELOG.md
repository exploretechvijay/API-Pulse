# Changelog

All notable changes to API Pulse are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] – 2026-10-22

First public release.

### Added

- **Uptime monitoring:** HTTP/HTTPS monitors with method, headers, query, body and Bearer / Basic / API-key auth. Expected status codes, “body contains” and JSON-field rules. A Degraded threshold, Down after N consecutive failures, and checks from 10 s to 24 h. Checks can optionally run through a network profile.
- **Live dashboard:** Up / Degraded / Down / Paused summary, monitor tiles with Down sorted first, filters and search, and Server-Sent Events updates.
- **Monitor details:** response-time chart (avg / p95), uptime history, paginated recent checks with a failed/slow filter, an incident log, and 1 h – 90 d ranges.
- **Alerts:** raised on Down / Degraded with recovery notices. Acknowledge and resolve, reminders, escalation, and maintenance windows (one-off, daily, weekly). Sent to Slack, Microsoft Teams, email (SMTP) and signed webhooks.
- **Latency tests:** up to 10,000 requests per profile, with min / avg / median / p90 / p95 / p99 / max, a DNS / TCP / TLS / TTFB / download breakdown, histograms, a timeline, and several network profiles side by side.
- **Network simulator:** bandwidth (both directions), latency, jitter and packet loss. Seven presets plus custom profiles.
- **Load tests:** Fixed, Ramp-up, Stress, Spike and Soak modes, measured in virtual users or requests per second. Multi-step scenarios with value extraction, CSV test data, live charts and an instant stop. Stress mode reports the breaking point and the maximum sustainable throughput.
- **Responsible load testing:** host allow-list, confirmation step and production warning.
- **Self-overhead detection:** warns when the testing machine's CPU or the generator thread is saturated.
- **Plain-language summary & recommendations** for every run, with a glossary that shows each term's value in that run.
- **Test management:** saved tests, scheduled runs, run history, comparison of two runs, and raw results as CSV.
- **CI/CD:** API tokens and `POST /api/templates/:id/run?wait=true` with pass/fail criteria.
- **Configuration:** UI for everything, YAML/JSON import and export, global defaults, `{{VARIABLES}}` and encrypted secrets.
- **Security & operations:** Admin / Editor / Viewer roles, audit log, public status page, data retention with hourly rollups.
- **Deployment:** Docker image, Docker Compose with auto-restart, and an optional Caddy HTTPS profile.

[Unreleased]: https://github.com/exploretechvijay/API-Pulse/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/exploretechvijay/API-Pulse/releases/tag/v1.0.0
