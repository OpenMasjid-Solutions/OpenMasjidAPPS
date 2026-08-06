# CLAUDE.md — OpenMasjidAPPS

> This file is the single source of truth for the **OpenMasjidAPPS** repository — the **app
> catalog** for **OpenMasjidOS**. Read it fully before writing anything. When in doubt, follow
> this document. If something is ambiguous, ask before guessing.

---

## 0. Branching policy — CHECK THIS BEFORE YOU TOUCH ANYTHING

This repo has two long-lived branches, and they are **update channels the platform fetches**, not
just workflow conveniences (§3b):

| Branch | Role | Who may commit |
|--------|------|----------------|
| **`main`** | **Stable / release.** What every masjid on the default channel installs from. | Only on Hasan's explicit instruction — the words **"merge to main."** |
| **`dev`** | **The default working branch.** All development lands here. | Anyone/any session, freely. |

**Session-start check — run this first, every session:**

```bash
git branch --show-current      # must print: dev
```

If it prints anything else, switch (`git checkout dev`) before editing. If you are on `main`,
**stop and switch** — do not commit there.

**Hard rules:**
- **Never commit to `main`.** Not a fix, not a typo, not "just the catalog".
- **Never merge, rebase onto, cherry-pick into, or fast-forward `main` autonomously** — not even
  when a change is obviously correct, not even to fix something broken on `main`.
- `main` moves **only** when Hasan says **"merge to main."** Until those words, `dev` is where work
  accumulates, however long that takes. The phrase is the trigger — treat it as authorisation only
  when he is *giving* the instruction, not when he is restating the rule.
- **Never force-push and never rewrite history** on either branch.
- A release (`dev` → `main`) must carry a **main-channel** `catalog.json` — see §3b, "Releasing".
- **"Merge to main" means merge *and* publish a GitHub release** — tag the merge commit and write
  release notes. Both halves, every time; see §3b.
- Everything else — including routine dependency bumps — merges into `dev`. Dependabot is pointed
  at `dev` for exactly this reason (`.github/dependabot.yml`), so a bump never needs a release to
  land.

**The reporting rhythm (standing instruction, 2026-08-05).** All development happens on `dev`, and
work is pushed there as it is finished — don't sit on it waiting for permission:

1. Do the work on `dev` and **push it to `dev`**.
2. **End that reply by asking whether to push it to `main`.** Every time a prompt puts something new
   on `dev`, close with the question — a short line, not a paragraph.
3. **Keep going on `dev` until Hasan answers.** The question is a standing offer, not a gate: further
   prompts land more commits on `dev` and each one asks again. Nothing waits on the answer.
4. When he says **"push to main"** or **"merge to main"**, do the release in §3b — the stable-channel
   rebuild, the PR, and the GitHub release. Both trigger phrases mean the same thing.

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
- `examples/` — **illustrative scaffolding only.** Skeletons showing the *shape* an app repo must
  have (`manifest.yaml`, `docker-compose.yml`, a Dockerfile, an entrypoint that turns settings into
  runtime config). They are **documentation, not software this repo maintains**: they are **not** in
  the catalog, **not** built, **not** tested, **not** released, and **not** run by any masjid. Copy
  one into a new repo as a starting point; from that moment it is *your* app's code and it lives and
  is maintained in *your* repo. Do not treat them as a working product, and do not "fix" them as
  part of catalog work — see §15.
- `docs/BUILDING_AN_APP.md` — the hands-on guide for building a compatible app repo.
- `docs/DESIGN.md` — the full UI/UX design language (Sakīna Glass tokens, motion, dock, components)
  every app should match so it looks native to OpenMasjidOS.

### What this repo does NOT contain
Live app source, Dockerfiles for shipped apps, or per-app image CI. **Those live in each app's own
repo.** Do not add an `apps/` folder of real apps here, and do not reintroduce a per-app image
build workflow into this repo.

It also does not own **app behaviour or app correctness**. Prayer-time calculation, Hijri dates,
Qibla, Zakat and donation maths, UI, accessibility and RTL are each app's responsibility, in each
app's own repository. For example, the prayer clocks masjids actually run come from the **`display`**
app (`OpenMasjid-Solutions/OpenMasjidDisplay`), which calculates them itself — nothing under
`examples/` is that engine, and changing `examples/` cannot fix or break it. If you find a
correctness bug in an app, it is a bug **in that app's repo**; open it there.

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
    ref: v1.0.0                                    # STABLE channel — the published release TAG
    commit: <40-char SHA>                          # RECOMMENDED — the immutable SHA that tag is at
    dev_ref: dev                                   # OPTIONAL — DEV channel; a branch (moves)
    path: ""                                       # OPTIONAL — set if manifest.yaml isn't at repo root
```

- **Every entry carries both channel addresses.** `ref`/`commit` is the stable column, `dev_ref` the
  development one. One schema, identical on both branches; the branch being built decides which
  column is used. See **§3b**.
- **`ref` must be a published release tag** (`v1.0.0`) or a 40-char SHA — **never a branch.** The
  build rejects a branch there. A branch belongs in `dev_ref`, which is the only place a moving ref
  is allowed.
- **Pin `commit:`** (the immutable 40-char SHA the tag is at) for reproducible catalogs; a mutable
  `ref` alone gets a ⚠ warning naming the SHA to copy in.
- `id` must be unique, kebab-case, and equal to the app's `manifest.yaml` `id`.
- To add an app: open a PR adding an entry. CI regenerates and commits `catalog.json`.
- **Coming-soon teasers:** a separate top-level `coming_soon:` list holds apps that aren't released
  yet — inline metadata only (`id`, `name`, `tagline`, `category`), **no repo**. The build emits them
  with `comingSoon: true`; the App Store shows a "Coming soon" badge and won't install them. When one
  ships, give it a repo + tag and move it up into `apps:`.

---

## 3b. Channels — stable (`main`) and development (`dev`)

OpenMasjidOS has an **Update Channel** setting that swaps the branch in the one URL it fetches:

```
https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidAPPS/<branch>/catalog.json
                                                                      ^^^^^^^^
                                                     main = stable          dev = development
```

So **each branch publishes its own single-channel `catalog.json`**. The file's shape is identical on
both — §2 is untouched, and **no channel field is added to `catalog.json`**; the branch it is fetched
from is what identifies the channel.

| | stable | development |
|---|---|---|
| Branch here | `main` | `dev` |
| Registry column | `ref` + `commit` | `dev_ref` |
| Ref kind | release tag / SHA — **immutable** | a branch — **moves on purpose** |
| App's image | release tag, `@sha256` digest-pinned | `:dev` |
| Who installs it | every masjid | testers who opted in |

**Building.** `npm run build` takes `--channel main|dev`, defaults from `OPENMASJID_CHANNEL`, then
from the current git branch (`dev`/`dev/*` → dev, anything else → main). Both workflows state it
explicitly, so the git fallback only affects local runs.

```bash
npm run build -- --channel dev      # or: OPENMASJID_CHANNEL=dev npm run build
```

**To ship an app on the dev channel**, that app's repo must:
1. have a **`dev` branch**,
2. **publish a dev-tagged image** from it (`ghcr.io/<owner>/<repo>:dev`),
3. **reference that tag in its dev-branch `docker-compose.yml`**, and
4. carry a **`dev_ref`** in `registry.yaml`.

An app missing any of that still appears on the dev channel — it **falls back to its stable
release**, with a build notice (a declared-but-missing `dev_ref` gets a ⚠ warning). The dev channel
always lists every app.

### Freshness — the dev channel must never be behind stable

This is the mirror of the leakage rule below, and it is just as load-bearing. If
`dev/catalog.json` reports an older version than `main/catalog.json`, a masjid switching to the
Development channel is offered an **app downgrade** — which is what happened on **2026-08-05**: three
apps shipped stable releases, nothing rebuilt the dev catalog, and the dashboard offered to move
every app backwards. Equal versions across channels are fine and normal (a moving `:dev` tag ships
new content under an unchanged version string); *older* is a bug.

Two mechanisms, in this order:

1. **The freshness floor (prevention).** On the dev channel the build peeks at each app's stable
   version and publishes the **newer** of the two columns. An app's `dev` branch can legitimately
   fall behind its own release — a hotfix cut on `main` and never merged down — and in that case the
   dev catalog serves the **stable release** for that app, with a ⚠ warning naming the repo. So the
   invariant holds by construction, not by luck. A version that cannot be parsed counts as *not*
   acceptable: the build falls back rather than claim freshness it cannot establish.
2. **The assertion (detection).** After the catalog is built, every entry is compared against its
   stable version and the build **fails** if any is behind. The floor should make this unreachable —
   it exists because this is the invariant a masjid actually feels, and because a bug in the floor
   must not reach a dashboard. If it ever fires, fix the floor; do not relax the check.

**Staleness is the other half.** A dev catalog goes stale when an app's `dev_ref` branch moves *and*
when an app's stable release moves (because fallback entries and the floor both follow stable). So:

- the schedule is **hourly**, not daily;
- a push to **`main` rebuilds `dev` too** — a stable release invalidates the dev catalog;
- an app repo can force a rebuild immediately with `repository_dispatch` (`rebuild-catalog`) — see
  [`docs/BUILDING_AN_APP.md` §8b](docs/BUILDING_AN_APP.md). That is the prompt path; the hourly
  schedule is the floor under it.

### The dev entry contract — a version axis and an immutable target

A dev entry must give the platform the same two things a stable entry gives it, or dev-channel
updates silently do not work:

1. **`version` is a semver prerelease** — `X.Y.Z-dev.N`, where `X.Y.Z` is the release being worked
   toward and `N` increments per dev build. It must **never equal the stable version**. Ordering is
   `0.10.2 < 0.11.0-dev.1 < 0.11.0`: ahead of the last release, behind the next.
2. **Every service's image is immutable** — `@sha256:<digest>`, or a tag **equal to that entry's
   `version`**. Never `:dev`. A third-party image (a database, say) can only comply by digest, which
   is right: it is as much a part of what gets installed as the app's own image.

Why both, in the words of the failure: OpenMasjidOS detects an update by comparing the catalog's
`version` with the installed version. With a repeated version string there is nothing to compare, so
a new dev build changes nothing observable — no notification, and the update button has no target.
With a moving `:dev` tag the catalog names one build and installs another, so "what you were told
about" and "what you get" are different things. On **2026-08-05** all four apps had both faults at
once and the Development channel was inert.

Enforced by `devEntryProblems()` (`scripts/channels.mjs`), checked per entry against every service.

> **Migration state (agreed 2026-08-05).** A non-compliant dev entry currently **falls back to that
> app's stable release** with a ⚠ warning naming the repo, rather than failing the build. That keeps
> the dev channel valid and lets apps migrate one at a time. **Flip it to `fail()` once every listed
> app publishes prerelease-versioned dev images** — the fallback is a migration aid, not the
> destination. The `else` branch that does it is marked in `build-catalog.mjs`.

This is also the one place a plain release version is legitimate on the dev channel: a **stable
fallback** entry carries the release version and the release image by definition, and the contract is
not applied to it.

**The one rule that must not break: no dev content on `main`.** `main/catalog.json` is production —
the platform fetches that raw file with no build, deploy or staging step in between, so anything
landing there is live to every masjid instantly. Three gates enforce it:

- **the build** fails on a dev ref or a dev-tagged image in the main channel;
- **`npm run lint`** fails when the *committed* `catalog.json` carries dev images and the channel is
  stable — this runs on pull requests, using the **base** branch as the channel, so a `dev` → `main`
  PR is red until its catalog is rebuilt for main;
- **CI** builds one channel per matrix leg and pushes with an explicit refspec to the branch it
  checked out, having asserted `HEAD` matches.

**Releasing (`dev` → `main`)** — only on Hasan's explicit "merge to main" (§0). `catalog.json` will
conflict, because the two branches legitimately hold different builds of it. Resolve it by
**rebuilding, not by picking a side**:

```bash
git checkout -b release/<date> dev
npm run build -- --channel main                    # regenerate from the stable column
OPENMASJID_CHANNEL=main npm run check              # name the channel — see the note below
gh pr create --base main --head release/<date>     # Hasan merges; `cla` must pass
```

> **Name the channel in that check.** A bare `npm run check` on a `release/*` branch resolves the
> channel from git, and `lint` only enforces the no-dev-content rule when the channel was stated
> outright or the branch is literally `main` (`scripts/lint.mjs`). So on a release branch the bare
> command does **not** prove the catalog is clean — pass `OPENMASJID_CHANNEL=main` (or
> `npm run lint -- --channel main`) so it does. The PR into `main` is gated correctly either way,
> because `checks.yml` sets the channel from the PR's base branch; this just moves the discovery
> earlier.

**Then publish the GitHub release** — a "merge to main" is not finished without it (§0):

```bash
git fetch origin && git tag -a vX.Y.Z <merge-commit> -m "…" && git push origin vX.Y.Z
gh release create vX.Y.Z --title "…" --notes-file <notes>
```

**Then bring `dev` back in line** — the last step of every release, not an optional tidy-up:

```bash
git checkout dev && git merge --ff-only origin/main   # dev's catalog.json is now the STABLE one
npm run build -- --channel dev                        # ...so rebuild it BEFORE pushing
npm run check && git commit -am "chore: restore the dev-channel catalog after the release"
```

Do the rebuild **before** the push, in the same push — otherwise the dev channel serves stable
content until the next hourly rebuild, which is the freshness bug in miniature. Skipping this step
entirely is also wrong: `dev` would stay strictly behind `main`, and the *next* release would hit a
`catalog.json` conflict on a PR that should have merged cleanly.

Version the **catalog repo**, not the apps — each app carries its own version in its own manifest,
and the platform never reads a version from this repo. Notes should say what changed for a masjid
(new or delisted apps, channel behaviour) and what changed for an app author (contract changes),
and state plainly whether `catalog.json` itself moved — often it doesn't, which is worth saying.

---

## 4. Requirements for an app repository (READ THIS if you are building an app)

> **For other agents/authors:** an app you build must meet *all* of the following to be listed and
> to install cleanly. A quick way to start is to copy the layout of `examples/<an-app>/` into a new
> repo — but treat it as a skeleton to build on, not finished software (§1): once copied, the code is
> yours and it is maintained in your repo, and it is your job to make it meet §11.
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

Built by `scripts/build-catalog.mjs` from `registry.yaml`. **One channel per branch (§3b)** — the
script builds the channel it is told to and refuses to mix them. For each entry it:
1. picks that channel's ref (`ref`/`commit` on main, `dev_ref` on dev) and resolves a mutable ref to
   the commit SHA it currently points at, so the build always fetches immutable content,
2. fetches `manifest.yaml` and `docker-compose.yml` from the app repo at that ref,
3. validates `id` (kebab), required fields, category, and scans the compose for disallowed
   dangerous directives (§4C),
4. **fails if a dev ref or dev-tagged image would land in the stable catalog**,
5. rewrites `icon`/`screenshots` to absolute raw URLs in **that app's repo**,
6. embeds the compose text as `compose`,
7. writes `{ "apps": [ … ] }` to `catalog.json`.

Run locally: `npm install && npm run build [-- --channel main|dev]` (needs network — it fetches from
GitHub). CI (`.github/workflows/build-catalog.yml`) rebuilds and commits `catalog.json` on
registry/tooling changes, on a daily schedule, on manual dispatch, and on `repository_dispatch`
(`rebuild-catalog`) so app repos can trigger a refresh when they release. A push publishes only the
branch that was pushed; cron/dispatch refresh **both** channels as separate matrix legs, each of
which can only commit to the branch it checked out.

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

> **Applies to an app's own repository, not to this tree.** Everything in this section is normative
> for the repo where the app lives — including anything under `examples/`, once you have copied it
> into your own repo. Nothing here is a to-do list for work in OpenMasjidAPPS (§15).

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
├── registry.yaml                  # both channels' app list (hand-edited); same on main and dev
├── catalog.json                   # GENERATED — the file the platform fetches, one channel per branch
├── package.json                   # dep: yaml; build / test / lint / check
├── scripts/build-catalog.mjs      # registry → catalog.json (fetches app repos)
├── scripts/channels.mjs           # the channel model: ref rules + the dev-artifact gate (§3b)
├── scripts/registry-validate.mjs  # registry + manifest validation (unit-testable)
├── scripts/validate-compose.mjs   # the compose safety gate — lockstep with the platform (§10)
├── scripts/lint.mjs               # syntax, SPDX headers, platform contract, channel hygiene
├── scripts/__tests__/             # node:test suites for the above
├── docs/BUILDING_AN_APP.md        # hands-on guide for building a compatible app repo
├── docs/DESIGN.md                 # the full UI/UX design language every app should match
├── examples/                      # illustrative scaffolding — NOT catalogued, built, tested or
│   ├── prayer-times-display/      #   maintained. Out of scope for work here; see §1 and §15.
│   └── announcements-board/
└── .github/workflows/
    ├── build-catalog.yml          # publishes each branch's channel (matrix: main, dev)
    ├── checks.yml                 # PR gate; channel = the PR's BASE branch
    └── cla.yml
```

## 13. Build & run commands
```bash
npm install                        # once
npm run build                      # regenerate catalog.json for THIS branch's channel
npm run build -- --channel main    # or state it explicitly (main | dev)
npm run check                      # lint + tests — run before every commit
```

---

## 14. Definition of done
- **A catalog change** is done when: `registry.yaml` is valid; `npm run build` regenerates a valid
  `catalog.json` whose **shape matches §2** (the platform is unaffected); `npm run check` passes; the
  work is on **`dev`** (§0); and CI is green.
- **An app** (in its own repo) is done when it meets every requirement in §4 and **installs and
  opens cleanly on a real OpenMasjidOS instance** with only the settings collected at install time.
  This bar is assessed in the app's repo. It is **not** a bar `examples/` has to meet, and a catalog
  change is never blocked on it.

## 15. Working agreement for Claude (in this repo)
- **Check the branch first, every session: `git branch --show-current` must print `dev`** (§0).
  Never commit to `main`; never merge/rebase/cherry-pick into it without the words
  "merge to main."
- Read this file first, every session. **§2 (platform contract) is a hard constraint** — never
  change the shape of `catalog.json` here; that would break the platform. In particular, **do not
  add a channel field to `catalog.json`** — the branch it is fetched from identifies the channel
  (§3b).
- **Never let dev content reach `main`** (§3b). If `catalog.json` conflicts in a `dev` → `main`
  merge, resolve it by rebuilding with `--channel main`, never by choosing a side.
- This repo is **catalog-only**. Don't add real app source here. New apps go in their own repos and
  are added to `registry.yaml`.
- **Do not modify app source in this repo — that includes `examples/`.** Work here is limited to
  `registry.yaml`, `scripts/`, `.github/workflows/`, `docs/`, and the repo's own config. `examples/`
  is illustrative scaffolding (§1), so it is **out of scope for reviews, audits, refactors, test
  coverage and bug fixes**. If something under `examples/` is wrong or incomplete, say so and stop;
  don't fix it as a side quest. Change it only when the user explicitly asks for a change to the
  example scaffolding itself.
- **App correctness is never this repo's bug.** Prayer times, Hijri dates, Qibla, Zakat and donation
  maths, UI/RTL/accessibility, and per-app security all belong to the app's own repository — for
  prayer times that is `OpenMasjidDisplay`, not `examples/`. Report such a finding as a cross-repo
  item for that repo; do not "fix" it here, because fixing it here fixes nothing for any masjid.
  Never assert a bug in an app repo you have not actually read: the build fetches only each app's
  `manifest.yaml` and `docker-compose.yml`, so its application code is not visible from here.
- Never hand-edit `catalog.json`; change `registry.yaml` (or an app repo) and run the build.
- Keep `id` == app's manifest id == registry id, kebab-case, matching `^[a-z0-9][a-z0-9-]{0,79}$`.
- Never copy Umbrel/CasaOS definitions or assets (§10). Author fresh.
- If a task seems to require changing how the *platform* installs/serves apps, that belongs in the
  OpenMasjidOS repo (https://github.com/OpenMasjid-Solutions/OpenMasjidOS) — stop and flag it.
