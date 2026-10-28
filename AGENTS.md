# AGENTS.md

Working notes for any agent (or human) picking up this repository.

## What this is

"Arnott's Biscuit Arena" — an office activity. Staff open one web page, rate 10
Arnott's biscuits from 1–5, and submit. Results go to a SQLite database on a
free Oracle Cloud VPS and appear on a live leaderboard. The QR code printed for
the event points at the GitHub Pages URL; the phone's own Camera app scans it.

## Read this first

**`docs/DEPLOYMENT.md`** — the full deployment playbook. Everything about
standing up the Oracle VPS, the GitHub Pages setup, the CI→SSH deploy
pipeline, the CORS/HTTPS requirements, the OCI API quirks and the failure modes
we actually hit (missing `availabilityDomain`, Base64 `user_data`, Oracle's
iptables REJECT rule, LE rate limits on `sslip.io`, and more). Read it before
touching infrastructure — it will save an hour.

## Layout

```
public/            static frontend (no build step, no dependencies)
server.js          API + static file server (node:http + node:sqlite, zero deps)
data/config.json   the 10 biscuits, the app title
data/arena.db      SQLite database (git-ignored)
deploy/            VPS provisioning, bootstrap, deploy script
docs/DEPLOYMENT.md the playbook
```

## Ground rules

- **No secrets in the repo.** Tokens and keys live in GitHub Actions secrets
  (`ARENA_SSH_KEY`), GitHub Actions variables (`API_BASE_URL`, `ARENA_HOST`),
  and `C:\Users\hanki\.oci\` on the local machine. Never commit, never paste a
  token into a file or a log.
- **The database is not in the repo.** It lives on the VPS at
  `/var/lib/biscuit-arena/arena.db`. Deploys never touch it.
- **The frontend must keep working from a sub-path.** Asset paths in
  `public/index.html` are relative on purpose (`app.js`, not `/app.js`) because
  GitHub Pages serves this at `/biscuit-arena/`.
- **The API origin is injected at deploy time.** Edit the `API_BASE_URL`
  repository variable, not `public/api-config.js`.
- **Push to `main` deploys everything.** The Pages workflow publishes the
  frontend; the deploy workflow SSHes to the VPS, restarts the service,
  health-checks it and rolls back if it fails. Check the Actions tab after
  pushing.

## Commands

```bash
node server.js                      # run locally (port 3000, no npm install needed)
node --check public/app.js          # syntax check the frontend
python deploy/oci_provision.py      # provision the VPS (dry run; ARENA_LAUNCH=1 to launch)
```

## Verifying a change

- API: `curl https://arena.152.69.178.242.sslip.io/api/health` →
  `{"ok":true,"submissions":0,"commit":"<sha>"}`
- The `commit` field tells you exactly which commit is live.
- For UI work, drive the live Pages URL in headless Edge over CDP — that is
  the only way to catch the cross-origin failures (§7 of the playbook).
