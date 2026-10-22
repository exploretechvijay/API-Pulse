# Security Policy

API Pulse stores API credentials and can generate heavy traffic, so we take security seriously. Thank you for helping keep it and its users safe.

## Supported versions

Security fixes are made for the latest release on the `main` branch.

| Version | Supported |
| --- | --- |
| 1.x (latest) | ✅ |
| < 1.0 | ❌ |

## Reporting a vulnerability

**Please do not report security vulnerabilities in public issues, discussions or pull requests.**

Report them privately through GitHub:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability** ([direct link](https://github.com/exploretechvijay/API-Pulse/security/advisories/new)).
3. Describe the issue, the affected version or commit, steps to reproduce, and the impact you expect.

What to expect:

- **Acknowledgement** within 3 business days.
- **An initial assessment** (confirmed / not reproducible / needs more information) within 7 days.
- **A fix and a security advisory** as soon as possible, depending on severity. We will credit you in the advisory unless you prefer to stay anonymous.

Please give us reasonable time to release a fix before disclosing the issue publicly.

## Scope

In scope – for example:

- Authentication or authorization bypass (logging in without a valid account, a Viewer performing Editor/Admin actions)
- Exposure of secrets (auth tokens, passwords, webhook URLs, variables) in the UI, API, exports, logs or notifications
- Bypassing the load-test allow-list or confirmation step
- Cross-site scripting, cross-site request forgery, injection (SQL, command, header/SMTP)
- Server-side request forgery beyond what the monitoring feature intentionally allows (see below)
- Weaknesses in how secrets are encrypted or keys are handled

Out of scope:

- **Monitors and tests making requests to the URLs users configure.** Sending HTTP requests to user-defined targets is the core purpose of the app. Limit who can create monitors with roles, and place API Pulse in a network segment appropriate for that.
- Denial of service caused by an authorised user running a load test against an allow-listed host
- Vulnerabilities that need physical access, a compromised host, or a stolen admin account
- Missing hardening on deployments that ignore the guidance below (e.g. exposed over plain HTTP)

## Hardening checklist for self-hosters

- **Serve the UI over HTTPS** (bundled Caddy profile, your own reverse proxy, or `TLS_CERT_FILE`/`TLS_KEY_FILE`) and set `SECURE_COOKIES=true`.
- **Set a strong `APP_SECRET`** and store it in a secrets manager. It encrypts tokens, passwords and webhook URLs at rest.
- **Protect the data volume** (`/data`): it contains the database and, if `APP_SECRET` is unset, the encryption key. Back it up and restrict access.
- **Use least privilege:** give most people the *Viewer* or *Editor* role, and keep *Admin* to a few people.
- **Keep the load-test allow-list short** and only add hosts you own or are permitted to test.
- **Rotate API tokens** used by CI regularly, and revoke unused ones under *Settings → API tokens*.
- **Do not expose API Pulse to the public internet** unless you need to; the public status page (`/status`) can be shared on its own.
- **Stay up to date:** `git pull && docker compose up -d --build`. Dependabot keeps dependencies current in this repository.

## Built-in security features

- Passwords hashed with bcrypt; HttpOnly, SameSite session cookies; login rate limiting
- Role-based access control (Admin / Editor / Viewer) and a full audit log
- Secrets encrypted with AES-256-GCM and masked in the UI, API responses and exports
- Origin check for state-changing requests, a Content Security Policy and other security headers
- Non-root container user
