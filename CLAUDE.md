# CLAUDE.md — OpenMasjidAPPS

> This file is the single source of truth for the **OpenMasjidAPPS** repository — the **app
> catalog** for **OpenMasjidOS**. Read it fully before writing anything. When in doubt, follow
> this document. If something is ambiguous, ask before guessing.

---

## 1. What this repo is (and is not)

**OpenMasjidAPPS is a catalog — nothing else.** It does **not** contain app source code. It is a
**registry** of apps, where **each app lives in its own separate repository**, plus the tooling
that aggregates them into a single `catalog.json` that **OpenMasjidOS** (the platform) fetches to
populate its App Store.

- **Platform repo (the engine):** https://github.com/OpenMasjid-Solutions/OpenMasjidOS
- **This repo (the catalog):** https://github.com/OpenMasjid-Solutions/OpenMasjidAPPS
- **App repos (the apps):** one repository per app, owned by whoever builds the app.

```
   app repo: openmasjid-prayer-times-display ─┐
   app repo: openmasjid-announcements-board ──┤   listed in
   app repo: <your-app> ──────────────────────┘   registry.yaml
                                                       │
                                  scripts/build-catalog.mjs  (fetches each app repo's
                                                       │       manifest + compose + assets)
                                                       ▼
                                   OpenMasjidAPPS/catalog.json  ──fetched by──▶  OpenMasjidOS
```

### What this repo contains
- `registry.yaml` — the hand-edited list of app repositories to include.
- `scripts/build-catalog.mjs` — fetches each listed repo and generates `catalog.json`.
- `catalog.json` — **generated**; the only file the platform reads.
- `examples/` — complete, working **reference apps** you copy into a new repo to start. They are
  **not** part of the catalog (the registry is); they are templates/documentation only.
- `docs/BUILDING_AN_APP.md` — the hands-on guide for building a compatible app repo.
- `docs/DESIGN.md` — the full UI/UX design language (Sakīna Glass tokens, motion, dock, components)
  every app should match so it looks native to OpenMasjidOS.

### What this repo does NOT contain
Live app source, Dockerfiles for shipped apps, or per-app image CI. **Those live in each app's own
repo.** Do not add an `apps/` folder of real apps here, and do not reintroduce a per-app image
build workflow into this repo.

---

## 2. The platform contract — DO NOT BREAK THIS

This is grounded in the real OpenMasjidOS code. The platform fetches **one static file** and only
its **shape** matters. Changing the catalog's source (folders → external repos) must not change
this shape. **If a change here would alter what the platform reads, stop — that belongs in the
OpenMasjidOS repo.**

1. **The file & URL.** The platform fetches, by default (from OpenMasjidOS `packages/core/src/config.ts`):
   ```
   https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidAPPS/main/catalog.json
   ```
   Keep `catalog.json` at the repo **root** on **`main`**. (Operators can override with
   `OPENMASJID_CATALOG_URL`, but this default is the contract.)

2. **The file shape.** The platform accepts a bare array `[ {app}, … ]` **or** an envelope
   `{ "apps": [ {app}, … ] }`. We publish the envelope.

3. **Each entry** (from `packages/core/src/apps/types.ts`, `CatalogApp`):

   | Field | Required | Notes |
   |-------|----------|-------|
   | `id` | ✅ | Unique, **kebab-case**, must match `^[a-z0-9][a-z0-9-]{0,79}$`. The platform **drops** any entry with an invalid id. |
   | `name` | ✅ | Display name. |
   | `version` | ✅ | Semver string, e.g. `1.0.0`. |
   | `compose` | ✅ | The app's **entire `docker-compose.yml` as a string**, embedded in the JSON. This is what runs. |
   | `tagline` | – | One short line on the card. |
   | `category` | – | One of: `displays` `donations` `community` `quran` `admin` `utilities`. |
   | `author` | – | |
   | `license` | – | The **app author's** choice. |
   | `icon` | – | An **absolute URL** to the icon. |
   | `screenshots` | – | Array of **absolute URLs**. |
   | `description` | – | Markdown, shown on the detail page. |
   | `settings` | – | Array of fields the user fills in before install (see §7). |
   | `ports` | – | Array of `{ container: number, label?: string }` — informational. |
   | `sso` | – | `true` to opt into single sign-on (§7b). The platform then issues the app a per-app secret at install and honours its `/api/auth/session` calls. Omit/false = no SSO. |
   | `notifications` | – | `true` to opt into Fabric notifications (§7b) — the app may POST `/api/fabric/notify` to relay messages to the masjid's configured webhook (Slack/Discord/generic). Omit/false = no notifications. |
   | `https` | – | **Set this ONLY if your app uses Stripe.** Stripe's in-person M2 reader (Stripe Terminal SDK) and in-page card fields (Elements) both require a secure context (HTTPS). When `true`, the platform serves your app over HTTPS on a dedicated port (TLS-terminated with the dashboard's cert) and the "Open" URL becomes `https://`. **Every non-Stripe app must omit this** — it stays on plain HTTP. |
   | `comingSoon` | – | Set by the registry's `coming_soon:` list, **not** by app authors. Marks a teaser entry with no repo/compose; the App Store shows a "Coming soon" badge and won't install it. |

4. **Install mechanics** (from `packages/core/src/apps/manager.ts`): on install the platform
   writes the `compose` string to `compose.yml`, writes the user's `settings` answers to a `.env`,
   and runs `docker compose -p omos-<id> --env-file <.env> up -d --remove-orphans`. So a compose
   references settings as `${KEY}` (standard compose interpolation).

5. **Discovery is by project name** (`-p omos-<id>` → label `com.docker.compose.project=omos-<id>`,
   added automatically). Apps add **no** special labels.

6. **The "Open" URL** is derived from the **published host port**, so a compose **must publish the
   web-UI port**. Host-port conflicts are detected and remapped by the platform.

7. **No masjid profile is injected.** The platform holds zero masjid/prayer data. Everything
   masjid-specific (name, lat/long, calc method, madhab, timezone) the app collects via its own
   `settings` and uses internally.

The build script (§5) preserves all of this — it just sources each entry from an external repo.

---

## 3. `registry.yaml` — the only thing you hand-edit

```yaml
apps:
  - id: prayer-times-display                       # kebab-case; must equal the app's manifest id
    repo: OpenMasjid-Solutions/openmasjid-prayer-times-display
    ref: v1.0.0                                    # a git TAG (recommended) or branch to pin to
    path: ""                                       # OPTIONAL — set if manifest.yaml isn't at repo root
```

- **Pin to a tag** (`ref: v1.0.0`) for reproducible catalogs. A branch (`ref: main`) is allowed but
  means the catalog follows that branch (the daily CI rebuild picks up changes).
- `id` must be unique, kebab-case, and equal to the app's `manifest.yaml` `id`.
- To add an app: open a PR adding an entry. CI regenerates and commits `catalog.json`.
- **Coming-soon teasers:** a separate top-level `coming_soon:` list holds apps that aren't released
  yet — inline metadata only (`id`, `name`, `tagline`, `category`), **no repo**. The build emits them
  with `comingSoon: true`; the App Store shows a "Coming soon" badge and won't install them. When one
  ships, give it a repo + tag and move it up into `apps:`.

---

## 4. Requirements for an app repository (READ THIS if you are building an app)

> **For other agents/authors:** an app you build must meet *all* of the following to be listed and
> to install cleanly. The fastest path is to copy `examples/<an-app>/` into a new repo and adapt it.
> A step-by-step version with copy-paste templates is in **`docs/BUILDING_AN_APP.md`**.

**A. The repository**
- One **public** GitHub repo per app. Recommended name: **`openmasjid-<id>`** (it must match the
  image name your compose references — see D).
- These files at the repo **root** (or a subdir declared as `path` in the registry):
  `manifest.yaml`, `docker-compose.yml`, `icon.svg` (or `icon.png`), `screenshots/`, and — if you
  build your own image — a `Dockerfile` plus your source.

**B. `manifest.yaml`** (authored by you; see §6 for fields and §7 for settings)
- `id` is kebab-case, matches `^[a-z0-9][a-z0-9-]{0,79}$`, and equals the registry id.
- `name` and `version` (semver) are present; `category` is one of the six (§9).
- `icon`/`screenshots` are **paths within your repo** (the catalog rewrites them to absolute raw
  URLs — never hardcode absolute URLs yourself).

**C. `docker-compose.yml`** (this is what actually runs)
- **Pin the image tag** (`image: ghcr.io/<owner>/<repo>:1.2.3`) — never `:latest` in the published
  compose. Installs must be reproducible.
- **Publish the web-UI port**: `ports: ["<host>:<container>"]` with a non-privileged default host
  port (≥ 1024). Conflicts are handled by the platform; don't depend on a specific host port.
- **Reference settings as `${KEY}`** and pass them in via an `environment:` block.
- **Use named volumes** for any persistence (portable + clean).
- **Least privilege.** Both the catalog build AND the platform (at install, since OpenMasjidOS
  v0.19.2) **reject** a compose that asks for powerful host access — so an app that needs any of the
  following simply won't install. Avoid: `privileged: true`; any host namespace (`network_mode: host`,
  `pid: host`, `ipc: host`, `userns_mode: host`, `cgroup: host`, `uts: host`); `cap_add`, `devices`,
  `device_cgroup_rules`, `security_opt: …unconfined`, `group_add` of root/docker; mounting the Docker
  socket (`/var/run/docker.sock`), any sensitive host path (`/etc`, `/root`, `/var`, `/`, …) or a path
  that escapes the app folder (`..`); and `extends:` / `include:` (they merge config the check can't
  see). Use **named volumes** for data and pass settings via `environment:` — that's all a masjid app
  needs.
- **No discovery labels** (`com.docker.compose.project` / `com.openmasjid.*` are platform-internal).
- **No reliance on a masjid profile** — collect everything via `settings`.
- Multi-service stacks (app + db) are fine; all run under the one `omos-<id>` project.

**D. The image must exist and be public**
- Publish your app's image to a **public** registry (GHCR recommended) and reference its **pinned
  tag** in the compose. The platform pulls it on the masjid's host **without authentication** — a
  private image will fail to install.
- Build **multi-arch** (`linux/amd64,linux/arm64`) so it runs on mini-PCs/VPSes **and** Raspberry
  Pi. The example ships a ready `build-image.yml` that does this on GHCR; after the first run, set
  the GHCR package visibility to **Public**.
- If a suitable maintained public image already exists, you may reference it directly (pinned) and
  skip the Dockerfile — drive it entirely through `settings`-injected env.

**E. Get listed**
- Open a PR to this repo adding your entry to `registry.yaml`. That's it — `catalog.json` is rebuilt
  by CI.

---

## 5. `catalog.json` — generated, never hand-edited

Built by `scripts/build-catalog.mjs` from `registry.yaml`. For each entry the script:
1. fetches `manifest.yaml` and `docker-compose.yml` from the app repo at the pinned `ref`,
2. validates `id` (kebab), required fields, category, and scans the compose for disallowed
   dangerous directives (§4C),
3. rewrites `icon`/`screenshots` to absolute raw URLs in **that app's repo**,
4. embeds the compose text as `compose`,
5. writes `{ "apps": [ … ] }` to `catalog.json`.

Run locally: `npm install && npm run build` (needs network — it fetches from GitHub). CI
(`.github/workflows/build-catalog.yml`) rebuilds and commits `catalog.json` on registry/tooling
changes, on a daily schedule, on manual dispatch, and on `repository_dispatch` (`rebuild-catalog`)
so app repos can trigger a refresh when they release.

---

## 6. `manifest.yaml` fields (authored in the app repo)

```yaml
id: prayer-times-display          # MUST equal the registry id; kebab-case
name: Prayer Times Display
tagline: A calm prayer clock for your masjid's screens
category: displays                # displays | donations | community | quran | admin | utilities
version: 1.0.0
author: Your Name
license: MIT                      # the app's own license (your choice)
icon: icon.svg                    # path within the app repo → catalog rewrites to absolute URL
screenshots:                      # paths within the app repo → catalog rewrites to absolute URLs
  - screenshots/1.svg
description: |
  Full markdown description shown on the app's detail page.
settings:                         # see §7 — everything masjid-specific is collected here
  - key: LATITUDE
    label: Latitude
    type: text
ports:
  - container: 80
    label: Web interface
# sso: true                       # OPTIONAL — opt into single sign-on (see §7b)
# https: true                     # ONLY if your app uses Stripe (needs HTTPS); see §2b
```

---

## 7. Settings field spec

Each item in `settings` (from `SettingField` in the platform):

```yaml
- key: LATITUDE            # env var name; referenced as ${LATITUDE} in the compose
  label: Latitude          # shown in the install dialog
  type: text               # text | select | number | password | boolean
  options: [A, B, C]       # required only for type: select
  default: ""              # optional pre-filled value
```

- `text`/`number`/`password` render an input; `select` renders a dropdown (needs `options`);
  `boolean` a toggle.
- `key` should be a valid env-var name (UPPER_SNAKE_CASE recommended); it is what the user's answer
  is written as in `.env` and what `${KEY}` resolves to in the compose.
- The platform writes `.env` as `KEY=VALUE` lines, so **keep values single-line** (no newlines).
  Collect **everything masjid-specific here** — the platform injects nothing.

---

## 7b. OpenMasjidOS Fabric — single sign-on (optional)

The **OpenMasjidOS Fabric** is the platform↔app integration layer (unified appearance + single
sign-on / API). Set `sso: true` in `manifest.yaml` to opt an app into the Fabric's SSO — sharing the
dashboard login. It is **optional, backwards-compatible, and identity-bound**: the app must work
standalone, and the platform binds each session check to the calling app so the shared `omos_session`
cookie can't let one installed app validate as another. On install of an `sso: true` app the platform
injects into its container env:

- `OPENMASJID_APP_ID` — the app id,
- `OPENMASJID_BASE_URL` — the platform's address (set **only** by the platform),
- `OPENMASJID_APP_SECRET` — a per-app secret (a credential; never log/expose it).

The app's **backend** (server→server) checks the visitor's session with:

```
GET ${OPENMASJID_BASE_URL}/api/auth/session
  Cookie: omos_session=<forwarded verbatim from THIS request's cookie — never a query/header/body>
  X-OpenMasjid-App-Secret: <OPENMASJID_APP_SECRET>
→ { "authenticated": true, "username": "…" }  |  { "authenticated": false }
```

It **fails closed**, is **not** CORS-enabled, and returns `false` without a valid secret. Apps must
treat `username` as untrusted display text, cache positives briefly (~45 s), cap the minted session
(~1 h), and always fall back to their own login when the platform is absent.

**Notifications** (`notifications: true`). An app may relay a message to the masjid's configured
webhook (Slack/Discord/generic) — the admin sets the destination once in Settings; the app **never
sees the URL**. The app's backend posts with its secret:

```
POST ${OPENMASJID_BASE_URL}/api/fabric/notify
  X-OpenMasjid-App-Secret: <OPENMASJID_APP_SECRET>
  { "text": "...", "title": "optional", "level": "info|success|warning|error" }
→ { "delivered": true }  |  { "delivered": false, "reason": "disabled|rate_limited|…" }
```

Requires the notifications capability, is rate-limited per app, and fails soft (returns
`delivered:false` when notifications are off) — so the app keeps working regardless. Full normative contract:
[`docs/BUILDING_AN_APP.md` §7](docs/BUILDING_AN_APP.md) + the platform's `docs/APP_MANIFEST_SPEC.md`.
This must stay in lock-step with the platform — if it changes there, change it here too.

---

## 8. Icons & screenshots
- **Icon:** a square `icon.svg` (preferred) or `icon.png` in the app repo, simple and legible small.
  Rendered via `<img>` from an absolute URL (the build script makes it absolute — never hand-write a
  bare filename into `catalog.json`).
- **Screenshots:** under `screenshots/` in the app repo, referenced by path in the manifest.
- Keep assets small. No sacred/Quranic text in decorative icon chrome.

## 9. Categories
Exactly one of: `displays`, `donations`, `community`, `quran`, `admin`, `utilities`.

---

## 10. Security & licensing

**Security**
- Apps run as separate Docker containers the platform manages at arm's length. Keep them
  self-contained and least-privilege (§4C); **both the catalog build and the platform (at install)
  refuse dangerous composes** — see the §4 least-privilege list for the full set.
- Pin image versions; prefer trusted/official base images; don't fetch-and-run arbitrary remote
  scripts at container start.

**`scripts/validate-compose.mjs` invariant — DO NOT REGRESS** (v0.39.0 sweep): this validator is the
catalog's safety gate and **must stay in lockstep with the platform's `apps/compose-validate.ts`** so
"passes the catalog build == safe to install". It must reject (as `errors`, in both the structured
branch and the raw-regex fallback): `volumes_from`, `env_file` with an absolute or `..` path,
top-level `secrets:`/`configs:` with a `file:` source pointing outside the app folder, and **truthy**
`privileged` (`yes|on|1|"true"`, via `isTruthyFlag` — not just `=== true`), on top of the existing
namespace/cap/device/mount checks. When the platform adds a compose check, add the same one here.

**Supply-chain hardening (app authors — full version in `docs/BUILDING_AN_APP.md` §2b):**
- **Digest-pin the image** with `@sha256:…` in the compose — pinning the tag alone is not enough,
  because a tag can be moved to repoint at a different (backdoored) image.
- **Pin registry entries to an immutable `commit:` SHA**, not a mutable tag/branch — a moved ref can
  smuggle backdoored content through the unattended daily rebuild. The build prints a ⚠ warning for
  any mutable ref or non-digest image (it warns, it does not fail).
- **Treat any Fabric SSO/session value as an IDENTITY assertion** ("is the viewer the platform
  admin?") — never as a credential to call the platform's admin/tRPC API. The platform enforces an
  origin-bound dashboard CSRF key, so an app cannot act as the admin even if it sees the session cookie.
- **Use an `https://` `OPENMASJID_BASE_URL` for cross-host deployments** so the per-app secret isn't
  sent in cleartext (plain `http` is fine on the default trusted LAN).
- **Least-privilege compose:** no `privileged`, host namespaces, Docker-socket mount, or sensitive
  host bind-mounts — the platform's consent gate flags these and refuses/warns.

**Licensing**
- **This catalog repo** (tooling, registry, examples scaffolding) is **AGPL-3.0** — see `LICENSE` —
  and contributions to it are governed by a **Contributor License Agreement** (`CLA.md`, enforced by
  `.github/workflows/cla.yml`): AGPL-3.0 inbound plus a grant letting OpenMasjid-Solutions also offer
  commercial/dual licenses. The public tree stays AGPL-3.0; contributors keep their copyright. See
  `CONTRIBUTING.md`. **Hard rule for all future code in this repo:** every new file starts with the
  SPDX header in its comment syntax — `// SPDX-License-Identifier: AGPL-3.0-only` (js/mjs/ts),
  `# …` (yml/yaml/sh/Dockerfile), `<!-- … -->` (md/html) — plus `Copyright (C) 2026
  OpenMasjid-Solutions`; never strip a header or add AGPL-incompatible code.
- **Apps the OpenMasjid team / its agents build** should be **AGPL-3.0 + the same CLA** — see
  [`docs/APP_LICENSING.md`](docs/APP_LICENSING.md). (Third-party/community apps merely *listed* in
  the registry are exempt — they keep their own license; see below.)
- **The CLA covers this repo only.** **Each app** carries **its own license** (the manifest
  `license` field). Because apps run as separate programs at arm's length (network, env vars), the
  catalog's license **and CLA** do **not** reach into an app — listing an app in `registry.yaml`
  does not relicense it. App authors choose freely.
- The reference apps under `examples/` declare their own license in their manifest.
- **Do NOT copy app manifests, compose files, icons, or assets from umbrelOS / `umbrel-apps`
  (PolyForm Noncommercial) or CasaOS stores.** Take inspiration, write originals.

---

## 11. Quality bar for apps
- **Match the OpenMasjidOS design language** — see **[`docs/DESIGN.md`](docs/DESIGN.md)**: the Sakīna
  Glass material, color tokens (dark default + light), spring motion, the dock, components, RTL, and
  voice. Prefer inheriting the live appearance via the Fabric (§7b) so the app tracks the dashboard;
  otherwise drop in the tokens from DESIGN.md. An app should feel native, not bolted-on.
- For **masjid volunteers**, not sysadmins. After install an app should "just work" with the
  settings collected up front. Friendly, plain wording in the app's own UI.
- Display-type apps (prayer clocks, boards) should look good full-screen on a TV.
- Calm, dignified, modern. No Quranic/sacred Arabic text in throwaway/decorative UI; if shown, it
  must be intentional, correct, and dignified.
- Make masjid-specific values **configurable** (`settings`), never hard-coded.

---

## 12. Repository structure (this repo)
```
OpenMasjidAPPS/
├── CLAUDE.md                      # this file
├── README.md
├── LICENSE                        # AGPL-3.0 (catalog tooling); apps keep their own license
├── registry.yaml                  # the list of app repos to aggregate (hand-edited)
├── catalog.json                   # GENERATED — the file the platform fetches
├── package.json                   # dev dep: yaml; "build" → build-catalog
├── scripts/build-catalog.mjs      # registry → catalog.json (fetches app repos)
├── docs/BUILDING_AN_APP.md        # hands-on guide for building a compatible app repo
├── docs/DESIGN.md                 # the full UI/UX design language every app should match
├── examples/                      # complete reference apps to copy into a new repo (NOT catalogued)
│   ├── prayer-times-display/
│   └── announcements-board/
└── .github/workflows/build-catalog.yml
```

## 13. Build & run commands
```bash
npm install && npm run build   # regenerate catalog.json from registry.yaml (needs network)
```

---

## 14. Definition of done
- **A catalog change** is done when: `registry.yaml` is valid; `npm run build` regenerates a valid
  `catalog.json` whose **shape matches §2** (the platform is unaffected); and CI is green.
- **An app** (in its own repo) is done when it meets every requirement in §4 and **installs and
  opens cleanly on a real OpenMasjidOS instance** with only the settings collected at install time.

## 15. Working agreement for Claude (in this repo)
- Read this file first, every session. **§2 (platform contract) is a hard constraint** — never
  change the shape of `catalog.json` here; that would break the platform.
- This repo is **catalog-only**. Don't add real app source here. New apps go in their own repos and
  are added to `registry.yaml`.
- Never hand-edit `catalog.json`; change `registry.yaml` (or an app repo) and run the build.
- Keep `id` == app's manifest id == registry id, kebab-case, matching `^[a-z0-9][a-z0-9-]{0,79}$`.
- Never copy Umbrel/CasaOS definitions or assets (§10). Author fresh.
- If a task seems to require changing how the *platform* installs/serves apps, that belongs in the
  OpenMasjidOS repo (https://github.com/OpenMasjid-Solutions/OpenMasjidOS) — stop and flag it.
