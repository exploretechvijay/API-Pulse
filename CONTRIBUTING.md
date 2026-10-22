# Contributing to API Pulse

Thanks for your interest in improving API Pulse! Bug reports, ideas, documentation fixes and code are all welcome. By taking part you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug** – open an issue using the *Bug report* form. Include steps to reproduce, what you expected, and the server logs.
- **Suggest a feature** – open an issue using the *Feature request* form and describe the problem you want to solve.
- **Improve the docs** – typos, unclear setup steps and missing examples are great first contributions.
- **Write code** – look for issues labelled `good first issue` or `help wanted`, or comment on an issue to say you are working on it.

Security problems must **not** be reported in public issues – see [SECURITY.md](SECURITY.md).

## Development setup

Requirements: **Node.js 20+**, npm 10+, Git. Docker is optional (only needed to test the image).

```bash
git clone https://github.com/<your-username>/API-Pulse.git
cd API-Pulse
npm install

# terminal 1 – API server with auto-reload (http://localhost:8080)
npm run dev:server

# terminal 2 – web UI with hot reload (http://localhost:5173, proxies /api to :8080)
npm run dev:web

# terminal 3 (optional) – demo API to monitor and load test (http://localhost:4000)
npm run mock-api
```

Open <http://localhost:5173> and create the admin account. Development data goes to `./data` (git-ignored); delete the folder to start fresh.

### Useful commands

| Command | What it does |
| --- | --- |
| `npm test` | Server unit tests (`node --test`) |
| `npm run build` | Production build of the web UI into `web/dist` |
| `npm start` | Run the server with the built UI, like production |
| `docker compose up -d --build` | Build and run the Docker image |

## Project structure

```
server/src/
  index.js            app wiring and startup
  db.js               SQLite schema, migrations, settings
  http/               HTTP client with phase timings + network simulator (throttle.js)
  monitor/            monitor model, rules & state machine, scheduler, stats & retention
  alerts/             alert lifecycle, channel adapters (Slack/Teams/email/webhook), maintenance
  tests/              latency engine, load engine (worker thread), run manager, scheduling
  routes/             REST API (one file per area)
server/test/          unit tests
web/src/
  pages/              one component per screen
  components/         shared UI (ui.jsx), charts, request editor, run summary
  insights.js         rules that produce the plain-language test summaries
  styles.css          design tokens (light/dark) and styles
```

## Guidelines

### Code

- **Match the surrounding code.** Plain modern JavaScript (ES modules), small focused functions, comments that explain *why* rather than *what*.
- **No new dependencies without discussion.** API Pulse aims to stay a single, easy-to-host container; open an issue first if a change needs a new package.
- **Keep the server responsive.** Heavy work (load generation, large computations) belongs in the worker thread, not on the main event loop that runs the scheduler and API.
- **Never log or return secrets.** Use the existing encryption (`crypto.js`) and masking helpers for anything sensitive.
- **Database changes** go in a **new** migration appended to the `migrations` array in `server/src/db.js`. Never edit a migration that has already shipped.
- **Every UI feature also works through the REST API**, so CI/CD can use it. Write actions are audited with `audit()`.

### UI

- Use the components in `web/src/components/ui.jsx` and the CSS variables in `styles.css` – no hard-coded colours.
- Check new screens in **light and dark** themes and on a **narrow (mobile) screen**.
- Status colours are reserved for Up / Degraded / Down and always come with an icon or label, never colour alone.
- Charts use one y-axis; show two measures with different units as two charts.

### Tests

- Add or update tests in `server/test/` for logic changes – rules, statistics, the throttle, templating, parsing.
- Measurement code must stay accurate: percentiles use the nearest-rank method on raw samples, and changes to timing or throttling should include a test that proves the numbers.

### Commits and pull requests

1. Fork the repository and create a branch from `main`: `git checkout -b fix/stress-stop-condition`.
2. Make focused commits with clear messages in the imperative mood, e.g. `Add jitter to custom network profiles`.
3. Make sure `npm test` and `npm run build` pass.
4. Open a pull request and fill in the template: what changed, why, and how you tested it. Link the issue (`Fixes #123`).
5. CI runs the tests, the web build and a Docker smoke test. A maintainer will review; please respond to feedback and keep the PR up to date with `main`.

Small, focused pull requests are reviewed much faster than large ones. For bigger changes, open an issue to agree on the approach first.

## Releasing (maintainers)

1. Update the version in `package.json`, `server/package.json`, `web/package.json` and `server/src/config.js`.
2. Add a section to [CHANGELOG.md](CHANGELOG.md).
3. Tag the release: `git tag v1.x.y && git push origin v1.x.y`, then create a GitHub Release from the tag.

Thank you for helping make API Pulse better!
