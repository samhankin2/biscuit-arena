# Deployment playbook — Arnott's Biscuit Arena

Everything learned while standing up this project on a free Oracle Cloud VPS with
a GitHub Pages frontend. Written so the next deployment (this app, a different
app, a rebuild from scratch) doesn't repeat the same dead ends.

**No secrets live in this file.** Secret *locations* are listed; secret *values*
are not.

---

## 1. The shape of the deployment

Two pieces, two origins, one URL for users:

| Piece | Where | Deployed by | Runs |
| --- | --- | --- | --- |
| Frontend | `https://samhankin2.github.io/biscuit-arena/` | `.github/workflows/pages.yml` | Static files from `public/`, published by GitHub Actions on every push. No server. |
| API + database | `https://arena.152.69.178.242.sslip.io` | `.github/workflows/deploy.yml` | One Node process on one Oracle VM, SQLite file on disk. |

The QR code points at the **Pages** URL. The frontend learns the API origin at
runtime from `public/api-config.js`, which the Pages workflow rewrites from the
repository variable `API_BASE_URL`. So the API address is changed in exactly one
place and never in code.

```
user's phone ──scan QR──> https://samhankin2.github.io/biscuit-arena/
                                    │  fetch(window.ARENA_API_BASE + "/api/config")
                                    ▼
                    https://arena.152.69.178.242.sslip.io/api/...
                                    │  Caddy (TLS) ─> node :3000 ─> SQLite
```

### Why this split

- GitHub Pages gives free HTTPS and a CDN for the frontend.
- The VPS holds the only stateful thing (SQLite), so it is the only thing that
  needs a server.
- The two are decoupled: the API can move hosts without touching the frontend,
  and the frontend can be re-hosted without touching the API.

### The rule that bites: HTTPS

- The app itself needs no camera (the phone's own Camera app scans the QR), so
  the *frontend* just needs to be HTTPS — GitHub Pages gives that free.
- If the frontend and API are on different origins, the **API must also be
  HTTPS**. A GitHub Pages (HTTPS) page calling an `http://` API is blocked by
  the browser as mixed content. No amount of CORS headers fixes that.
- `getUserMedia` (in-app camera scanning) is also HTTPS-only. We deleted the
  in-app scanner, so this no longer applies — but the rule stands if it comes
  back.

---

## 2. Oracle Cloud: what actually worked

### 2.1 Credentials

```
C:\Users\hanki\.oci\config        # OCI API key (this machine only, NOT in GitHub)
C:\Users\hanki\.oci\oci_api_key.pem
C:\Users\hanki\.oci\deploy_key.pub # deploy key for the *instance* (not CI)
C:\Users\hanki\.oci\arena_ci_key   # private half of the CI deploy key
```

The fingerprint in `~/.oci/config` must match the private key. Two formats exist:

- `c1:68:f3:55:0f:...` — MD5 style. **The OCI Python SDK's config validator only
  accepts this format** (`re.compile(r"^([0-9a-f]{2}:){15}[0-9a-f]{2}$")`), so use
  it in `config` even if the console shows a base64 SHA-256 fingerprint.
- `HhibPAtoqHapSv6TPxjmCTgErCiYwFvrSAha2gJY08I=` — base64 SHA-256, what the
  console shows for newer keys. Computed as
  `base64(sha256(DER of SubjectPublicKeyInfo))`.

The MD5 fingerprint is `":"`-joined hex of `md5(DER of SubjectPublicKeyInfo)`.

### 2.2 Getting a key into the tenancy

OCI has no self-service API to create API keys — one console action is
unavoidable:

1. Generate the keypair locally (`cryptography` — there is no `openssl` on this
   Windows box).
2. Oracle console → Identity & Security → Users → your user → **API Keys** →
   **Add API Key** → **Paste Public Key**.
3. The console then confirms the fingerprint.

### 2.3 The launch request — the part that cost the most time

`POST https://iaas.<region>.oraclecloud.com/20160918/instances` returned
`400 CannotParseRequest` for every body until these three things were right:

1. **`availabilityDomain` is required.** Omitting it was the root cause. Get it
   from `ListAvailabilityDomains` (CLI: `oci iam availability-domain list`).
2. **`user_data` must be Base64 encoded.** Raw text is rejected.
3. **`sourceDetails` uses `sourceType: "image"` (lowercase) and `imageId`** in
   the current API — not the older `"IMAGE"` / `sourceId`.

Working body:

```json
{
  "availabilityDomain": "sRib:AP-MELBOURNE-1-AD-1",
  "compartmentId": "<tenancy ocid>",
  "displayName": "biscuit-arena",
  "shape": "VM.Standard.E2.1.Micro",
  "sourceDetails": {
    "sourceType": "image",
    "imageId": "<platform image ocid>",
    "bootVolumeSizeInGBs": 50
  },
  "createVnicDetails": {
    "subnetId": "<public subnet ocid>",
    "assignPublicIp": true
  },
  "metadata": {
    "ssh_authorized_keys": "<public key>",
    "user_data": "<base64 of bootstrap.sh>"
  }
}
```

Notes:
- No top-level `subnetId` or `imageId` — they live inside `createVnicDetails`
  and `sourceDetails`.
- `shapeConfig` **only** for Flex shapes (`VM.Standard.A1.Flex`:
  `{"ocpus": 2, "memoryInGBs": 12}`). Fixed shapes like `E2.1.Micro` must not
  have one.
- `platformConfig` is not required.
- No `assignPublicIp` / `preserveBootVolume` at the top level in the current
  API.

### 2.4 Rate limiting (429)

Failed launch attempts still count. After ~10 attempts in a few minutes, the
service returns `HTTP 429 TooManyRequests "Too many requests for the user"`.
This is throttling, **not** a quota and **not** capacity:

- capacity errors look like `Out of host capacity` — check with
  `oci compute compute-capacity-report create`;
- quota errors name the exceeded limit;
- 429 has no API to inspect the remaining budget.

**Rule: one launch attempt, then stop and read the error.** Don't cycle request
variants. Wait 10+ minutes between real attempts.

### 2.5 OCI Python SDK 2.189.0 — model naming quirks

The current SDK renamed things; `oci.network` does not exist and the old model
names fail. What actually works:

| Thing | Correct name in 2.189.0 |
| --- | --- |
| Networking client | `oci.core.VirtualNetworkClient` |
| VNIC attachments | `compute.list_vnic_attachments(...)` (on the **compute** client) |
| Security list rule | `oci.core.models.IngressSecurityRule` |
| Shape config | `oci.core.models.LaunchInstanceShapeConfigDetails` |
| Source details | `oci.core.models.InstanceSourceViaImageDetails(source_type="image", image_id=...)` |
| VNIC details | `oci.core.models.CreateVnicDetails(subnet_id=..., assign_public_ip=True)` |
| Availability domains | `oci.identity.IdentityClient(...).list_availability_domains(compartment_id=...)` |
| Waiting for a state | `oci.wait_until(client, client.get_instance(id), property="lifecycle_state", state="RUNNING", ...)` — there is no `Response.wait_for_state` |
| Images | `compute.list_images(compartment_id=...)` is **paginated**; loop on `next_page` |
| OS sources | `list_os_sources` is not on the identity client in this version — filter `list_images` by display name instead |

Image display names look like `Canonical-Ubuntu-24.04-aarch64-2026.09.18-0` and
`Canonical-Ubuntu-24.04-2026.09.18-0` (the latter is x86_64; the arch only
appears in the name for aarch64).

### 2.6 OCI CLI on Windows

The CLI is not on PATH and is awkward to install:

- `pip install oci_cli` **fails on Python 3.14** (PyYAML has no wheel).
- The offline bundle (`oci-cli-<ver>-Windows-Server-2019-Offline.zip` from the
  `oracle/oci-cli` GitHub release) ships wheels for cp310–cp313 only.
- Installing it under a long path fails with `OSError ... No such file or
  directory` because of the Windows 260-character path limit — install the venv
  to something short.

What worked:

```powershell
# 1. Python 3.13 (the system 3.14 cannot build the CLI's deps)
Invoke-WebRequest https://www.python.org/ftp/python/3.13.7/python-3.13.7-amd64.exe -OutFile py313.exe
Start-Process py313.exe -ArgumentList "/quiet","InstallAllUsers=0","Include_pip=1","TargetDir=$env:LOCALAPPDATA\Python313" -Wait

# 2. Short-path venv + offline wheels
C:\Users\hanki\AppData\Local\Python313\python.exe -m venv C:\oci
C:\oci\Scripts\pip.exe install oci_cli `
  --find-links "$env:LOCALAPPDATA\oci-cli\oci-cli-installation\cli-deps\python313.html" `
  --no-index --ignore-requires-python

# 3. Use it
C:\oci\Scripts\oci.exe compute instance launch ... --no-retry
```

Set `SUPPRESS_LABEL_WARNING=True` to silence the key-label warning. The CLI
reads the same `~/.oci/config`.

**When the CLI is available, prefer it for launch** — it Base64-encodes
`--user-data-file`, serialises the body canonically, and `--debug` shows the
exact request.

---

## 3. The network gotchas (each one cost real time)

### 3.1 Oracle's image-level iptables silently drops 80/443

Oracle's Ubuntu cloud images install an iptables rule that **rejects everything
except SSH, before the ufw chains** — so `ufw allow 80` appears to do nothing:

```
-A INPUT -p tcp -m state --state NEW -m tcp --dport 22 -j ACCEPT
-A INPUT -j REJECT --reject-with icmp-host-prohibited   <-- fires before ufw
-A INPUT -j ufw-before-input                           <-- never reached
```

Symptom: SSH works, HTTP/HTTPS time out from the internet even though the OCI
security list and ufw both allow the ports.

Fix (insert *before* the REJECT rule, then persist):

```bash
sudo iptables -I INPUT 4 -p tcp --dport 80  -j ACCEPT
sudo iptables -I INPUT 5 -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save || sudo sh -c 'iptables-save > /etc/iptables/rules.v4'
```

### 3.2 The security list that matters is the subnet's, not the VCN's default

Rules are attached to security lists, and a subnet can reference a list other
than the VCN default. Always check the subnet's `security_list_ids` and open
the ports there.

### 3.3 Instance metadata may not contain the public IP

`http://169.254.169.254/opc/v2/instance/` in this region has **no `publicIp`
key** (it does have `agentConfig`, `availabilityDomain`, `displayName`,
`hostname`, `id`, `image`, `metadata`, `region`, …). A bootstrap script that
does `json.load(...)["publicIp"]` dies with `KeyError`.

Fallback: the instance's outbound IP is its public IP, so use
`curl -s https://api.ipify.org`. Better still: pass the IP in at deploy time.

### 3.4 Route tables decide whether a subnet is "public"

`public_access` does not exist on the SDK's `Subnet` model; the real signal is
`prohibit_public_ip_on_vnic` (False = public IPs allowed) plus a route table
with an internet gateway (`0.0.0.0/0 -> ocid1.internetgateway...`).

---

## 4. TLS without a domain

`arena.<public-ip>.sslip.io` is a real public DNS name that resolves straight
to the IP, so Caddy can obtain a normal Let's Encrypt certificate with zero
DNS setup and zero cost. Same trick works with `nip.io`.

Caddy config (`/etc/caddy/Caddyfile`):

```
arena.152.69.178.242.sslip.io {
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
		-Server
	}
	reverse_proxy 127.0.0.1:3000
}
```

Gotchas:
- Let's Encrypt's `tls-alpn-01` challenge needs **443**, `http-01` needs
  **80**; if 443 is blocked the fallback to `http-01` still works, but if both
  are blocked the log says `Error getting validation data` and nothing else.
- `sslip.io` is shared by thousands of people → LE rate limits for that
  registered domain are a real risk. A hostname you own removes the risk.
- Don't restart Caddy in a loop while it retries: it burns LE rate limit.
- `systemctl restart caddy` is safer than `reload` (the package may not have
  Caddy running yet).

---

## 5. The deploy pipeline (CI → SSH)

### 5.1 The pattern

```
git push  →  GitHub Actions  →  SSH to VPS  →  /usr/local/bin/arena-deploy
                                             ├─ git fetch + fast-forward main
                                             ├─ npm ci --omit=dev  (only if package.json changed)
                                             ├─ write commit SHA to /var/lib/biscuit-arena/commit.txt
                                             ├─ systemctl restart arena
                                             ├─ health check /api/health for 15s
                                             └─ on failure: git reset --hard <prev> + restart + exit 1
```

The workflow then re-checks the public URL, so a bad deploy is a red X on the
commit and never reaches users.

### 5.2 Wiring

- **VPS**: `/usr/local/bin/arena-deploy` (root-owned, 0755), git checkout at
  `/opt/biscuit-arena`, database at `/var/lib/biscuit-arena` (outside the code
  directory so deploys never touch data).
- **CI key**: `~/.oci/arena_ci_key` (private) + `.pub`; public half appended to
  `/home/ubuntu/.ssh/authorized_keys` on the VPS; private half stored as the
  GitHub secret `ARENA_SSH_KEY`.
- **GitHub**: secret `ARENA_SSH_KEY`, variable `ARENA_HOST`, environment
  `production`.
- The deploy script **self-refreshes**: after merging, it copies
  `deploy/arena-deploy.sh` from the repo over `/usr/local/bin/arena-deploy`, so
  the box's copy tracks the repo. (The run that introduces the change can't
  refresh itself — install it once by hand, then it's automatic forever.)

### 5.3 Two bugs worth remembering

- **Compare commits, not trees.** `git diff --quiet HEAD origin/main` compares
  *content*. After a revert that restores identical content, the box would
  report "already up to date" and never advance its HEAD. Use
  `git rev-parse HEAD` vs `git rev-parse origin/main`.
- **Self-refresh needs one manual install** (see above), otherwise the box
  keeps running the old script forever.

### 5.4 Verify the rollback path for real

Push a deliberately broken commit and confirm the workflow goes red while the
public API stays healthy. A rollback mechanism that has never been exercised is
a rumour, not a feature.

---

## 6. GitHub Pages: the parts that aren't obvious

### 6.1 Publishing

`POST /repos/{owner}/{repo}/pages` with `{"build_type": "workflow"}` enables
Pages via Actions. The workflow then needs `permissions: { pages: write,
id-token: write }` and `actions/deploy-pages@v4`.

### 6.2 Sub-path hosting

A project site is served from `https://user.github.io/<repo>/`, so **absolute
asset paths (`/app.js`) 404**. Use relative paths (`app.js`, `style.css`,
`vendor/x.js`). The API base is a separate concern — handled by
`window.ARENA_API_BASE` rather than by the path.

### 6.3 Injecting config at deploy time

Don't edit `api-config.js` in code — let the workflow write it from a repo
variable:

```yaml
- name: Prepare static site
  run: |
    mkdir -p _site
    cp -r public/. _site/
    printf 'window.ARENA_API_BASE = "%s";\n' '${{ vars.API_BASE_URL }}' > _site/api-config.js
```

Then change the API address in **Settings → Secrets and variables → Actions →
Variables** only.

### 6.4 Repository secrets via the API (no web UI)

GitHub encrypts secrets with the repo's public key using a **libsodium sealed
box**. With Python:

```python
import base64, requests, nacl.public, nacl.encoding

key_info = requests.get(f"{api}/actions/secrets/public-key", headers=headers).json()
public_key = nacl.public.PublicKey(key_info["key"].encode(), nacl.encoding.Base64Encoder())
sealed = nacl.public.SealedBox(public_key).encrypt(value.encode())   # SealedBox, not public_key.encrypt
payload = {"encrypted_value": base64.b64encode(sealed).decode(), "key_id": key_info["key_id"]}
requests.put(f"{api}/actions/secrets/{name}", headers=headers, json=payload)
```

Variables are plain JSON: `POST /actions/variables` (409 → `PATCH
/actions/variables/{name}` to make it idempotent).

### 6.5 Getting a GitHub token without the CLI

`gh` isn't installed here, but Git Credential Manager holds a token on this
Windows machine:

```powershell
$cred = "protocol=https`nhost=github.com`n`n" | git credential-manager get
$token = ($cred | Where-Object { $_ -like "password=*" }) -replace '^password=',''
$headers = @{ Authorization = "Bearer $token"; Accept = "application/vnd.github+json" }
```

Keep it in a variable, never write it to disk, never commit it. (The token
here has repo + workflow + admin scope; it can read repo variables and dispatch
workflows.)

---

## 7. Verifying a deployment

| Check | Command |
| --- | --- |
| App alive | `curl https://arena.<ip>.sslip.io/api/health` → `{"ok":true,"submissions":0,"commit":"<sha>"}` |
| Which commit is live | same call — `commit` comes from `/var/lib/biscuit-arena/commit.txt` |
| CORS works | `curl -i -X OPTIONS https://<api>/api/config -H "Origin: https://samhankin2.github.io" -H "Access-Control-Request-Method: POST"` → `204` + `access-control-allow-origin: https://samhankin2.github.io` |
| Pages points at the API | `curl https://samhankin2.github.io/biscuit-arena/api-config.js` → `window.ARENA_API_BASE = "https://arena..."` |
| Service state | `ssh … "sudo systemctl status arena; sudo journalctl -u arena -f"` |
| Boot log | `ssh … "sudo tail -n 120 /var/log/biscuit-bootstrap.log"` |
| Instance state | `oci compute instance get --instance-id <id> --query "data.lifecycle-state" --raw-output` |

### Browser-level end-to-end

The real proof is a headless browser against the **live** Pages URL, because
that exercises the cross-origin path (mixed content, CORS, relative assets):

```powershell
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
Start-Process $edge -ArgumentList "--headless=new","--remote-debugging-port=9222",`
  "--disable-gpu","--user-data-dir=$env:TEMP\opencode\live-cdp","about:blank" -WindowStyle Hidden
```

Then drive it over CDP (`http://localhost:9222/json/list` → WebSocket):
`Emulation.setDeviceMetricsOverride` for a phone viewport, `Page.navigate`,
`Runtime.evaluate` to fill the form and click stars, `Page.captureScreenshot`
for evidence. Check `Runtime.exceptionThrown` and `Runtime.consoleAPICalled`
(error type) for silent failures, and `document.documentElement.scrollWidth` for
horizontal overflow.

---

## 8. Credentials map

| Credential | Where it lives | Scope | Rotate by |
| --- | --- | --- | --- |
| GitHub account token | Git Credential Manager on this machine | repo, workflow, admin | GitHub → Settings → Developer settings |
| GitHub secret `ARENA_SSH_KEY` | GitHub → repo → Settings → Secrets and variables → Actions | SSH to the VPS | New keypair → new secret → append new `.pub` to `authorized_keys` → remove old line |
| GitHub variable `API_BASE_URL` | same page, Variables tab | frontend API origin | edit in the UI |
| GitHub variable `ARENA_HOST` | same page, Variables tab | VPS IP for CI | edit in the UI |
| OCI API key | `C:\Users\hanki\.oci\oci_api_key.pem` + `config` | this tenancy | console → add key → new local keypair → update `config` |
| VPS deploy key (personal) | `C:\Users\hanki\.ssh\biscuit_arena_oracle` | SSH as `ubuntu` | as above |

Rules: never commit any of these; never print a token into a log or a file;
prefer the in-memory variable pattern above.

---

## 9. Build-from-scratch checklist

1. Install Python 3.13 → venv at `C:\oci` → install the OCI CLI offline.
2. Generate an OCI API keypair locally; upload the public key in the console;
   write `~/.oci/config` with the **MD5-style** fingerprint.
3. Inventory the tenancy: VCNs, subnets, route tables, security lists, images,
   existing instances, availability domains.
4. Open TCP 80/443 in the security lists **attached to the public subnet**.
5. Launch the instance (CLI preferred): availability domain, `sourceType: image`
   + `imageId`, `createVnicDetails.subnetId` + `assignPublicIp`, Base64
   `user_data`, SSH public key. One attempt, then read the error.
6. Wait for RUNNING, read the public IP from the VNIC.
7. Fix the image-level iptables (insert accepts for 80/443 before the REJECT
   rule, persist).
8. Point Caddy at `arena.<ip>.sslip.io`, `caddy validate`, `systemctl restart
   caddy`; wait for the certificate.
9. Create the GitHub repo via API, push, enable Pages with
   `{"build_type": "workflow"}`.
10. Add the Pages workflow with the variable-injection step; set
    `API_BASE_URL`; push; confirm the deployed `api-config.js`.
11. Add the deploy workflow, the CI keypair, the `ARENA_SSH_KEY` secret and the
    `ARENA_HOST` variable; install `arena-deploy` on the box.
12. **Test the rollback** with a broken commit.
13. Run the browser end-to-end against the live URL.

---

## 10. Troubleshooting table

| Symptom | Cause | Fix |
| --- | --- | --- |
| `400 CannotParseRequest` on launch | missing `availabilityDomain`; raw `user_data`; `"IMAGE"`/`sourceId` | see §2.3 |
| `429 TooManyRequests` on launch | request throttling from repeated attempts | stop; wait 10+ min; one attempt at a time |
| `Out of host capacity` | no capacity for that shape | `oci compute compute-capacity-report create`, try another shape/AD |
| SSH works, HTTP/HTTPS time out | Oracle's image iptables REJECTs before ufw | insert accepts before the REJECT rule (§3.1) |
| Ports open in the console but not reachable | wrong security list | open on the subnet's own lists (§3.2) |
| `KeyError: 'publicIp'` in bootstrap | region metadata has no public IP | fall back to `api.ipify.org` (§3.3) |
| `Error getting validation data` (ACME) | LE cannot reach 80/443 | fix iptables; check the security list |
| LE `rate limited` | shared `sslip.io` domain | use your own hostname, or wait |
| Pages asset 404s | absolute paths under a repo sub-path | use relative paths (§6.2) |
| Browser: mixed content / CORS error | API not HTTPS, or missing CORS headers | TLS + `Access-Control-Allow-Origin` echo, `OPTIONS` → 204 |
| `InvalidConfig: {'fingerprint': 'malformed'}` | SDK rejects the base64 SHA-256 fingerprint | use the `c1:68:...` MD5-style format |
| SDK `AttributeError` on a model | SDK 2.189.0 renamed things | see the table in §2.5 |
| pip install of the OCI CLI fails | Python 3.14 has no PyYAML wheel | install Python 3.13; short venv path (§2.6) |
| Box HEAD lags behind `main` | tree comparison instead of commit comparison | compare `git rev-parse` (§5.3) |
