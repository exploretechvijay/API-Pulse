# API Pulse — Product Requirements Document

Oct 18, 2026 · @Vijay

## Overview

API Pulse is one configurable tool that tells a team, in a single dashboard, whether its APIs are up, how fast they respond, and how much load they can take before they break. It combines three jobs that today need three separate tools: uptime monitoring with alerts, latency testing under simulated network conditions (2G to fibre), and throughput testing up to the API's breaking point.

Every threshold, schedule, network profile, load pattern and alert channel is configurable from the UI or a config file, so the tool fits any API without code changes.

| Item | Detail |
| --- | --- |
| Product name | API Pulse (working name) |
| Document type | Product Requirements Document (PRD) |
| Version | 1.0 (draft) |
| Status | For review |
| Prepared for | Engineering, QA, DevOps and product leadership |
| Approvers | To be named |

## Problem and goals

Teams find out about API outages and slowdowns from users, not from their own tooling. Performance is usually tested only on fast office networks, so real users on mobile data see a much slower product than the team expects. Load testing is ad hoc, needs scripting skills, and its results are not kept or compared over time.

### Goals

1. Detect an API outage within one check interval and show it on the dashboard immediately.
2. Measure latency as real users experience it, across configurable network profiles.
3. Find each API's maximum sustainable throughput and its breaking point without writing scripts.
4. Make every check, threshold and alert configurable by non-developers.
5. Keep test and uptime history so performance can be compared release to release.

### Success metrics

| Metric | Target |
| --- | --- |
| Time from API failure to dashboard alert | Under 1 check interval + 5 s |
| False-positive down alerts | Under 1% of alerts |
| Time to set up a new monitor | Under 2 minutes, no code |
| Time to run a first load test | Under 5 minutes, no code |
| Latency measurement accuracy vs. reference tool | Within 5% |
| Teams actively using the tool after 3 months | 80% of target teams |

## Scope and target users

### In scope

- Scheduled uptime and health monitoring of HTTP/HTTPS REST APIs.
- Real-time dashboard showing which APIs are up, degraded or down, with active alerts.
- Alert notifications to the dashboard plus external channels (email, Slack, Teams, webhook).
- On-demand latency testing with simulated network conditions.
- Throughput and load testing, including a stress mode that pushes the API to its limit.
- Configuration of all of the above through the UI and an importable/exportable config file.
- Storage of results and history, with reports and export.

### Out of scope for version 1

- GraphQL subscriptions, gRPC, WebSocket and SOAP protocol testing (planned later).
- Distributed load generation across multiple machines or regions (planned later).
- Functional/contract testing of response schemas beyond simple assertions.
- Monitoring of non-API infrastructure (servers, databases, queues).

### Stakeholders

| Stakeholder | Interest |
| --- | --- |
| Engineering leads | API reliability and release readiness |
| QA / performance engineers | Latency, load and stress test results |
| DevOps / SRE | Uptime, alerting, incident response |
| Product managers | User-facing performance on real networks |
| Security / IT | Safe use of load testing, credential handling |

### User personas

- **QA engineer (Priya)** runs latency and load tests before each release and needs comparable reports.
- **SRE on call (Rahul)** needs to see at a glance which API is down and get alerted on his phone.
- **Backend developer (Arjun)** wants to check how his new endpoint behaves on a slow 3G network.
- **Engineering manager (Meera)** reviews weekly uptime and performance trends.

## User stories

Priority: P0 = must have for launch, P1 = should have for launch, P2 = later release.

| ID | As a… | I want to… | So that… | Priority |
| --- | --- | --- | --- | --- |
| US-01 | SRE | see every monitored API's status on one dashboard | I know instantly which one is down | P0 |
| US-02 | SRE | get an alert on Slack/email when an API goes down or recovers | I can respond without watching the screen | P0 |
| US-03 | QA engineer | add a monitor with URL, method, headers, body and checks from the UI | I don't need to edit code | P0 |
| US-04 | Developer | test an endpoint's latency on a slow 3G profile | I see what mobile users experience | P0 |
| US-05 | QA engineer | run a load test at a fixed number of users or requests per second | I can verify the API meets its SLA | P0 |
| US-06 | QA engineer | run a stress test that keeps increasing load until the API fails | I know its breaking point | P0 |
| US-07 | Developer | create my own network profile (latency, bandwidth, packet loss) | I can match a specific market's conditions | P1 |
| US-08 | Engineering manager | see uptime % and latency trends over 7/30/90 days | I can track reliability over time | P1 |
| US-09 | QA engineer | compare two test runs side by side | I can catch regressions between releases | P1 |
| US-10 | DevOps | export and import the full configuration as a file | I can version it in Git and copy it between environments | P1 |
| US-11 | SRE | pause alerts during a planned maintenance window | the team isn't spammed with known downtime | P1 |
| US-12 | DevOps | trigger tests from CI/CD through an API | releases are blocked if performance regresses | P2 |

## Feature: Uptime monitoring

Each monitor checks one API endpoint on a schedule and decides whether it is Up, Degraded or Down.

| ID | Requirement | Priority |
| --- | --- | --- |
| MON-01 | Create, edit, clone, pause, resume and delete monitors from the UI. | P0 |
| MON-02 | Configure per monitor: name, URL, HTTP method, headers, query params, request body, and authentication (API key, Bearer token, Basic auth). | P0 |
| MON-03 | Configure check interval from 10 seconds to 24 hours, and request timeout. | P0 |
| MON-04 | Configure success rules: expected status code(s), response time limit, text or JSON field the body must contain. | P0 |
| MON-05 | Mark an API **Down** only after N consecutive failures (configurable, default 3) to avoid false alarms. | P0 |
| MON-06 | Mark an API **Degraded** when it responds correctly but slower than its threshold. | P0 |
| MON-07 | Record each check: timestamp, status, status code, response time, error message. | P0 |
| MON-08 | Group monitors by tags, project or environment (dev, staging, production). | P1 |
| MON-09 | Optionally run monitor checks through a chosen network profile. | P2 |

## Feature: Alerts and notifications

Alerts fire when a monitor changes state and show both on the dashboard and in external channels.

| ID | Requirement | Priority |
| --- | --- | --- |
| ALR-01 | Raise an alert when a monitor goes Down or Degraded, and a recovery notice when it returns to Up. | P0 |
| ALR-02 | Show active alerts in a live panel on the dashboard, newest first, with API name, state, time and error. | P0 |
| ALR-03 | Let users acknowledge and resolve alerts, recording who did it and when. | P0 |
| ALR-04 | Send alerts to configurable channels: email, Slack, Microsoft Teams, generic webhook. | P0 |
| ALR-05 | Configure alert rules per monitor: which states trigger, which channels, and repeat reminder interval while still down. | P1 |
| ALR-06 | Define maintenance windows that suppress alerts for chosen monitors. | P1 |
| ALR-07 | Escalate to a second channel if an alert is not acknowledged within a set time. | P2 |
| ALR-08 | Send SMS and phone call alerts. | P2 |

## Feature: Dashboard

The dashboard is the home screen and updates live without a page refresh.

| ID | Requirement | Priority |
| --- | --- | --- |
| DSH-01 | Summary bar: count of APIs Up, Degraded, Down and Paused. | P0 |
| DSH-02 | One tile or row per monitor showing status colour, current response time, uptime % (24 h) and last check time. | P0 |
| DSH-03 | Down APIs sorted to the top and visually highlighted. | P0 |
| DSH-04 | Live updates pushed from the server (WebSocket or Server-Sent Events) within 2 s of a check finishing. | P0 |
| DSH-05 | Monitor detail page: response-time chart, uptime history bar, recent checks and incident log. | P0 |
| DSH-06 | Filters by tag, environment and status; search by name. | P1 |
| DSH-07 | Selectable time range: 1 h, 24 h, 7 d, 30 d, 90 d. | P1 |
| DSH-08 | Light and dark themes; usable on mobile screens. | P1 |
| DSH-09 | Public or shareable read-only status page. | P2 |

## Feature: Latency testing

A latency test sends a set number of requests to one endpoint and reports how long each phase took.

| ID | Requirement | Priority |
| --- | --- | --- |
| LAT-01 | Run an on-demand test with configurable request count (1–10,000), delay between requests and timeout. | P0 |
| LAT-02 | Report min, max, average, median, p90, p95 and p99 response time, plus error rate. | P0 |
| LAT-03 | Break each request into phases: DNS lookup, TCP connect, TLS handshake, time to first byte, content download. | P1 |
| LAT-04 | Show a latency distribution chart (histogram) and a per-request timeline. | P0 |
| LAT-05 | Run the same test across several network profiles at once and compare results side by side. | P1 |

## Feature: Network condition simulation

Users pick a network profile so tests reflect real-world internet speeds instead of the office connection.

| Profile | Download | Upload | Added latency | Packet loss |
| --- | --- | --- | --- | --- |
| No throttling | Unlimited | Unlimited | 0 ms | 0% |
| Fibre / Fast Wi-Fi | 100 Mbps | 50 Mbps | 5 ms | 0% |
| 4G | 20 Mbps | 10 Mbps | 50 ms | 0% |
| Fast 3G | 1.6 Mbps | 750 kbps | 150 ms | 0% |
| Slow 3G | 400 kbps | 400 kbps | 400 ms | 1% |
| 2G / Edge | 250 kbps | 50 kbps | 800 ms | 2% |
| Offline-flaky | 1 Mbps | 500 kbps | 300 ms | 10% |

| ID | Requirement | Priority |
| --- | --- | --- |
| NET-01 | Provide the preset profiles above, selectable on every latency and load test. | P0 |
| NET-02 | Let users create, edit and delete custom profiles: download/upload bandwidth, added latency, jitter, packet loss %. | P0 |
| NET-03 | Apply the profile to both request and response so large payloads are slowed realistically. | P0 |
| NET-04 | Show the active profile clearly on every result so throttled and unthrottled runs are never confused. | P0 |

## Feature: Throughput and load testing

Load tests send many concurrent requests to measure how much traffic an API handles and where it breaks.

| Test mode | What it does | Typical use |
| --- | --- | --- |
| Fixed load | Holds a set number of virtual users or requests/second for a set time | Check the API meets its SLA |
| Ramp-up | Increases load in steps from a start value to a target | See how latency grows with traffic |
| Stress (max load) | Keeps increasing load until a stop condition is hit | Find the breaking point and max throughput |
| Spike | Jumps suddenly from low to very high load, then back | Test behaviour under traffic bursts |
| Soak | Holds moderate load for hours | Catch memory leaks and slow degradation |

| ID | Requirement | Priority |
| --- | --- | --- |
| LOAD-01 | Run Fixed load, Ramp-up and Stress modes. | P0 |
| LOAD-02 | Configure virtual users (concurrency), target requests/second, duration, ramp step size and step duration. | P0 |
| LOAD-03 | Stress mode stop conditions, all configurable: error rate above X%, p95 latency above Y ms, throughput stops rising, or a hard maximum of users. | P0 |
| LOAD-04 | Show live charts during the test: requests/second, response time (p50/p95/p99), error rate and active users. | P0 |
| LOAD-05 | Final report: total requests, peak and sustained throughput, latency percentiles, errors by type/status code, and the load level at which the API broke. | P0 |
| LOAD-06 | Stop a running test immediately from the UI. | P0 |
| LOAD-07 | Support multi-step scenarios (e.g. log in, then call endpoint with the token) and variable data from a CSV file. | P1 |
| LOAD-08 | Spike and Soak modes. | P1 |
| LOAD-09 | Distributed load from several worker machines for very high load. | P2 |

## Feature: Configuration

Everything the tool does is configurable without code, through the UI or a config file.

| ID | Requirement | Priority |
| --- | --- | --- |
| CFG-01 | Every monitor, alert rule, channel, network profile and test can be configured in the UI. | P0 |
| CFG-02 | Save tests as reusable templates and re-run them with one click. | P0 |
| CFG-03 | Export and import the full configuration as a JSON/YAML file. | P1 |
| CFG-04 | Global defaults (interval, timeout, failure threshold, retention period) that individual monitors can override. | P1 |
| CFG-05 | Environment variables and secrets (e.g. `{{API_TOKEN}}`) usable in URLs, headers and bodies, stored encrypted. | P1 |
| CFG-06 | Schedule load or latency tests to run automatically (e.g. nightly). | P2 |

## Non-functional requirements

| Area | Requirement |
| --- | --- |
| Scale | Support at least 500 active monitors on a single instance at a 30 s interval. |
| Load generation | Generate at least 5,000 requests/second from one 4-core machine against a fast endpoint. |
| Accuracy | Response-time measurements within 5% of a reference tool (e.g. curl timings). |
| Self-overhead | The tool must detect when it is itself the bottleneck (CPU above 85%) and warn that results may be unreliable. |
| Availability | The monitoring service targets 99.9% uptime; a crash must restart automatically and resume monitors. |
| Real-time | Dashboard reflects a state change within 2 s of the check completing. |
| Data retention | Raw checks kept 30 days, hourly rollups kept 1 year (both configurable). |
| Security | Login required; roles for Admin, Editor and Viewer; secrets encrypted at rest; HTTPS for the UI. |
| Responsible load testing | Load and stress tests only against targets on an allow-list set by an Admin, with a confirmation step, to prevent accidental attacks on third-party APIs. |
| Auditability | Log who created, changed or ran each monitor and test. |
| Usability | A new user can create a monitor and run a first test without documentation. Works on current Chrome, Firefox, Safari and Edge. |
| Deployment | Ships as a Docker image with one-command start; config via file and environment variables. |

## Technical approach

The recommended build is a server application with a web dashboard, because a browser alone cannot run scheduled checks around the clock or generate heavy load. Final technology choices are open for the engineering team.

- **Scheduler and monitor workers** run checks on each monitor's interval and evaluate success rules.
- **Load engine** runs concurrent requests with keep-alive connections and records every result for percentile calculations.
- **Network simulator** throttles bandwidth, adds latency and jitter, and drops packets per profile — in-process for HTTP, or through OS tools such as Linux `tc netem` for full accuracy.
- **Alert service** detects state changes and sends notifications through channel adapters.
- **Storage**: a time-series-friendly database (e.g. PostgreSQL with TimescaleDB, or SQLite for single-user installs).
- **Web dashboard** receives live updates over WebSocket or Server-Sent Events.
- **REST API** exposes every feature, so the UI and CI/CD use the same interface.

Suggested stack: Node.js or Go backend, React dashboard, Docker deployment. Open-source engines such as k6 or autocannon could power load generation instead of building from scratch.

## Assumptions and dependencies

- Target APIs are HTTP/HTTPS and reachable from where the tool is installed.
- Teams own, or have permission to load test, every API they stress test.
- Slack, Teams and email (SMTP) credentials are provided by the customer.
- Load results depend on the test machine's CPU and network, which users must be told.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Load test accidentally hits production or a third-party API | Outage or being blocked | Admin allow-list, confirmation prompt, production tag warning |
| Test machine becomes the bottleneck | Misleading throughput numbers | CPU monitoring and a warning on results; distributed workers later |
| Simulated network differs from real networks | Wrong conclusions about mobile users | Document the model; offer OS-level throttling for accuracy |
| Too many alerts lead to alert fatigue | Real outages ignored | Consecutive-failure threshold, maintenance windows, reminder limits |
| Stored API keys leak | Security breach | Encryption at rest, masking in UI and logs, role-based access |

## Release plan

The product ships in three phases; each phase starts only after the previous one passes its acceptance criteria.

1. **MVP (about 8 weeks):** uptime monitoring, dashboard with live alerts, Slack/email/webhook alerts, latency testing with preset network profiles, Fixed load and Stress modes, UI configuration. All P0 items.
2. **Version 1.1 (about 6 weeks after MVP):** custom network profiles, Ramp-up/Spike/Soak modes, run comparison, trends, maintenance windows, config import/export, secrets. All P1 items.
3. **Version 2.0:** CI/CD API, distributed load workers, scheduled tests, status page, SMS/phone alerts, more protocols (gRPC, GraphQL, WebSocket). P2 items.

## Acceptance criteria for MVP

- [ ] A monitor created in the UI starts checking within one interval with no restart.
- [ ] Stopping a test API turns its dashboard tile red within one interval × failure threshold + 2 s.
- [ ] A Down alert and a recovery alert both reach Slack and email.
- [ ] A latency test on Slow 3G shows clearly higher latency than No throttling for the same endpoint.
- [ ] A Stress test stops automatically at the configured error rate and reports the breaking load.
- [ ] Load tests are refused for any host not on the allow-list.
- [ ] All reported percentiles match an offline calculation from the raw results.

## Open questions

- [ ] Self-hosted only, or also a hosted (SaaS) version?
- [ ] Build our own load engine, or wrap an open-source one such as k6?
- [ ] Which alert channels does the first customer team actually use?
- [ ] Is single sign-on (Google, Microsoft, Okta) needed for the MVP?
- [ ] Should monitors run from several regions to tell a local network problem from a real outage?

## Glossary

| Term | Meaning |
| --- | --- |
| Latency | Time from sending a request to receiving the full response |
| Throughput | Number of requests the API handles per second (RPS) |
| p95 / p99 | The response time that 95% / 99% of requests were faster than |
| Virtual user | A simulated client sending requests in a loop during a load test |
| Breaking point | The load level at which errors or latency exceed the configured limits |
| Degraded | The API responds correctly but slower than its threshold |
