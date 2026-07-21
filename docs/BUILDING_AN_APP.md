# Building an app for OpenMasjidOS

This is the hands-on guide for building an app that installs cleanly through the **OpenMasjidOS**
App Store. It is written for an agent (or person) starting a **new app repository**. The normative
contract is in [`../CLAUDE.md`](../CLAUDE.md) §2 and §4 — read it; this guide makes it concrete.

> **Mental model.** Each app is its **own public GitHub repo** that (1) builds and publishes a
> Docker image, and (2) describes itself with a `manifest.yaml` + `docker-compose.yml`. The
> **OpenMasjidAPPS** catalog repo just lists your repo in `registry.yaml` and aggregates it into the
> `catalog.json` the platform reads. The platform never sees your repo directly — only the
> `catalog.json` entry the catalog builds from it.

The fastest start: **copy a folder from [`../examples/`](../examples/) into your new repo's root**
and adapt it. The two examples (`prayer-times-display`, `announcements-board`) are complete and
working.

> **Make it look native.** Every app should match the OpenMasjidOS look — the **Sakīna Glass**
> material, color tokens (dark + light), motion, the dock, and voice. The full spec is in
> **[DESIGN.md](./DESIGN.md)** (copy-paste tokens + recipes). The easiest path: inherit the live
> appearance via the Fabric (§7) and drop in the tokens from DESIGN.md.

---

## 1. Repository layout

Create a public repo named **`openmasjid-<id>`** (the name must match the image your compose
references). Put these at the **repo root**:

```
openmasjid-<id>/
├── manifest.yaml                       # metadata + settings (see §3)
├── docker-compose.yml                  # the stack that runs (see §4)
├── icon.svg                            # square, simple, legible small
├── screenshots/
│   └── 1.svg                           # or .png
├── Dockerfile                          # only if you build your own image (see §5)
├── src/                                # your app's source (if building an image)
├── docker-entrypoint.d/                # runtime config injection (the static-site pattern, §6)
│   └── 40-omos-config.sh
└── .github/workflows/build-image.yml   # builds + pushes your image to GHCR (§5)
```

If you reference an **existing maintained public image**, you can skip `Dockerfile`, `src/`,
`docker-entrypoint.d/`, and the image workflow — just point the compose at that pinned image and
drive it via `settings`.

---

## 2. The rules (must-haves)

- `id` is kebab-case, matches `^[a-z0-9][a-z0-9-]{0,79}$`, and is the same everywhere (manifest +
  registry entry).
- The compose **pins** its image tag and **publishes** the web port.
- The compose references settings as `${KEY}` and passes them via `environment:`.
- **Least privilege:** no `privileged`; no host namespace (`network_mode: host`, `pid: host`,
  `ipc: host`, `userns_mode: host`, `cgroup: host`, `uts: host`); no `cap_add`, `devices`,
  `device_cgroup_rules`, `security_opt: …unconfined`, or `group_add` of root/docker; no Docker-socket
  or sensitive host-path mount (and no `..` escaping the app folder); no `extends:`/`include:`.
  Rejected by **both** the catalog build and the platform at install — an app needing these won't
  install, so use named volumes + `environment:` instead.
- The image is **public** and **multi-arch** (`linux/amd64,linux/arm64`).
- All masjid-specific values come from `settings` — the platform injects **no** masjid profile.
- Settings values are **single-line** (they become `KEY=VALUE` lines in a `.env`).

---

## 2b. Security requirements

Your app runs on a masjid's own machine and reaches every OpenMasjidOS install through the
auto-published `catalog.json`. These rules keep that supply chain safe. The catalog build prints a
**⚠ warning** when an app trips items 1; the platform's install-time consent gate enforces item 4.

1. **Digest-pin your published image.** Pin the **digest**, not just the tag — a tag can be moved to
   repoint at a *different* (backdoored) image even though the version string looks unchanged. Append
   `@sha256:<digest>` to the image reference in your `docker-compose.yml`:
   ```yaml
   services:
     app:
       # tag for humans + digest for integrity (the digest is what actually pins)
       image: ghcr.io/<owner>/openmasjid-my-app:1.0.0@sha256:1f2e…<64 hex>
   ```
   Get the digest after pushing with `docker buildx imagetools inspect ghcr.io/<owner>/openmasjid-my-app:1.0.0`
   (or read it from the GHCR package page). Bump both the tag and the digest on every release.
   *(Likewise, ask the catalog maintainer to pin your registry entry to an immutable `commit:` SHA, not
   a movable tag — see [`../registry.yaml`](../registry.yaml).)*

2. **Treat any Fabric SSO/session value as an IDENTITY assertion, never a credential.** The Fabric
   answer to *"is the current viewer the platform admin?"* is the **only** thing it tells you. Never
   use the session cookie, `OPENMASJID_APP_SECRET`, or any platform-provided value to call the
   platform's admin / tRPC API on the admin's behalf. The platform binds the dashboard to an
   origin-bound CSRF key, so your app **physically cannot act as the admin** even if it observes the
   session cookie — design accordingly: use the session check to gate *your own* features, nothing more.

3. **Use `https://` for cross-host deployments.** On the default trusted LAN, plain `http` is fine. But
   if your app ever runs on a *different host* from the platform, set an `https://` `OPENMASJID_BASE_URL`
   so your app's `OPENMASJID_APP_SECRET` and the forwarded session cookie are **not sent in cleartext**.
   Never downgrade an `https` base URL to `http`.

4. **Least-privilege compose (no exceptions).** No `privileged`; no host namespaces
   (`network_mode: host`, `pid: host`, `ipc: host`, …); no Docker-socket mount
   (`/var/run/docker.sock`); no sensitive host bind-mounts (`/etc`, `/root`, `/var`, `/`, or any `..`
   escape). The platform's consent gate **refuses or hard-warns** on these at install (and the catalog
   build rejects them at PR time) — so an app that needs them simply won't install. Use **named
   volumes** + `environment:` instead (see §4).

5. **HTTPS is required ONLY if your app uses Stripe.** Stripe's in-person M2 reader (Stripe Terminal
   SDK) and in-page card fields (Elements) require a browser **secure context** (HTTPS). If — and only
   if — your app uses Stripe, set **`https: true`** in `manifest.yaml`. The platform then serves your
   app over HTTPS on a dedicated port (it terminates TLS with the dashboard's certificate) and offers
   it to the admin as an `https://` URL. Your container itself stays a normal **HTTP** server — you do
   **not** handle TLS, ports, or certificates; just publish your web port as usual and the platform
   does the rest. **Every non-Stripe app must NOT set `https`** — those stay on plain HTTP, which is
   correct for a trusted LAN. (Tip: prefer Stripe-hosted **Checkout / Payment Links** where you can —
   card entry then happens on stripe.com — but the in-person reader still requires `https: true`.)

See also the SSO/notifications contract in [§7](#7-openmasjidos-fabric--appearance-single-sign-on--notifications-optional)
and the platform's [`docs/APP_MANIFEST_SPEC.md`](https://github.com/OpenMasjid-Solutions/OpenMasjidOS/blob/master/docs/APP_MANIFEST_SPEC.md).

---

## 3. `manifest.yaml` template

```yaml
id: my-app                          # kebab-case; equals the registry id
name: My App
tagline: One short line for the store card
category: displays                  # displays | donations | community | quran | admin | utilities
version: 1.0.0
author: Your Name
license: MIT                        # your choice (third-party). Official OpenMasjid apps: AGPL-3.0-only — see docs/APP_LICENSING.md
icon: icon.svg
screenshots:
  - screenshots/1.svg
description: |
  Markdown shown on the detail page. Explain what it does and how to use it after install.
settings:
  - key: MASJID_NAME
    label: Masjid name
    type: text
    default: Our Masjid
  - key: SOME_CHOICE
    label: A choice
    type: select
    options: [a, b, c]
    default: a
ports:
  - container: 80
    label: Web interface
# sso: true                         # OPTIONAL — opt into single sign-on (see §7)
# notifications: true               # OPTIONAL — relay messages to the masjid's webhook (see §7)
# stripe: true                      # OPTIONAL — fetch shared Stripe keys from the OS vault (see §7)
# domain: true                      # OPTIONAL — learn your public URL via /api/fabric/site (see §7)
# https: true                       # ONLY if your app uses Stripe (needs HTTPS) — see §2b.5
# fabric:                           # OPTIONAL — app-to-app broker (see §7). Catalog apps only.
#   provides:                       #   capabilities you SERVE at /fabric/<capability>/<method>
#     - capability: billing         #   kebab-case
#   consumes:                       #   capabilities you may CALL, "<target-app-id>/<capability>"
#     - students/billing
# tunnel: true                      # OPTIONAL — REQUEST internet exposure (admin confirms in Settings)
# email: true                       # OPTIONAL — POST /api/fabric/email to send mail (see §7)
# alerts:                           # OPTIONAL — admin gets a granular on/off per alert (see §7)
#   - id: reader-offline            #   kebab id you POST to /api/fabric/alert
#     label: Card reader offline
#     description: A payment reader stopped responding.
```

Field types: `text` | `number` | `password` | `boolean` | `select` (needs `options`). Use
UPPER_SNAKE_CASE keys. `icon`/`screenshots` are **paths in your repo** — the catalog rewrites them
to absolute URLs.

---

## 4. `docker-compose.yml` template

```yaml
services:
  app:
    # PINNED (tag + digest), public, matches your repo name. The @sha256 digest is
    # the real integrity pin — a moved tag must not repoint it (see §2b.1).
    image: ghcr.io/<owner>/openmasjid-my-app:1.0.0@sha256:<64 hex digest>
    restart: unless-stopped
    environment:
      MASJID_NAME: ${MASJID_NAME}
      SOME_CHOICE: ${SOME_CHOICE}
      # OpenMasjidOS Fabric — uncomment if your manifest sets sso/notifications.
      # These are delivered for ${VAR} substitution, so you MUST reference them
      # here or the platform's injected values never reach the container (see §7).
      # OPENMASJID_BASE_URL: ${OPENMASJID_BASE_URL:-}
      # OPENMASJID_APP_ID: ${OPENMASJID_APP_ID:-}
      # OPENMASJID_APP_SECRET: ${OPENMASJID_APP_SECRET:-}   # sso/notifications only
    ports:
      - "8080:80"          # host:container — pick a free default ≥ 1024; platform remaps conflicts
    volumes:
      - data:/data         # only if you need persistence
volumes:
  data:
```

---

## 5. Building & publishing the image (GHCR, multi-arch)

Use the ready-made workflow shipped in the examples:
[`../examples/prayer-times-display/.github/workflows/build-image.yml`](../examples/prayer-times-display/.github/workflows/build-image.yml).
Copy it to your repo's `.github/workflows/build-image.yml`. It:

- builds your `Dockerfile` for `linux/amd64,linux/arm64`,
- pushes `ghcr.io/<owner>/<repo-name>:<manifest version>` and `:latest`.

**One-time after the first run:** open your GitHub profile → **Packages** → the new package →
**Package settings** → change visibility to **Public**, so masjid hosts can pull it without auth.

Tag a release (`git tag v1.0.0 && git push --tags`) to publish a pinned version, then reference that
tag in both your compose and the registry entry.

---

## 6. The static-site pattern (recommended for simple apps)

Both examples are a static site served by `nginx:alpine`, with **install settings injected at
container start** into `config.js`. This keeps one image working for every masjid.

- Ship `src/config.js` with dev defaults that set `window.OMOS_CONFIG = {...}`.
- Add `docker-entrypoint.d/40-omos-config.sh` (nginx runs `*.sh` here before starting) that reads
  env vars and rewrites `config.js`. Copy it from an example; it JSON-escapes values safely.
- `Dockerfile`:
  ```dockerfile
  FROM nginx:1.27-alpine
  COPY src/ /usr/share/nginx/html/
  COPY docker-entrypoint.d/40-omos-config.sh /docker-entrypoint.d/40-omos-config.sh
  RUN chmod +x /docker-entrypoint.d/40-omos-config.sh
  EXPOSE 80
  ```
- Your page reads config from `window.OMOS_CONFIG`. No backend needed.

For apps that need a backend/database, build a normal multi-service compose instead (still pinned,
least-privilege, web port published, named volumes).

> Keep `*.sh` files **LF** line endings (add a `.gitattributes` with `*.sh text eol=lf`) so the
> entrypoint runs inside the Linux container.

---

## 7. OpenMasjidOS Fabric — appearance, single sign-on & notifications (optional)

The **OpenMasjidOS Fabric** is the platform↔app integration layer — the unified appearance + single
sign-on / API. Both halves are **optional and backwards-compatible** — your app must work standalone.
The platform never sends masjid data; this is presentation + auth convenience only. The full normative
contract lives in the platform repo's
[`docs/APP_MANIFEST_SPEC.md`](https://github.com/OpenMasjid-Solutions/OpenMasjidOS/blob/master/docs/APP_MANIFEST_SPEC.md).

**Appearance (no opt-in needed).** When the dashboard opens your app it appends a URL fragment
`#omos=<base64url JSON>` carrying `{ v, theme, wallpaper, wallpaperImage?, accent, lang }`
(presentation only). Read `location.hash` on load, apply + persist, then clear the hash. For live
theme changes, poll `GET ${OPENMASJID_BASE_URL}/api/public/appearance` (public, CORS-enabled).
The `#omos=` fragment is **attacker-craftable** — treat it as untrusted presentation input, never as
identity, and sanitize any URL you read (require `http(s)` on `wallpaperImage`).

**Single sign-on — opt in with `sso: true`.** Add `sso: true` to your `manifest.yaml`. At install the
platform makes these available to your app — **the same way as `settings`** (see *Wire it into your
compose* immediately below):

- `OPENMASJID_APP_ID` — your app id,
- `OPENMASJID_BASE_URL` — the platform's address (set **only** by the platform — never let anything
  else set it; it's where you forward the user's cookie),
- `OPENMASJID_APP_SECRET` — a per-app secret. **Treat it as a credential — never log or expose it.**

> **Wire it into your compose (required).** "Made available" does **not** mean "set on your container
> automatically." The platform delivers these by writing your app's `.env` and running
> `docker compose --env-file …`, which only powers **`${VAR}` substitution** — exactly like `settings`.
> So they reach your container **only if your compose references them**:
>
> ```yaml
> services:
>   app:
>     environment:
>       OPENMASJID_BASE_URL: ${OPENMASJID_BASE_URL:-}
>       OPENMASJID_APP_ID: ${OPENMASJID_APP_ID:-}
>       OPENMASJID_APP_SECRET: ${OPENMASJID_APP_SECRET:-}   # only for sso/notifications apps
> ```
>
> The `:-` empty default keeps a standalone `docker compose up` quiet. **Without these lines the
> injected values never reach your app and SSO/notifications silently no-op** (this is the exact trap
> that left OpenMasjid Display non-functional for several releases).

The session check answers exactly one question — *"is this viewer the platform admin?"* — and is an
**identity assertion, not a credential** (see §2b.2): use it to gate your own features, never to call
the platform's admin API as the admin. To check, your **backend** (server→server, never from the
browser) calls:

```
GET ${OPENMASJID_BASE_URL}/api/auth/session
  Cookie: omos_session=<the value from THIS request's cookie, forwarded verbatim>
  X-OpenMasjid-App-Secret: <OPENMASJID_APP_SECRET>
→ 200 { "authenticated": true, "username": "…" }   // or { "authenticated": false }
```

Rules:

- Read `omos_session` **only** from the incoming request's cookie — never from a query/header/body.
- Send `OPENMASJID_APP_SECRET` in the `X-OpenMasjid-App-Secret` header. Without it the platform returns
  `authenticated:false` — the check is bound to your app's identity, so the shared session cookie
  can't let some other installed app validate as you.
- It **fails closed** and is **not** CORS-enabled (server→server only). Treat `username` as an
  untrusted display string (cap/escape it). Never trust a browser-supplied username.
- Cache a positive result briefly (~45 s) and cap the session you mint (~1 h) so a logged-out admin
  doesn't linger. **Always** fall back to your own login when the base URL/secret is unset, the cookie
  is absent, or the platform says `false` — so your app still works standalone.
- **Read the cookie from the request that LOADS your app** (the admin's "Open" click). The session
  cookie is `SameSite=Lax`, so it rides that top-level navigation even though the dashboard is HTTPS and
  your app is HTTP (a cross-scheme = cross-site nav). Don't depend on a reload to make SSO work — read
  it on first load. If your app sets up its own session afterward, do the SSO check on that first
  request so a returning admin is signed in immediately.
- Same-host (the platform serves your app on the LAN). The session cookie is `SameSite=Lax`, non-Secure
  so it reaches an HTTP app. If your app ever runs cross-host from the platform, use an `https://`
  `OPENMASJID_BASE_URL` so the forwarded cookie + your secret aren't sent in cleartext.

**Notifications — opt in with `notifications: true`.** Let your app alert the masjid through the
admin's configured webhook (Slack / Discord / generic). The admin sets the destination once in
**Settings → Notifications**; your app **never sees the URL**. From your **backend**, post your
per-app secret:

```
POST ${OPENMASJID_BASE_URL}/api/fabric/notify
  X-OpenMasjid-App-Secret: <OPENMASJID_APP_SECRET>
  Content-Type: application/json
  { "text": "A new donation was received.", "title": "Donation", "level": "success" }
→ 200 { "delivered": true }   |   { "delivered": false, "reason": "disabled" | "rate_limited" | … }
```

`text` is required; `title` and `level` (`info`/`success`/`warning`/`error`) are optional. It's
rate-limited per app and **fails soft** (`delivered:false` when the admin hasn't enabled
notifications), so treat it as best-effort and never depend on it — your app must work without it.

> **Same compose requirement as SSO:** notifications also need `OPENMASJID_BASE_URL` and
> `OPENMASJID_APP_SECRET`, so your compose `environment:` must reference them — see *Wire it into your
> compose* above. If it doesn't, `/api/fabric/notify` calls never authenticate and silently no-op.

**Stripe — opt in with `stripe: true`** *(platform v0.29.0+)*. If your app takes card payments, do
**not** ask the admin to paste Stripe keys into your app. The admin configures one or more **named**
Stripe accounts once in **Settings → Payments**; your app fetches a named account's keys from the
Fabric. This means several apps (donations page, kiosk…) share one account, and the keys are backed
up / migrated with the platform — never re-entered per app.

- Set `stripe: true` in `manifest.yaml` (the platform then issues your per-app secret).
- Add an install **setting** of type **`stripe-account`** so the admin **picks** which account this
  app uses — the OS renders a **dropdown of the Stripe accounts** configured in Settings → Payments
  (no typing keys in the install dialog). The chosen account's id is passed as your setting's value;
  blank = the only/first account. *(Platform v0.32.2+. On older platforms `stripe-account` degrades to
  a text box.)*

  ```yaml
  settings:
    - key: STRIPE_ACCOUNT
      label: OpenMasjidOS Stripe account
      type: stripe-account
  ```
- From your **backend**, fetch the keys (server→server — these are secrets, so never do this from the browser):

```
GET ${OPENMASJID_BASE_URL}/api/fabric/stripe?account=<STRIPE_ACCOUNT>
  X-OpenMasjid-App-Secret: <OPENMASJID_APP_SECRET>
→ 200 { "id", "label", "publishableKey", "secretKey", "webhookSecret" }
   (omit ?account= to get the only/first account)
```

Fetch per process start (or cache in memory only) — **never persist the returned `secretKey` /
`webhookSecret` to your data volume**, so they always track the OS vault. Apps that use Stripe also
need `https: true` (§2b.5). Keep any local Stripe fields you have as the **standalone fallback** for
when the Fabric is absent (`OPENMASJID_BASE_URL`/secret unset).

**Choosing the account — in-app picker (preferred) vs install setting.** Two options:

- **In-app (recommended):** declare **no** install setting and let the admin pick on your own admin
  screen. List the masjid's accounts (non-secret) and store the chosen **id** in your app data, then
  fetch that account's keys with `?account=<id>` as above. This keeps **install one-click** (the
  platform shows no dialog when an app has no settings) and lets the admin change accounts later
  without reinstalling.

  ```
  GET ${OPENMASJID_BASE_URL}/api/fabric/stripe/accounts   (platform v0.33.0+)
    X-OpenMasjid-App-Secret: <OPENMASJID_APP_SECRET>
  → 200 { "accounts": [ { "id": "main-masjid", "label": "Main Masjid" }, … ] }   (no keys)
  ```

- **Install-time:** a `type: stripe-account` setting (shown above) renders the dropdown in the install
  dialog instead. Simpler, but adds an install popup and is fixed at install. Prefer the in-app picker.

**Remote access / public URL — opt in with `domain: true`** *(platform v0.30.0+)*. The admin can run
a **Cloudflare Tunnel** from **Settings → Remote access** (token + their domain, e.g.
`omos.example.org`), making the masjid's apps reachable from the internet. If your app needs to build
**absolute** URLs that work from outside the LAN — Stripe `success_url`/`cancel_url`, a public webhook
endpoint, a QR code to a donation page — ask the platform for your public address instead of guessing:

- Set `domain: true` in `manifest.yaml` (the platform issues your per-app secret).
- From your **backend**:

```
GET ${OPENMASJID_BASE_URL}/api/fabric/site
  X-OpenMasjid-App-Secret: <OPENMASJID_APP_SECRET>
→ 200 {
    "enabled": true,
    "domain": "omos.example.org",
    "publicUrl": "https://omos.example.org/<your-app-id>",
    "basePath": "/<your-app-id>"
  }
   (enabled:false + publicUrl/basePath:"" when remote access is off — fall back to the request's own host)
```

`publicUrl` is your app's public base; build links under it (e.g. `${publicUrl}/webhook`). When
`enabled` is false, derive URLs from the incoming request host as you do today. **Never hard-code the
domain or persist `publicUrl`** — it changes when the admin changes their tunnel/domain.

**How routing works (path-based, one subdomain, one Cloudflare route).** The OS keeps every app on a
single public hostname — **`omos.<the-admin's-domain>`** — and gives each app a **path**
(admin-configurable in **Settings → Remote access**; defaults to the app id, e.g. donations →
`donate`). The admin adds **ONE** Cloudflare *Public Hostname* (`omos.<domain>` → HTTP
`localhost:<the OS front-door port>`); **the OS itself reverse-proxies each path to the right app**
(platform v0.37.0+) — no per-app Cloudflare rows. So your app is reached at
`https://omos.example.org/<path>/…`. Cloudflare terminates TLS and the OS forwards the **full path**
(it does not strip the prefix), so you remain base-path aware. **Don't assume the path equals your id —
always read it from `basePath`** (`/api/fabric/site`); it's whatever the admin chose.

> **Acceptance test (the whole chain).** With remote access on and your app installed:
> `curl https://omos.<domain>/<basePath>/<some-app-route>` must return *your app's* response — proving
> Cloudflare → OS front door → your container all line up. (`<basePath>` is what `/api/fabric/site`
> returns, default your id.) If it 404s: the OS only proxies a path that matches an installed app's
> configured path, so check the path in **Settings → Remote access** matches what you're requesting.

**Therefore a `domain` app MUST be base-path aware.** Cloudflare forwards the full path (it does *not*
strip the prefix), so your server receives requests under `basePath` (e.g. `/donations/...`). Mount
your routes and emit your asset/link URLs under `basePath` so they resolve behind the tunnel. Read it
from `/api/fabric/site` (above); when `basePath` is `""` (no remote access, or accessed directly on the
LAN) serve at root as usual. A static SPA should set its base href / router basename from it.

### App-to-app broker — opt in with `fabric:` *(platform v0.40.0+)*

Sometimes one app needs to call another (e.g. a donations page asking a students app for a family's
balance). The platform brokers this so apps never learn each other's addresses or secrets. Declare a
`fabric` block — the platform then issues your per-app secret:

```yaml
fabric:
  provides:                 # capabilities YOU serve at /fabric/<capability>/<method>
    - capability: billing   # kebab-case
  consumes:                 # capabilities you may CALL, "<target-app-id>/<capability>"
    - students/billing
```

- **Calling** (your backend) — both sides must agree (you `consumes` it, the target `provides` it):

  ```
  POST ${OPENMASJID_BASE_URL}/api/fabric/app/<targetAppId>/<capability>/<method>
    X-OpenMasjid-App-Secret: <OPENMASJID_APP_SECRET>   (YOUR secret)
    Content-Type: application/json
    { …json… }
  → the target's status + JSON on success; on a platform failure:
    { "fabric_error": { "code": "not_granted"|"target_unreachable"|… } }
  ```
  JSON only, ≤256 KB each way, 10 s timeout. **Fail soft**: treat every `fabric_error` as "feature
  unavailable, app still fine" (hide the tab, queue and retry) — never crash.

- **Providing** — mount your served capabilities at `/fabric/<capability>/<method>`. Trust the
  platform-set headers only: verify `X-OpenMasjid-App-Secret` equals **your own** `OPENMASJID_APP_SECRET`
  (proves the call came from the platform), and read `X-OpenMasjid-Caller-App` for the caller's id. Your
  `/fabric/*` routes are refused over the public tunnel by the platform — enforce it yourself too.

Grants are static from this manifest (no admin approval step). Broker calls are catalog-app ↔
catalog-app only.

### Internet exposure — request it with `tunnel: true` *(platform v0.40.0+)*

Exposure over the Cloudflare tunnel is **per-app opt-in** as of v0.40.0. Set `tunnel: true` to *request*
that your app be reachable from the internet; the **admin confirms** it per-app in Settings → Remote
access (default off for new installs; apps installed before v0.40.0 keep their prior reachability).
Everything in the `domain:` section above still applies — read your public URL from `/api/fabric/site`
(and `OPENMASJID_PUBLIC_URL`, injected empty when you're not exposed). Nothing is public without the
admin's toggle.

### Sending email — opt in with `email: true` *(platform v0.41.0+)*

The admin configures ONE email provider (SMTP or SendGrid) in Settings → Email. Set `email: true`
to opt in; the platform issues your per-app secret and your **backend** sends mail through the OS —
you never handle the credentials or the From address. Use it for donation receipts, parent notices,
etc.

```
POST ${OPENMASJID_BASE_URL}/api/fabric/email
  X-OpenMasjid-App-Secret: <OPENMASJID_APP_SECRET>
  Content-Type: application/json
  { "to": "donor@example.org", "subject": "Your receipt", "text": "JazakAllah…", "html": "<p>…</p>" }
→ 200 { "sent": true }  |  { "sent": false, "reason": "not_configured" | "rate_limited" | "bad_recipient" }
```

**Fail soft**: `not_configured` just means the admin hasn't set up email — keep working (record the
donation, show the receipt on screen). Rate-limited per app. Server→server, LAN-only, not CORS-enabled.

### Raising admin alerts — declare them with `alerts:` *(platform v0.41.0+)*

Tell the admin when something is wrong (a camera/reader offline, a failed payment). Declare each
alert TYPE in your manifest; the admin gets a granular on/off per type in Settings → Alerts (all on
by default — like UniFi's notification controls). Fire one from your backend; the platform gates on
the admin's toggle, then delivers to the admin's **email + webhook**.

```yaml
alerts:
  - id: reader-offline            # kebab-case, stable — this is what you POST
    label: Card reader offline
    description: A payment reader stopped responding.
```

```
POST ${OPENMASJID_BASE_URL}/api/fabric/alert
  X-OpenMasjid-App-Secret: <OPENMASJID_APP_SECRET>
  Content-Type: application/json
  { "alert": "reader-offline", "title": "Reader offline", "text": "Lobby reader is unreachable.", "level": "error" }
→ 200 { "delivered": true, "email": true, "webhook": false }  |  { "delivered": false, "reason": "disabled_by_admin" }
```

- The `alert` id MUST be one you declared in `alerts:` (else 400). `level` is `info|success|warning|error`.
- **Fail soft**: `disabled_by_admin` just means the admin turned that alert off — not an error.
- Alerts go to the ADMIN. To email a donor/parent, use `POST /api/fabric/email` instead.
- Declaring `alerts:` (or `email: true`) issues your per-app secret — no other capability needed.

### Restore & migration resilience — REQUIRED for every Fabric app

A backup can be restored onto a **different machine**, which changes the platform's address. Your app
**must** survive that without locking the admin out. The rules:

1. **Read `OPENMASJID_BASE_URL` and `OPENMASJID_APP_SECRET` from the environment on every process
   start, and NEVER persist them (or anything derived, like a "linked to OpenMasjidOS" flag) to your
   data volume.** The platform rewrites `OPENMASJID_BASE_URL` to the current machine and may rotate
   your secret (admin "Reset sign-in"); a cached copy in your DB would point at the old machine/secret
   and break sign-in. (The platform recreates your container on restore, so fresh env is picked up.)
2. **Never let the panel become un-enterable.** If you gate a local-password path on "is the Fabric
   configured?", you **must** still allow a local-password **recovery** when the platform is
   *unreachable*. Do **not** return a hard `403 "signs in through OpenMasjidOS"` for setup while the
   platform can't be reached — otherwise a momentarily-down or freshly-migrated platform bricks your
   app with no way in. Distinguish *SSO not configured* from *SSO configured but platform unreachable*
   and offer the admin a way in either way.
3. **SSO/Stripe/notify calls must fail soft** — a `4000ms`-ish timeout, `redirect: 'error'`, and a
   graceful fallback to standalone. An unreachable platform = "no Fabric this request", not a crash.

*(These exist because a restore-to-new-machine could lock admins out of the catalog apps — see each
app's `docs/RESTORE_SSO_FIX.md`. The platform also helps: it refreshes the base URL on restore
(OpenMasjidOS v0.27.0) and offers a full "Reset sign-in" (v0.28.0).)*

---

## 8. Get listed in the catalog

Open a PR to **OpenMasjidAPPS** adding your app to [`../registry.yaml`](../registry.yaml):

```yaml
apps:
  - id: my-app
    repo: <owner>/openmasjid-my-app
    ref: v1.0.0            # the tag you published
```

CI fetches your repo, validates it, and regenerates `catalog.json`. Your app then appears in the
store.

---

## 9. Pre-submit checklist

- [ ] `id` kebab-case and identical in manifest + registry.
- [ ] `manifest.yaml` has `name`, `version` (semver), valid `category`; `icon`/`screenshots` are
      repo-relative paths.
- [ ] `docker-compose.yml` pins the image, publishes the web port, uses `${KEY}` settings, named
      volumes, **no** privileged / host-namespace / device / socket / sensitive-mount access,
      **no** `extends`/`include`, **no** discovery labels. (Rejected at build AND at install.)
- [ ] Image is **digest-pinned** (`@sha256:…`), not just tagged, so a moved tag can't repoint it (§2b.1).
- [ ] Fabric SSO/session is used **only** as an identity check, never as a credential to call the
      platform API; `OPENMASJID_BASE_URL` is `https://` for any cross-host deployment (§2b.2–3).
- [ ] Image is **public** on GHCR and **multi-arch** (amd64 + arm64).
- [ ] All masjid-specific values are in `settings`; values are single-line.
- [ ] Friendly, plain wording; looks good full-screen if it's a display app; honors
      `prefers-reduced-motion`; works LTR and RTL.
- [ ] Matches the OpenMasjidOS design language ([DESIGN.md](./DESIGN.md)) — Sakīna Glass tokens,
      dark + light themes, spring motion, and (ideally) inherits appearance via the Fabric.
- [ ] Installs and **opens cleanly on a real OpenMasjidOS instance** with only the settings
      collected at install time.
- [ ] If using `sso`/`notifications`: your compose `environment:` **references** `${OPENMASJID_BASE_URL}`,
      `${OPENMASJID_APP_ID}` and `${OPENMASJID_APP_SECRET}` — otherwise the injected values never reach
      the container and SSO/notify silently do nothing.
- [ ] If using SSO (`sso: true`): backend sends `X-OpenMasjid-App-Secret`, reads the cookie only from
      the request, fails closed, and falls back to the app's own login when the platform is absent.
- [ ] No copied Umbrel/CasaOS definitions or assets; no sacred text in decorative chrome.
