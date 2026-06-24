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
and the platform's [`docs/APP_MANIFEST_SPEC.md`](https://github.com/hasan-ismail/OpenMasjidOS/blob/master/docs/APP_MANIFEST_SPEC.md).

---

## 3. `manifest.yaml` template

```yaml
id: my-app                          # kebab-case; equals the registry id
name: My App
tagline: One short line for the store card
category: displays                  # displays | donations | community | quran | admin | utilities
version: 1.0.0
author: Your Name
license: MIT                        # your choice
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
# https: true                       # ONLY if your app uses Stripe (needs HTTPS) — see §2b.5
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
[`docs/APP_MANIFEST_SPEC.md`](https://github.com/hasan-ismail/OpenMasjidOS/blob/master/docs/APP_MANIFEST_SPEC.md).

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
