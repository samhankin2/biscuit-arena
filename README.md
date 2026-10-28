# Arnott's Biscuit Arena

An office activity: everybody scans one QR code with their phone, rates the 10
Arnott's biscuits 1–5, and watches the live leaderboard. Ratings are stored in
SQLite on a small Node server.

- **Frontend**: static HTML/CSS/JS in `public/` — no build step, no dependencies.
- **Backend**: `server.js` — Node built-ins only (`node:http` + `node:sqlite`).
- **Database**: one SQLite file (`data/arena.db`).

```
public/            static frontend (also what GitHub Pages publishes)
server.js          API + static file server
data/config.json   the 10 biscuits, the title, the stations
data/arena.db      the SQLite database (git-ignored)
deploy/            VPS install script, systemd unit, Caddyfile
```

---

## 1. Run it locally

Requires Node 22.5+ (uses the built-in `node:sqlite`). No `npm install` needed —
there are no dependencies.

```bash
node server.js
# -> http://localhost:3000
```

Put it on your LAN so phones on the office wifi can reach it:

```bash
# Windows
$env:HOST=0.0.0.0; node server.js
# Linux/macOS
HOST=0.0.0.0 node server.js
```

Then find the machine's LAN IP (`ipconfig` / `ip addr`) and open
`http://<lan-ip>:3000` on a phone. Note: the camera is not used, so plain HTTP is
fine for a local test — but see the HTTPS note below for anything public.

## 2. Deploy to the Oracle VPS (free tier)

The VPS runs the whole app (frontend + API), so the QR code points at one URL
and there is no cross-origin setup to worry about.

```bash
# on the VPS
sudo bash deploy/install-vps.sh /path/to/biscuit-arena
```

That script installs Node 24 and Caddy, copies the app to `/opt/biscuit-arena`,
starts it as a systemd service on `127.0.0.1:3000`, and opens ports 80/443.

Then:

1. Point a hostname at the VPS (an A record in your DNS). Free options: a
   DuckDNS subdomain, a Cloudflare domain, or any domain you already own.
2. Put the hostname in the Caddy config and reload:

   ```bash
   printf 'arena.yourdomain.com {\n\treverse_proxy 127.0.0.1:3000\n}\n' > /etc/caddy/Caddyfile
   systemctl reload caddy
   ```

   Caddy gets a free Let's Encrypt certificate automatically.
3. In the **Oracle Cloud console → Networking → Security Lists**, add ingress
   rules for TCP 80 and 443. Oracle images also ship an iptables rule that
   blocks those ports, so on the instance run:

   ```bash
   sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```

4. Check it works: `curl https://arena.yourdomain.com/api/health`.

### Why HTTPS matters

The app itself needs no camera — your phone's Camera app scans the QR and
opens the link. But if the frontend is hosted on **GitHub Pages** (HTTPS) and
calls an API over plain **HTTP**, the browser blocks it as mixed content. So
the API needs HTTPS too whenever the two are on different origins.

### No domain at all?

Run a Cloudflare Tunnel instead of Caddy — it gives you an HTTPS URL with no
domain, no port opening, and no certificate:

```bash
cloudflared tunnel --url http://127.0.0.1:3000
```

The URL changes every restart unless you use a named tunnel (free, needs a
Cloudflare account). Good enough for a one-off Friday event; use Caddy + a
hostname if you want a stable link on the printed QR.

## 3. Or: frontend on GitHub Pages, API on the VPS

Also supported, and the QR can point at the GitHub Pages URL.

1. Push this repo to GitHub.
2. **Settings → Pages → Source: GitHub Actions**. The workflow in
   `.github/workflows/pages.yml` publishes the `public/` folder.
3. Set the API origin in `public/api-config.js` before publishing:

   ```js
   window.ARENA_API_BASE = "https://api.yourdomain.com";
   ```

   Leave it empty when the frontend and API are served by the same app.
4. The API already sends permissive CORS headers (`Access-Control-Allow-Origin`
   echoes the request origin, preflight `OPTIONS` returns 204), so the
   cross-origin calls work.

The frontend uses **relative asset paths**, so it works from a GitHub Pages
sub-path (`https://you.github.io/biscuit-arena/`) as well as from the domain
root.

## 4. Deploying changes to the API

**Push to `main` and that's it.** `.github/workflows/deploy.yml` runs on every
push that touches the app, SSHes to the VPS and runs the deploy script:

```
git add -A && git commit -m "..." && git push
```

The deploy script (`deploy/arena-deploy.sh`, installed on the box as
`/usr/local/bin/arena-deploy`) does this:

1. `git fetch` + fast-forward `main` to the new commit
2. `npm ci --omit=dev` — only when `package.json` changed
3. writes the new commit SHA to `/var/lib/biscuit-arena/commit.txt`
4. restarts the `arena` systemd service
5. health-checks `http://127.0.0.1:3000/api/health` for 15 seconds
6. **rolls back** to the previous commit and restarts if the health check fails

The workflow then re-checks the public URL, so a failed deploy shows up as a
red X on the commit and never reaches users.

Confirm what is live at any time:

```bash
curl https://arena.152.69.178.242.sslip.io/api/health
# {"ok":true,"submissions":0,"commit":"5d62deea2415b0d21fa2d4ae4166931c919d7904"}
```

**Manual deploy** (no CI, useful if GitHub is down):

```bash
ssh -i ~/.ssh/biscuit_arena_oracle ubuntu@152.69.178.242 "sudo /usr/local/bin/arena-deploy"
```

### How the pieces are wired

| Piece | Where | Deployed by |
| --- | --- | --- |
| Frontend | `https://samhankin2.github.io/biscuit-arena/` | `.github/workflows/pages.yml` (auto, on push) |
| API | `https://arena.152.69.178.242.sslip.io` | `.github/workflows/deploy.yml` (auto, on push) |

The frontend reads the API origin from `public/api-config.js`; the Pages
workflow rewrites that file from the repository variable `API_BASE_URL`, so the
API address is changed in one place (Settings → Secrets and variables → Actions
→ Variables) and never in code.

Repository secrets/variables used by CI:

- secret `ARENA_SSH_KEY` — the CI deploy key's private half
- variable `ARENA_HOST` — the VPS public IP

## 5. Day-of operations

```bash
systemctl status arena         # is it up?
journalctl -u arena -f         # live logs
sudo systemctl restart arena   # restart without deploying
```

**Change the biscuits** — edit `data/config.json` (names, emoji, order) and
push. The deploy workflow restarts the service. Ratings already stored keep
working: the biscuit ids are the join key.

**Back up the results** — the whole database is one file:

```bash
sudo cp /var/lib/biscuit-arena/arena.db ~/arena-backup-$(date +%F).db
```

**Wipe the leaderboard** (before a new event):

```bash
sudo systemctl stop arena
sudo rm -f /var/lib/biscuit-arena/arena.db*
sudo systemctl start arena
```

**Print the QR code** — any QR generator works; point it at
`https://samhankin2.github.io/biscuit-arena/`. There is no QR generator in this
repo on purpose. Include a short line on the printout: *"Scan, rate all 10
biscuits, submit."*

## 6. API

| Method | Path                | Purpose                                        |
| ------ | ------------------- | ---------------------------------------------- |
| GET    | `/api/config`       | Title, subtitle, the 10 biscuits              |
| GET    | `/api/results`      | Leaderboard: averages, votes, champion         |
| GET    | `/api/health`       | Liveness, submission count, deployed commit    |
| GET    | `/api/submissions`  | Raw recent submissions (no auth, by design)    |
| POST   | `/api/submissions`  | `{ name, comment?, ratings:[{ id, score }] }`  |

`score` must be an integer 1–5. `id` must match a biscuit id from
`/api/config`.

There is no authentication: anyone who can reach the app can submit scores and
read the leaderboard. That was a deliberate choice for an internal event —
add a token check in `handleApi` if that ever stops being true.
