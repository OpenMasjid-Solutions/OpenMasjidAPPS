<h1 align="center"><b>OpenMasjidAPPS</b></h1>

<p align="center">
  <a href="#whats-in-the-catalog">What's in the catalog</a> |
  <a href="#how-it-works">How it works</a> |
  <a href="#update-channels">Channels</a> |
  <a href="#the-openmasjidos-fabric">Fabric</a> |
  <a href="#what-the-build-refuses">Safety</a> |
  <a href="#adding-an-app">Adding an app</a> |
  <a href="#licensing">License</a>
</p>

<div align="center">
  <a href="https://github.com/OpenMasjid-Solutions/OpenMasjidAPPS/releases">
    <img src="https://img.shields.io/github/v/release/OpenMasjid-Solutions/OpenMasjidAPPS?style=flat-square&color=blue" alt="Latest Release" />
  </a>
  <a href="https://github.com/OpenMasjid-Solutions/OpenMasjidAPPS">
    <img src="https://img.shields.io/github/stars/OpenMasjid-Solutions/OpenMasjidAPPS?style=flat-square&color=blue" alt="Stars" />
  </a>
  <a href="https://discord.gg/MpPDbyQfaF">
    <img src="https://img.shields.io/badge/Discord-Join-blue?style=flat-square&logo=discord" alt="Discord" />
  </a>
</div>

<h5 align="center">
Leave a star if you like the project! ⭐️
</h5>

The **app catalog** for [**OpenMasjidOS**](https://github.com/OpenMasjid-Solutions/OpenMasjidOS) — a free,
self-hosted, masjid-themed platform for running Docker apps.

This repo is a **catalog only**. It does **not** hold app source code. Each app lives in its **own
repository**; this repo keeps a [`registry.yaml`](./registry.yaml) of those repos and generates the
single [`catalog.json`](./catalog.json) the platform fetches to populate its App Store.

> Building an app? Read **[docs/BUILDING_AN_APP.md](./docs/BUILDING_AN_APP.md)** (hands-on),
> **[docs/DESIGN.md](./docs/DESIGN.md)** (the full UI/UX design language every app should match), and
> **[CLAUDE.md](./CLAUDE.md)** (the authoritative contract).

## What's in the catalog

| App | Category | What it does |
|-----|----------|--------------|
| **[OpenMasjid Display](https://github.com/OpenMasjid-Solutions/OpenMasjidDisplay)** | `displays` | Prayer timetables, cameras and HDMI on every screen in the masjid |
| **[OpenMasjid Donations](https://github.com/OpenMasjid-Solutions/OpenMasjidDonations)** | `donations` | Card donations on the masjid's network with Stripe — appeals, Zakat, Gift Aid, monthly plans, receipts |
| **[OpenMasjid Kiosk](https://github.com/OpenMasjid-Solutions/OpenMasjidKiosk)** | `donations` | Tap-to-donate kiosk for a wall-mounted tablet with a Stripe reader |
| **[OpenMasjid Students](https://github.com/OpenMasjid-Solutions/OpenMasjidStudents)** | `admin` | Tuition & fees for a madrasa — pay online, at the kiosk, or in person |

Categories are exactly: `displays` `donations` `community` `quran` `admin` `utilities`.

`registry.yaml` also has a `coming_soon:` list — teaser entries with metadata only and no repo. They
appear in the App Store with a **Coming soon** badge and can't be installed.

## How it works

```
app repos (one per app) ──listed in──▶ registry.yaml ──build──▶ catalog.json ──fetched by──▶ OpenMasjidOS
```

- Each app is its **own public repo** with a `manifest.yaml`, a `docker-compose.yml`, an icon, and a
  publicly-published multi-arch Docker image (amd64 + arm64, so it runs on a mini-PC or a Pi).
- `registry.yaml` lists those repos. `scripts/build-catalog.mjs` fetches each one's manifest and
  compose **at a pinned commit**, validates them, rewrites icon/screenshot paths to absolute URLs, and
  embeds the compose text into `catalog.json` (repo root) — the **only** file the platform reads:
  `https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidAPPS/main/catalog.json`
- The platform installs an app by writing that compose to disk, writing the user's answers to the
  app's `settings` into a `.env`, and running
  `docker compose -p omos-<id> --env-file <.env> up -d --remove-orphans`.
- The "Open" button is derived from the **published host port**, so an app's compose must publish its
  web-UI port. Port clashes are detected and remapped by the platform.
- **No masjid profile is injected.** The platform holds zero prayer/masjid data — everything
  masjid-specific (name, lat/long, calculation method, madhab, timezone) an app collects through its
  own `settings` and uses internally.

## Update channels

OpenMasjidOS's **Update Channel** setting swaps the branch in that URL, so this repo publishes two
catalogs — one per branch:

| Channel | URL | Built from |
|---------|-----|------------|
| **stable** (default) | `.../OpenMasjidAPPS/main/catalog.json` | each entry's `ref`/`commit` — release tags, digest-pinned images |
| **dev** | `.../OpenMasjidAPPS/dev/catalog.json` | each entry's `dev_ref` — the app's `dev` branch and its `:dev` image |

`registry.yaml` holds **both** addresses per app and is identical on both branches; the branch being
built decides which column is used. An app with no `dev_ref` still appears on the dev channel — it
falls back to its stable release. Nothing unreleased can reach the stable catalog: the build, the
linter and CI each refuse it. Details in [`CLAUDE.md` §3b](CLAUDE.md) and
[docs/BUILDING_AN_APP.md §8b](./docs/BUILDING_AN_APP.md).

Development happens on **`dev`**; `main` moves only for a release.

## The OpenMasjidOS Fabric

The **Fabric** is the platform↔app integration layer. With **no opt-in at all**, an app already
inherits the dashboard's theme and wallpaper when opened. Everything beyond that is an explicit flag
in the app's `manifest.yaml` — each one optional, backwards-compatible, and off by default:

| Flag | What the app gains |
|------|--------------------|
| `sso: true` | Shares the dashboard login. The app's backend checks `GET /api/auth/session` with a per-app secret; identity-bound, fails closed, and the app must still work standalone. |
| `notifications: true` | Relays a message to the masjid's configured webhook (Slack/Discord/generic) via `POST /api/fabric/notify`. The admin sets the destination once; **the app never sees the URL**. |
| `stripe: true` | Fetches shared Stripe keys from the OS vault (`GET /api/fabric/stripe`) instead of each app storing its own. |
| `domain: true` | Learns its own public URL (`GET /api/fabric/site`) for absolute links — Stripe return URLs, webhooks, QR codes. |
| `email: true` | Sends mail (receipts, parent notices) through the admin's provider via `POST /api/fabric/email` — the app never sees the mail credentials. |
| `alerts: [...]` | Declares named alert types it can raise (`POST /api/fabric/alert`); the admin gets a granular on/off per alert. |
| `fabric: {provides, consumes}` | App-to-app broker: serve a capability, or call another app's, brokered by the platform. |
| `tunnel: true` | *Requests* internet exposure through the OS's Cloudflare tunnel — the admin still confirms per app. Off ⇒ LAN only. |
| `https: true` | **Stripe apps only.** Stripe's reader SDK and in-page card fields need a secure context, so the platform serves the app over HTTPS on a dedicated port. |

An opted-in app is issued a **per-app secret** at install (`OPENMASJID_APP_SECRET`) — a credential,
never to be logged or exposed. Treat any Fabric session value as an **identity assertion** ("is the
viewer the platform admin?"), never as a credential to call the platform's admin API.
Full normative contract: [docs/BUILDING_AN_APP.md §7](./docs/BUILDING_AN_APP.md) and
[`CLAUDE.md` §7b](CLAUDE.md).

All four listed apps opt into `sso`, `notifications`, `domain` and `https`; three use `stripe`,
`email`, `alerts` and the app-to-app broker.

## What the build refuses

`catalog.json` on `main` is fetched directly by every masjid with **no deploy step in between**, so
the build is the gate. It **fails** — not warns — on any of:

- **A dangerous compose.** `scripts/validate-compose.mjs` parses the YAML and rejects `privileged`,
  every host namespace (`network_mode: host`, `pid`, `ipc`, `userns_mode`, `cgroup`, `uts`),
  `cap_add`, `devices`, `device_cgroup_rules`, `security_opt: …unconfined`, `group_add` of
  root/docker, mounting the Docker socket, sensitive host paths or any path escaping the app folder,
  `extends`/`include`, `volumes_from`, external or platform-reserved networks, reserved discovery
  labels, and `cgroup_parent`. It is kept in **lockstep with the platform's own install-time check**,
  so *passes the catalog build* == *safe to install*.
- **An unsafe registry entry.** A `..` segment or URL punctuation in `repo`/`ref`/`dev_ref`/`path`
  would redirect a commit-pinned entry at a different repository while still looking pinned.
- **A manifest that breaks the platform contract.** Wrong types, over-long fields, a bad `id`,
  an unknown category, malformed `settings`/`ports`/`fabric`/`alerts`, or an icon path that isn't
  inside the app's repo.
- **Development content on the stable channel.** A branch in `ref`, or a dev-tagged image anywhere in
  the compose.

Supply-chain hardening (it **warns** on these, so a maintainer sees them without breaking apps that
already shipped):

- **Immutable pins.** Registry entries pin a 40-char `commit:` SHA, not a movable tag — a tag can be
  repointed at backdoored content and the unattended daily rebuild would republish it. A mutable ref
  is resolved to the SHA it currently points at and warned about.
- **Digest-pinned images.** `image: …:1.2.3@sha256:…`, because a tag can be moved to a different
  image while the version string looks unchanged. (The `:dev` channel is deliberately exempt — a
  moving tag is the point there.)
- **SHA-pinned GitHub Actions** and `npm ci`, so an unattended job can't pull unreviewed code.
  Dependabot watches both weekly.

## Working on this repo

```bash
npm install
npm run build                      # regenerate catalog.json for this branch's channel
npm run build -- --channel main    # or state it (main | dev)
npm test                           # 180 unit tests, zero test dependencies (node:test)
npm run lint                       # syntax, SPDX headers, platform contract, channel hygiene
npm run check                      # lint + tests — run before every commit
```

```
registry.yaml                  the app list, both channels (the only hand-edited source)
catalog.json                   GENERATED — what the platform fetches; never hand-edit
scripts/build-catalog.mjs      registry → catalog.json
scripts/channels.mjs           the channel model: ref rules + the dev-artifact gate
scripts/validate-compose.mjs   the compose safety gate (lockstep with the platform)
scripts/registry-validate.mjs  registry + manifest validation
scripts/lint.mjs               dependency-free static checks
scripts/__tests__/             node:test suites
docs/                          BUILDING_AN_APP.md · DESIGN.md · APP_LICENSING.md · audit/
```

Every PR runs lint + tests before it can merge; the catalog is rebuilt and committed by CI, never by
hand.

## Adding an app

1. Build your app in its **own repo** — see [docs/BUILDING_AN_APP.md](./docs/BUILDING_AN_APP.md).
   (Fastest start: copy a folder from [`examples/`](./examples/) into a new repo and adapt it.)
2. Publish a **public, multi-arch** image and **digest-pin** it in your compose.
3. Add an entry to [`registry.yaml`](./registry.yaml):
   ```yaml
   apps:
     - id: my-app
       repo: <owner>/openmasjid-my-app
       ref: v1.0.0            # a release tag, never a branch
       commit: <40-char SHA>  # the immutable SHA that tag is at
       dev_ref: dev           # optional — only if your repo has a dev branch
   ```
4. Open a PR **into `dev`**. CI validates your repo and rebuilds `catalog.json` automatically.

## `examples/`

**Illustrative scaffolding** (`prayer-times-display`, `announcements-board`) showing the *shape* an
app repo needs: `manifest.yaml`, `docker-compose.yml`, a Dockerfile, and an entrypoint that turns
install settings into runtime config.

They are documentation, not software this repo maintains — **not** in the catalog, **not** built,
tested or released, and **not** run by any masjid. Copy one as a starting point; from then on the
code is yours, lives in your repo, and it is your job to make it meet the quality bar in
[`CLAUDE.md` §11](CLAUDE.md). App behaviour and correctness (prayer times, Hijri dates, Zakat maths,
RTL) belong to each app's own repository — the prayer clocks masjids actually run come from the
`display` app, [OpenMasjidDisplay](https://github.com/OpenMasjid-Solutions/OpenMasjidDisplay), not
from anything here.

## Maintainers — catalog auto-publish (`CATALOG_PUSH_TOKEN`)

The **Build catalog** workflow (`.github/workflows/build-catalog.yml`) regenerates and commits
`catalog.json` on every push to `registry.yaml`/`scripts/`, on a daily schedule, and on manual /
`repository_dispatch` runs.

It runs **one matrix leg per channel**. A push publishes only the branch that was pushed; cron,
manual runs and `repository_dispatch` refresh **both** `main` and `dev` (pass `channel: main|dev|both`
to narrow it). Each leg checks out its own branch, builds that channel, and pushes with an explicit
refspec after asserting `HEAD` matches — so a dev build cannot commit to `main`, or the reverse.

`main` is protected by a required **`cla`** status check. A direct push never produces that check, so
the default `github-actions[bot]` token **cannot** push the rebuilt `catalog.json` — it's rejected
with *"Required status check `cla` is expected"*, and the auto-publish silently stops. To let the
workflow publish **while keeping the CLA gate fully required**, it checks out with a bypass token:

- Add a repository secret **`CATALOG_PUSH_TOKEN`** — a token from an account allowed to **bypass
  branch protection**, scoped to **Contents: write** on this repo. Either a **fine-grained PAT**
  (resource owner `OpenMasjid-Solutions`, only this repo, *Contents: Read and write*) or a **classic
  PAT** with the `repo` scope works.
- The workflow uses `token: ${{ secrets.CATALOG_PUSH_TOKEN || github.token }}`. When the secret is
  **unset**, it falls back to the default token — the push then fails loudly, and someone with bypass
  must publish `catalog.json` manually (`npm install && npm run build`, then commit + push).

**Rotate** the token before its expiry. If a Build-catalog run starts failing at the *push* step, an
expired or revoked `CATALOG_PUSH_TOKEN` is the most likely cause.

Two long-lived branches, and **both are published**: `main` (stable) and `dev` (development). CLA
signatures live on a third, `cla-signatures` — a storage branch the CLA Assistant writes to; it is
not stale and must not be deleted.

## Licensing

This repository — the catalog tooling, registry, and example scaffolding — is licensed
**AGPL-3.0** (© 2026 Hasan Ismail), the same as the platform (see [LICENSE](./LICENSE)). Under the
AGPL's network clause (§13), if you run a **modified** version of this software as a network service,
you must make your modified source available to its users under the AGPL.

Contributions to this repo are governed by a **[Contributor License Agreement](./CLA.md)** (enforced
by the `cla` check): AGPL-3.0 inbound, plus a grant letting OpenMasjid-Solutions also offer
commercial/dual licenses. The public tree stays AGPL-3.0 and contributors keep their copyright — see
[CONTRIBUTING.md](./CONTRIBUTING.md).

**Each app keeps its own license**, declared in its `manifest.yaml` `license` field. Apps run at
arm's length as separate containers, so they are not bound by this repo's license or its CLA —
listing an app in `registry.yaml` does not relicense it. Do not copy app definitions or assets from
umbrelOS or CasaOS — author them fresh. See [CLAUDE.md §10](./CLAUDE.md).
