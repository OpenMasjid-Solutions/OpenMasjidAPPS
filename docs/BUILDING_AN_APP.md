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
   **The dev channel is not exempt.** A dev compose must also pin an immutable reference — either a
   digest, or the exact prerelease version tag it declares. Never `:dev`. See §8b.

   > ### ⚠ Tag the digest-pin commit — not the commit before it
   >
   > The digest does not exist until CI has built and pushed the image, so the commit that writes
   > `@sha256:…` into your compose necessarily comes **after** the build. Do your release in this
   > order:
   >
   > 1. bump `manifest.yaml` to the release version → 2. let CI publish the image →
   > 3. commit the compose with the **published** digest → 4. **tag that commit**.
   >
   > Tag at step 1 or 2 and your release tag carries the **previous** release's digest. Anyone who
   > pins your tag then ships the old image under the new version number — a masjid "updates" and
   > gets the code it already had, with nothing to indicate it.
   >
   > This is not hypothetical. `OpenMasjidDisplay`'s `v0.67.0` tag carries
   > `@sha256:3a789623…`, which is **0.66.1's image**; the correct `0.67.0` digest
   > (`@sha256:02672477…`) landed five minutes later in a follow-up commit. `OpenMasjidKiosk`'s
   > `v0.11.0` has the same shape. Both were caught only because the catalog pins a `commit:` SHA
   > rather than the tag, so it fetched the corrected commit.
   >
   > If your tag is already wrong, do not move it — tags are immutable by convention here. Cut the
   > next patch release, or tell the catalog maintainer which commit to pin.

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
# whatsapp: true                    # OPTIONAL — POST /api/fabric/whatsapp to send WhatsApp (see §7)
# commands:                         # OPTIONAL — admin runs these from WhatsApp, !<app-id> (see §7)
#   - id: whats-on                  #   kebab-case, not all digits, max 12 commands
#     label: What's on the screen   #   shown in the numbered menu
#     description: Reads it back.   #   optional
#   - id: post-notice
#     label: Put a message up
#     argument:                     #   OMIT if it takes no text. An OBJECT — never `argument: true`
#       label: message
#       required: false             #   default true
#     confirm: true                 #   ask before doing it
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

The admin configures ONE email provider (SMTP or Resend) in Settings → Email. Set `email: true`
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

### Sending WhatsApp — opt in with `whatsapp: true` *(platform v0.50.4+)*

The masjid installs the **`openwa`** app (OpenWA, MIT, self-hosted) from the App Store and links a
number in Settings → WhatsApp. Set `whatsapp: true` and your **backend** asks the platform to send;
you never see the gateway, its key, or the linked number.

```
POST ${OPENMASJID_BASE_URL}/api/fabric/whatsapp
  X-OpenMasjid-App-Secret: <OPENMASJID_APP_SECRET>
  Content-Type: application/json
  { "to": "+447700900123", "text": "Fees for this term are now due." }
→ 202 { "queued": true, "id": "<opaque id>" }
→     { "queued": false, "error": "…" }        400 / 403 / 413 / 429
```

**Read the platform's `docs/WHATSAPP.md` before you build on this** — it is the normative
contract. The rules that catch people out:

- **`202 {queued: true}` NEVER means sent.** It means accepted for later delivery, and **there is
  no delivery receipt from WhatsApp** — not for us, not for anyone using an unofficial client. Do
  not block a user flow on it. You *can* ask what became of it afterwards (below).
- **A queued message can now stay queued for a long time.** If the link to WhatsApp is down the
  queue is **held rather than dropped**, and nothing sends again until an admin presses *Send them
  now* in Settings → WhatsApp — deliberately, because releasing a backlog from a just-relinked
  number is the behaviour most likely to get it restricted. A weekend outage means Friday's
  messages are still waiting on Monday. **Any logic that assumes a queued message resolves within
  minutes is now wrong.**
- **One recipient per call.** No bulk arrays — the pacing is the point.
- **Never anything auth-critical.** No OTPs, no password resets, no payment confirmation a user is
  sitting there waiting for. Keep email or SMS for those.
- **Recipients must have opted in.** Messaging people who never asked to hear from you is the
  single most reliable way to get the masjid's number restricted.

**Why the platform owns the queue.** WhatsApp does not officially permit this: OpenWA is an
unofficial client and **a linked number can be restricted or banned.** That risk belongs to the
*number*, not to any one app — if three apps each send "politely" at the same moment, WhatsApp
still sees one number emitting a burst. So every message, from every app and from the OS itself,
goes through one serialised queue your app cannot opt out of.

What that queue does is **narrower than it used to be**, which matters if you sized any timeout
around the old behaviour: the hourly and daily caps, the per-recipient and per-group cooldowns, the
warm-up ramp, the 6–20 second inter-message gap and the 21:00–07:00 quiet-hours window have **all
been removed** (platform v0.51.1) — each cost more than it bought, and the platform's own doc gives
the reasoning. What remains is one message at a time, a typing indicator before each, a durable
queue that survives a restart, and the hold-on-outage behaviour above. **Nothing in OpenMasjidOS
caps how much your app sends**, so the restraint is now yours.

**Fail soft**: `not_configured` means the masjid has no gateway — keep working and fall back to
email or on-screen. Rate-limited per app. Server→server, LAN-only, not CORS-enabled.

#### Ask first — the capability probe

Before you offer WhatsApp in your own settings, ask whether *this* masjid can actually use it.
Otherwise your switch looks available on every install and fails only when a real message was due.

```
GET ${OPENMASJID_BASE_URL}/api/fabric/whatsapp
→ 200 { "available": true,
        "reason": "ready" | "not-configured" | "not-linked" | "unreachable",
        "media": true, "maxMediaBytes": 2097152,
        "outcomes": true }
→ 403 { "available": false, "reason": "not-allowed" }     ← you did not declare `whatsapp: true`
```

**Read an absent field as `false`.** `media` and `outcomes` are simply missing on an older
platform, and treating absence as "yes" means silently sending nothing, or polling a route that is
not there. Same rule as every other capability probe in this document.

#### Posting to a group — no manifest change

For announcements, send `group` instead of `to`. **The admin decides which groups apps may post
to**, in Settings, so you must read the approved list at runtime rather than storing an id:

```
GET  ${OPENMASJID_BASE_URL}/api/fabric/whatsapp/groups   → the groups the ADMIN approved, only
POST ${OPENMASJID_BASE_URL}/api/fabric/whatsapp          { "group": "<id from that list>", "text": "…" }
```

An id that is not on the list is refused with `403`. Treat an empty list as "no groups available"
and hide the feature rather than erroring — the admin can withdraw approval at any time.
`whatsapp: true` covers this; there is no `groups` manifest key and there should not be one, since
a manifest key would mean the *app* decides, which is backwards.

**A group post is for genuine announcements.** Never use one to tell a family about their own fees
— their business is not the other 199 members'.

#### Sending an image — no manifest change

Add an optional `media` object (`data` base64 + `mimeType`); `text` becomes its caption. PNG, JPEG
or WebP, **2 MB decoded**. Check `media` and `maxMediaBytes` on the probe above rather than
hard-coding either — the check exists so you do not render a poster and base64 half a megabyte into
a request that was never going to work.

#### Knowing what happened to a message *(platform v0.51.1+)*

`202` used to be the end of the story: an app recorded that it had handed a message over, and
nothing anywhere could contradict it. That is what made a real 24-hour non-delivery impossible to
diagnose from the app's side. Two read-only routes close that, both on the **read rate tier
(600/min)** — separate from the send tier, so reconciling a few hundred ids can never cost you a
send.

**What became of one message** — poll the `id` the `202` gave you:

```
GET ${OPENMASJID_BASE_URL}/api/fabric/whatsapp/status/<id>
→ 200 { "id": "…", "state": "queued" | "sent" | "failed" | "expired",
        "reason": "…", "at": <epoch ms>, "target": "…" }
→ 404 { "error": "No such message." }
```

- **A `404` means "unknown", and must NEVER be read as a delivery failure.** It covers an id you
  invented, an id belonging to **another app**, a record that has aged out, and a platform too old
  to have the route at all — four very different situations behind one status code. Treat it as "I
  cannot tell" and fall back to your own records.
- **The history is bounded per app: your most recent 500 messages, for up to 24 hours.** Another
  app's traffic cannot evict yours — a shared 200-record ring did allow exactly that before
  v0.51.1-dev.8, so one app messaging a large roster wiped every other app's outcomes and their
  polls came back `404`. If you sized a poll interval around the old shared 200, you can relax it.
- `expired` is a real answer, not an error: a message held longer than 24 hours of *working*
  connection time is dropped rather than released later as part of a burst.

**Which of your messages may never have arrived** — the honest gap:

```
GET ${OPENMASJID_BASE_URL}/api/fabric/whatsapp/suspect
→ 200 { "windows": [ { "from": <epoch ms>, "to": <epoch ms>, "count": <number> } ] }
→ 200 { "windows": [] }                                   ← the normal answer
→ 403 { "error": "This app is not allowed to use WhatsApp." }
```

A WhatsApp session can expire on its own, and while it has, the gateway goes on accepting messages
and answering `2xx` — so the platform records them `sent` when nothing was delivered. That is now
detected within five minutes and the queue is held, but **the window between the link dying and
detection cannot be closed**, and the platform cannot re-send what fell inside it: it deletes
message contents the moment it hands them over, deliberately, so a child's name and a family's fees
are not sitting on disk longer than they must be.

**So reconciliation is yours, from your own records.** Each window gives you `from`, `to`, and a
count of **your own** messages inside it — never another app's. If `count` is non-zero, look up
what you sent in that period and decide what is worth sending again: a fee reminder probably is, a
"your payment went through" from four days ago probably is not.

Poll it after an outage notification, or on a slow timer. `{"windows": []}` is the normal answer
and costs you nothing.

### Admin commands — declare them with `commands:` *(platform v0.50.4+)*

Let an authorised admin run something against your app by sending a WhatsApp message to the
masjid's number (`!<your-app-id>`). **The platform owns everything except the doing:** it decides
who may run what, renders the numbered menu, asks for confirmation, and formats the reply. You are
asked only to execute one command you declared.

```yaml
commands:
  - id: whats-on                    # kebab-case, stable — this is what we send you
    label: What's on the screen now # shown in the menu and in Settings
    description: Reads back the current notice.
  - id: post-notice
    label: Put a message on the screen
    argument:                       # OMIT if the command takes no text
      label: message                # one or two words: "add your message after the number"
      required: false               # default true
    confirm: true                   # ask the sender to confirm first
```

**What the catalog build enforces**, so an install can never surprise you — these are checked here
*and* at install, and the two are kept deliberately identical:

- At most **12** commands. A numbered menu longer than that does not fit in one message.
- `id` is kebab-case, **not all digits** (`!display 2` must only ever mean "the second option"),
  not one of `help` `yes` `no` `cancel` `stop`, and unique within your app.
- `label` is required; `description` is optional text. Over-long values are **truncated**
  (label 80, description 200, `argument.label` 40) — a wrong *type* is a hard error.
- `argument` must be an **object with a `label`**. `argument: true` and `argument: "message"` are
  **rejected, not coerced** — `true` reads like "takes an argument" but carries no label, and
  accepting it would mean silently discarding whatever a volunteer typed while telling them it
  worked.
- Set `confirm: true` for anything people will see or that cannot be undone. It also puts the
  command in the admin's audit alert.
- Your **app id** may not be `os`, `omos`, `openmasjid`, `openmasjidos`, `platform` or `help` — a
  command's namespace is the app id, so those would shadow the platform's own words.

#### Serving it

```
POST /fabric/commands/run          ← on your app's own web port, like every /fabric/* route
  X-OpenMasjid-App-Secret: <your OWN OPENMASJID_APP_SECRET>
  X-OpenMasjid-Caller-App: omos:platform
  { "command": "post-notice", "text": "Jumu'ah is at 1:30", "requestId": "…", "locale": "en" }
```

Answer with HTTP 200 and JSON:

| Meaning | Body |
|---|---|
| Done | `{ "ok": true, "text": "The notice is on the screen now." }` |
| Failed, and you can say why | `{ "ok": false, "error": "The screen is switched off at the wall." }` |
| Not a command you know (HTTP 404) | `{ "ok": false, "code": "unknown_command" }` |
| Still starting up (HTTP 503) | `{ "ok": false, "code": "not_ready", "error": "…" }` |

- **Verify BOTH headers.** `X-OpenMasjid-App-Secret` must equal your own `OPENMASJID_APP_SECRET`,
  **and** `X-OpenMasjid-Caller-App` must be exactly `omos:platform`. That value can never be an app
  id — the colon is outside the charset every app id is validated against — so it identifies the
  platform by construction rather than by an allow-list somebody has to maintain.
- **Declaring `commands:` alone issues your Fabric secret**; no other capability is needed, exactly
  as `alerts:` already does.
- **`commands` is a RESERVED Fabric capability.** Putting it in `fabric.provides` is refused by the
  catalog build and at install: it would let another app reach this same handler through the
  app-to-app broker with `consumes: ["<your-app>/commands"]` — the same path prefix under a very
  different trust boundary.
- Your `text` and `error` are plain text, ≤1000 characters. The platform strips control characters,
  collapses blank lines and trims to the message cap — you cannot make one answer look like three
  messages.
- Reply promptly: **10 second timeout**, 16 KB response cap. A command a volunteer is waiting on is
  not the place for a long job; kick it off and say you have.
- `/fabric/*` is LAN-only and never served over the tunnel, as for every other Fabric route.

**What the platform will never ask you to do.** Commands are an ADMIN channel. There is no way for
a command to name a phone number, and there never will be — that is the line between an admin
channel and a spam gateway. To message a parent or a donor, use `POST /api/fabric/whatsapp`.

The normative contract is OpenMasjidOS `docs/APP_MANIFEST_SPEC.md` → "Admin commands"; this section
mirrors it, and `docs/WHATSAPP.md` there covers the sending rules.

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
    ref: v1.0.0            # STABLE channel — the release TAG you published (never a branch)
    commit: <40-char SHA>  # recommended — the immutable SHA that tag is at
    dev_ref: dev           # OPTIONAL — DEV channel; omit if you have no dev branch
```

CI fetches your repo, validates it, and regenerates `catalog.json`. Your app then appears in the
store.

### 8a. Shipping a new release to masjids

Once listed, a new release of your app reaches masjids only when the **registry pin moves**. The
catalog does not follow your tags — `commit:` is what it fetches, and it is hand-edited.

**Open a PR against the catalog's `dev` branch — never `main`.** Change only your own entry:

```yaml
  - id: my-app
    ref: v1.2.0            # the tag you just published
    commit: <40-char SHA>  # the commit that tag is on — the one with the correct digest (§2b.1)
```

Then stop. A catalog maintainer runs the release that moves `main`; that is the only thing that
changes what masjids install. Do **not** commit to the catalog's `main`, and do not merge its `dev`
into `main` — the two branches legitimately hold different builds of `catalog.json`, and a naive
merge has already come within one command of publishing three app downgrades.

Two things follow from that near-miss:

- **A bump committed straight to `main` desynchronises `dev`.** The next release cut from `dev` then
  carries *older* pins for your app and silently rolls masjids back. The catalog now fails the build
  if that would happen, but the cure is to route bumps through `dev` in the first place.
- **`ref` is a label; `commit` is the truth.** If they disagree — because your tag predates the
  digest fix (§2b.1) — pin the commit that has the correct digest and say so in the PR.

**The dev channel needs no PR.** `dev_ref: dev` follows your dev branch on its own and rebuilds
hourly; see §8b.

### 8b. Update channels — stable and dev

OpenMasjidOS has an **Update Channel** setting. It swaps the branch in the single URL it fetches, so
the catalog exists twice — once per branch of OpenMasjidAPPS:

```
.../OpenMasjidAPPS/main/catalog.json     ← stable: what every masjid installs
.../OpenMasjidAPPS/dev/catalog.json      ← dev: testers who opted in
```

**Stable is the default and the one that matters.** Your `ref` must be a **published release tag**
(or a commit SHA) and your compose must reference a **release-tagged, `@sha256` digest-pinned**
image. A branch in `ref`, or a dev-tagged image anywhere in the compose, **fails the catalog build** —
`main/catalog.json` is fetched directly by every masjid with no deploy step in between, so nothing
unreleased may reach it.

**Shipping on the dev channel is optional.** To do it, your repo needs all four:

1. a **`dev` branch**;
2. on that branch, `manifest.yaml`'s **`version` is a semver prerelease** — `X.Y.Z-dev.N`, where
   `X.Y.Z` is the release you are working toward and `N` increments each dev build. If stable is
   `0.10.2`, your next dev build is `0.11.0-dev.1`, then `-dev.2`. **It must never equal your stable
   version.** When that work ships, the version becomes `0.11.0` and dev moves to `0.12.0-dev.1`;
3. an image **published under that exact version** — `ghcr.io/<owner>/<repo>:0.11.0-dev.1`,
   multi-arch and public — and your dev branch's `docker-compose.yml` **referencing that exact tag
   (or a digest) for every service**. Keep publishing `:dev` as a convenience alias if you like; it
   just must not be what the compose references;
4. **`dev_ref: dev`** on your registry entry.

**Why the versioning matters.** OpenMasjidOS detects an update by comparing the catalog's `version`
with the installed version. If your dev entry repeats your stable version, there is nothing to
compare and a new dev build is undetectable — no notification, and nothing to update to. If it pins
the moving `:dev` tag, the catalog names one build and installs another. A dev entry with either
fault is **not published**: the catalog serves your stable release on the dev channel instead, with a
warning naming your repo.

**Publish the image before the entry.** The catalog pins the exact tag, so if a dev entry lands
before its image exists, a masjid on the Development channel gets a pull failure. Push the image,
then let the catalog pick it up (hourly, or immediately via the dispatch below).

**Keep your `dev` branch at or ahead of your release.** If your `dev` branch declares an older
`version` than your latest stable release — the usual cause is a hotfix cut on `main` and never
merged down — the catalog will **not** publish it. It serves your stable release on the dev channel
instead, with a warning, because publishing it would offer a masjid a downgrade. Merge your release
into `dev` (or bump the manifest there) and the next rebuild picks it up.

This falls out of the prerelease scheme naturally: `0.11.0-dev.1` is ahead of stable `0.10.2`, so it
publishes. Once `0.11.0` actually ships, `0.11.0-dev.1` is *behind* it — the prerelease has been
superseded — and the dev channel serves `0.11.0` until you open `0.12.0-dev.1`. That is correct
self-healing, not a fault.

**Trigger a rebuild when you push to `dev`.** The catalog rebuilds hourly on its own, so you never
*have* to — but if you want your dev build listed within seconds rather than within the hour, fire a
`repository_dispatch` at the catalog from your app repo's release/dev workflow:

```yaml
      - name: Refresh the OpenMasjid catalog
        run: |
          curl -fsS -X POST \
            -H "Authorization: Bearer ${{ secrets.CATALOG_DISPATCH_TOKEN }}" \
            -H "Accept: application/vnd.github+json" \
            https://api.github.com/repos/OpenMasjid-Solutions/OpenMasjidAPPS/dispatches \
            -d '{"event_type":"rebuild-catalog","client_payload":{"channel":"dev"}}'
```

`channel` accepts `dev`, `main` or `both` (default `both`). The token needs **Contents: write** on
the catalog repo — ask a catalog maintainer for one; don't reuse a token with wider scope.

Notes:
- The dev channel follows your `dev` branch: the catalog rebuilds hourly and picks up whatever is
  there, resolved to the commit it is at. **Do not push anything to `dev` you would not want a real
  masjid's test box to install.**
- Keep `manifest.yaml` valid on `dev` too — same `id`, same rules. It is fetched from that branch.
- Skip `dev_ref` and you still appear on the dev channel: it falls back to your stable release. That
  is the right choice until you actually have a dev branch to serve.
- **Your `dev` version must differ from your stable version, and must be a prerelease.** This is the
  one thing dev-channel updates depend on: the platform compares the catalog's `version` against the
  installed version, so a repeated version string means a new dev build is undetectable. See the
  four requirements above.

---

## 9. Pre-submit checklist

- [ ] `id` kebab-case and identical in manifest + registry.
- [ ] `manifest.yaml` has `name`, `version` (semver), valid `category`; `icon`/`screenshots` are
      repo-relative paths.
- [ ] `docker-compose.yml` pins the image, publishes the web port, uses `${KEY}` settings, named
      volumes, **no** privileged / host-namespace / device / socket / sensitive-mount access,
      **no** `extends`/`include`, **no** discovery labels. (Rejected at build AND at install.)
- [ ] Image is **digest-pinned** (`@sha256:…`), not just tagged, so a moved tag can't repoint it (§2b.1).
- [ ] Registry `ref` is a **release tag**, never a branch; a branch belongs in `dev_ref` (§8b).
- [ ] If shipping on the dev channel: `dev` branch exists; its `manifest.yaml` `version` is a
      prerelease (`X.Y.Z-dev.N`) that never equals the stable version; an image is published under
      that exact version; the dev compose references that exact tag (or a digest) for **every**
      service, never `:dev`; and the registry entry carries `dev_ref` (§8b).
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
