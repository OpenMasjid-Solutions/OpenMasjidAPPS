# Contributing to OpenMasjidAPPS

Thanks for helping build the masjid app catalog. Please read [CLAUDE.md](./CLAUDE.md) (the
authoritative contract) and [docs/BUILDING_AN_APP.md](./docs/BUILDING_AN_APP.md) before opening a PR.

## What this repo accepts

- **Listing an app:** a PR adding an entry to [`registry.yaml`](./registry.yaml). Your app lives in
  its **own** public repo and must meet the requirements in CLAUDE.md §4 and the **Security
  requirements** in docs/BUILDING_AN_APP.md §2b (digest-pinned image, least-privilege compose, etc.).
- **Tooling/docs/examples:** improvements to the build script, docs, or the reference apps under
  `examples/`.

The catalog build (`npm run build`) and CI **reject** any app whose compose requests host-level
privilege (privileged, host namespaces, `cap_add`, Docker-socket or sensitive host bind-mounts,
`build`/`extends`/`include`, etc.). "Passes the catalog build" is meant to equal "installs on the
platform" — don't weaken these checks.

## Licensing & sign-off (DCO)

- This repository is **AGPL-3.0-only** (© 2026 Hasan Ismail). Contributions to **this repo** —
  tooling, docs, and the `examples/` reference apps — are accepted under **AGPL-3.0-only**. Add an
  SPDX header to new source files:
  - `.js` / `.mjs` / `.ts`: `// SPDX-License-Identifier: AGPL-3.0-only`
  - `.yml` / `.yaml` / `Dockerfile` / `.sh`: `# SPDX-License-Identifier: AGPL-3.0-only`
- Apps in their **own** repos keep **their own** license (the manifest `license` field) — AGPL does
  not reach across the arm's-length container boundary.
- Sign off your commits (Developer Certificate of Origin): `git commit -s`. By signing off you
  certify you wrote the change or have the right to submit it under the project license.

## Ground rules

- **Never** copy app manifests, compose files, icons, or assets from umbrelOS / `umbrel-apps`
  (PolyForm Noncommercial) or CasaOS stores. Author originals.
- Keep `catalog.json` **generated** — edit `registry.yaml` (or your app repo) and run `npm run build`;
  never hand-edit `catalog.json`.
- Be calm, dignified, and plain-spoken in user-facing text (see CLAUDE.md §11).
