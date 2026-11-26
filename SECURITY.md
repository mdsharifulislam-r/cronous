# Security policy

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability** (GitHub private vulnerability reporting). Include:

* the affected component (server, worker, scheduler, SDK, dashboard) and version or commit
* steps to reproduce, or a proof of concept
* the impact you expect: what an attacker gains

We aim to acknowledge reports within 3 working days and to agree on a disclosure date with you.
Fixes are released before details are published. Credit is given unless you prefer otherwise.

## Supported versions

Chronos is pre-1.0. Security fixes go into the latest release only.

## Scope and hardening notes

Chronos is designed to run inside your own infrastructure. The deployment guide
(`docs/DEPLOYMENT_GUIDE.md`) covers TLS, network exposure and secrets. Known limitations are listed
openly in `docs/architecture.md` and `docs/BACKEND_AUDIT.md`. The main ones:

* Delivery is at-least-once: handlers must be idempotent.
* Webhook credentials are stored unencrypted in PostgreSQL (masked in API responses). Protect
  database access and backups.
* Central-worker handlers run with the worker's database credentials. Mount only trusted code.

Reports about these documented trade-offs are welcome as regular issues or discussions.
