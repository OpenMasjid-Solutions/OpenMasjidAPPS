<h1 align="center"><b>OpenMasjidAPPS</b></h1>

<p align="center">
  <a href="#how-it-works">How it works</a> |
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

## How it works

```
app repos (one per app) ──listed in──▶ registry.yaml ──build──▶ catalog.json ──fetched by──▶ OpenMasjidOS
```

- Each app is its **own public repo** with a `manifest.yaml`, a `docker-compose.yml`, an icon, and a
  publicly-published Docker image.
- `registry.yaml` lists those repos. `scripts/build-catalog.mjs` fetches each one and assembles
  `catalog.json` (repo root) — the **only** file the platform reads, from:
  `https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidAPPS/main/catalog.json`
- The platform installs an app by running its `compose` as `docker compose -p omos-<id> up -d`,
  injecting the user's answers to the app's `settings` as environment variables.

## The OpenMasjidOS Fabric (optional)

Apps can plug into the **OpenMasjidOS Fabric** — the platform↔app integration layer (unified
appearance + single sign-on / API). With no opt-in, an app already inherits the dashboard's theme and
wallpaper when opened; adding `sso: true` to its `manifest.yaml` lets it share the dashboard login
(the platform issues each such app a per-app secret and binds session checks to it). It's optional,
backwards-compatible, and never carries masjid data. See
[docs/BUILDING_AN_APP.md §7](./docs/BUILDING_AN_APP.md).

## Adding an app

1. Build your app in its **own repo** — see [docs/BUILDING_AN_APP.md](./docs/BUILDING_AN_APP.md).
   (Fastest start: copy a folder from [`examples/`](./examples/) into a new repo and adapt it.)
2. Add an entry to [`registry.yaml`](./registry.yaml):
   ```yaml
   apps:
     - id: my-app
       repo: <owner>/openmasjid-my-app
       ref: v1.0.0
   ```
3. Regenerate the catalog (optional locally — CI does it on push):
   ```
   npm install
   npm run build
   ```
4. Open a PR. CI rebuilds and commits `catalog.json` automatically.

## `examples/`

Complete, working **reference apps** (`prayer-times-display`, `announcements-board`) you copy into a
new repo to start. They are templates/documentation — they are **not** part of the catalog (the
registry is).

## Maintainers — catalog auto-publish (`CATALOG_PUSH_TOKEN`)

The **Build catalog** workflow (`.github/workflows/build-catalog.yml`) regenerates and commits
`catalog.json` on every push to `registry.yaml`/`scripts/`, on a daily schedule, and on manual /
`repository_dispatch` runs.

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

## Licensing

This repository — the catalog tooling, registry, and example scaffolding — is licensed
**AGPL-3.0** (© 2026 Hasan Ismail), the same as the platform (see [LICENSE](./LICENSE)). Under the
AGPL's network clause (§13), if you run a **modified** version of this software as a network service,
you must make your modified source available to its users under the AGPL.

**Each app keeps its own license**, declared in its `manifest.yaml` `license` field. Apps run at
arm's length as separate containers, so they are not bound by this repo's license. Do not copy app
definitions or assets from umbrelOS or CasaOS — author them fresh. See [CLAUDE.md §10](./CLAUDE.md).
