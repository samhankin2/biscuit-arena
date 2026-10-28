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

## 4. Day-of operations

```bash
systemctl status arena         # is it up?
journalctl -u arena -f         # live logs
sudo systemctl restart arena   # after changing data/config.json
```

**Change the biscuits** — edit `data/config.json` (names, emoji, order) and
restart the service. Ratings already stored keep working: the biscuit ids are
the join key.

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

**Print the QR code** — any QR generator works; point it at the app URL, e.g.
`https://arena.yourdomain.com`. There is no QR generator in this repo on
purpose. Include a short line on the printout: *"Scan, rate all 10 biscuits,
submit."*

## 5. API

| Method | Path                | Purpose                                        |
| ------ | ------------------- | ---------------------------------------------- |
| GET    | `/api/config`       | Title, subtitle, the 10 biscuits              |
| GET    | `/api/results`      | Leaderboard: averages, votes, champion         |
| GET    | `/api/health`       | Liveness + submission count                    |
| GET    | `/api/submissions`  | Raw recent submissions (no auth, by design)    |
| POST   | `/api/submissions`  | `{ name, comment?, ratings:[{ id, score }] }`  |

`score` must be an integer 1–5. `id` must match a biscuit id from
`/api/config`.

There is no authentication: anyone who can reach the app can submit scores and
read the leaderboard. That was a deliberate choice for an internal event —
add a token check in `handleApi` if that ever stops being true.
