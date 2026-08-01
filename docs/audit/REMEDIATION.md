<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# REMEDIATION — what shipped, and how to undo it

Audit of **2026-07-31** · baseline `main` @ `4f4a7f0486b4228c630156bf5b51e162f24c34eb`
Branch `audit/security-2026-07-31` · rollback tag `pre-audit-2026-07-31`

**Not pushed to `main`.** Autonomous push was disabled by pre-flight (see `ACTION_REQUIRED.md` §1).
The branch is offered as a PR.

---

## Read this first — the behaviour-changing bits

Nothing here changes `catalog.json`, the platform contract, or any app. **`catalog.json` rebuilds
byte-identical after every single commit** — verified each time. But three changes alter what the
*build* accepts or does, and those are where to look if something feels off:

### Tier 2 — behaviour-changing, shipped

1. **The build now fails on inputs it previously accepted.** New hard rejections: a registry
   `repo`/`ref`/`path` that is malformed or contains `..`; a compose with an external/renamed network,
   a `com.docker.compose.*`/`com.openmasjid.*` label, or `cgroup_parent`; a manifest whose field types
   or lengths are wrong. **All five live apps were re-verified against every new rule before each
   commit** and none is affected — but a *future* app that would previously have been published may
   now be rejected. That is the intent; the failure message names the exact problem.
2. **CI now gates publication on lint + tests.** `build-catalog.yml` runs `npm run lint` and
   `npm test` before `npm run build`. If either fails, the catalog is **not** regenerated or
   published. This is a deliberate trade: a broken test now blocks app releases until fixed.
3. **`npm install` → `npm ci`.** The job installs exactly what `package-lock.json` pins. If the
   lockfile and `package.json` ever drift out of sync, `npm ci` fails hard rather than silently
   resolving — that is the point, but it is a new way for CI to go red.

No database, migration, API response or user-visible output changes. No `registry.yaml` change, so no
app version moved.

---

## Verification — the actual output

Run on the final commit of the branch, from a clean `node_modules`:

```
$ npm ci
added 1 package, and audited 2 packages in 600ms
found 0 vulnerabilities

$ npm audit
found 0 vulnerabilities

$ npm run lint
✓ lint: 18 file(s) checked, catalog.json matches the platform contract.

$ npm test
ℹ tests 139
ℹ suites 0
ℹ pass 139
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1455.9009

$ npm run build
✓ display ← OpenMasjid-Solutions/OpenMasjidDisplay@a32816bf5e3e3576b4a0bcfb400713b12383e98f
✓ donations ← OpenMasjid-Solutions/OpenMasjidDonations@61ce4307b76eb46634ed47bf0a227228c072597a
✓ kiosk ← OpenMasjid-Solutions/OpenMasjidKiosk@84363b69ed661b7fedd9c553f2a107bf15f148d7
✓ students ← OpenMasjid-Solutions/OpenMasjidStudents@66b75e9ad778c4057424a3d7de7541c99ab54a77
✓ parking-attendant ← SyButter/OpenMasjidParkingAttendant@2cd04c58cdc25f5714f956ef6bbe517be3d062a5
✓ Built catalog.json with 5 app(s).
⚠ 1 security warning(s) above. Immutable commit-SHA pins (registry.yaml) and digest-pinned images
  are the integrity controls for the unattended daily rebuild.

$ git status --porcelain          # after the build
                                 # (empty — catalog.json is byte-identical)
```

The remaining ⚠ is **pre-existing and correct**: `parking-attendant`'s image is not digest-pinned.
It cannot be fixed from this repo — see `ACTION_REQUIRED.md` §4c.

### Before / after

| | Before | After |
|---|---|---|
| Test suite | **none** | **139 tests**, 139 pass |
| Linter / type check | **none** | `npm run lint` (parse + SPDX + platform-contract assertion) |
| CI gate before publishing | none — `npm install` then build | `npm ci` → lint → test → build |
| `npm audit` | 0 vulnerabilities | 0 vulnerabilities (unchanged) |
| Dependencies | 1 (`yaml@2.9.0`) | 1 (`yaml@2.9.0`) — **no new dependency added** |
| Actions on mutable tags | 7 | **0** — all SHA-pinned, Dependabot keeps them fresh |
| Secrets in history (475 commits, 18 patterns) | 0 | 0 |
| `catalog.json` | 5 apps, 26.8 KB | **byte-identical** |

**Baseline honesty:** there was no pre-existing test suite, so the ship gate's "no worse than
baseline" could not be met as written — there was nothing to keep green. I built the suite first
(commit `6b24d5f`) and used it to verify every subsequent fix. CI was green before this run (12/12
recent `Build catalog` runs succeeded) and no pre-existing failure was inherited.

---

## What shipped, per finding

Each row is one revertable commit. **Reverting bottom-up is safest** where noted.

| # | Commit | Finding(s) | What changed | How it was verified |
|---|---|---|---|---|
| 1 | `fbb8426` | — | The audit report | — |
| 2 | `6b24d5f` | APPS-020 | `node:test` suite + `scripts/lint.mjs`, zero new deps | 105 tests pass at that commit; the equinox test caught my own wrong tolerance (see below) |
| 3 | `dca63c3` | **APPS-001** | `registry-validate.mjs`; `repo`/`ref`/`path` validated before any URL is built; `rawBase` re-asserts host + prefix | 119 tests (13 new, incl. one executing the pre-fix URL); build byte-identical |
| 4 | `defc437` | **APPS-002** | Reject external/renamed networks, `driver: host|none`, undeclared network joins | 129 tests (10 new); all 5 live composes pass; build byte-identical |
| 5 | `592f8b3` | APPS-004, -011, -012 | Reserved-label ban enforced; `cgroup_parent` rejected, `sysctls` warns; scalar shapes normalised | 158 tests (13 new); live apps use list form + no labels; build byte-identical |
| 6 | `c0da624` | APPS-007 | Linear merge-key regex; fetch timeout + 2 MiB stream cap + 64 KiB compose cap | 161 tests (4 new); measured 25,712 ms → 0.235 ms at 320 KB |
| 7 | `192e35c` | APPS-005, -006, -020 | `npm ci`; all actions SHA-pinned; lint+test gate before publish | All 4 workflows parse; `npm ci` leaves lockfile untouched; no bare `@vN` remains |
| 8 | `5389c1a` | APPS-014 | Manifest field types, lengths, env-key and port validation | 200 tests (63 new); all 5 live manifests still valid; build byte-identical |
| 9 | `f030efb` | APPS-015 (part) | `.gitignore`: `.env.*`, key/cert material, `.npmrc` | lint passes; nothing previously tracked is now ignored |
| 10 | `82cfbdf` | — | Scoped the branch to the catalog; corrected statuses | lint passes |
| 11 | `bf0b86e` | — | Corrected the APPS-003 write-up (ownership + severity) | lint passes |
| 12 | `64e8b1d` | — | **`CLAUDE.md` §1/§4/§11/§14/§15 + README**: `examples/` is scaffolding, not maintained software; app correctness belongs to the app's repo | lint passes |
| 13 | `14eb844` | APPS-006 | Dependabot for actions + npm, so SHA pins stay maintained | config parses; `yaml` majors excluded from automation |

### Why each fix works

- **APPS-001** — the traversal existed because `path` was only stripped of leading/trailing slashes,
  so `..` survived into a URL that `fetch` then normalised out of the pinned repo. Validating
  *before* building the URL removes the class, and `rawBase` additionally asserts the assembled URL
  is still on `raw.githubusercontent.com` under `/<repo>/<ref>/` — so a future caller that forgets to
  validate still cannot escape. Defence at both the input and the output.
- **APPS-002** — the validator already forbade attaching to storage an app doesn't own; networks were
  simply never inspected, because `classifyVolumeSource` only ever sees volume sources. The new check
  is the same rule applied to the same shapes (`external:` short and long form, `name:` override),
  with a distinct message for `omos[-_]*` because that target reaches the platform.
- **APPS-004** — the rule was documented as enforced and wasn't implemented at all. Now checked on
  every place compose accepts labels, in both syntaxes, case-insensitively.
- **APPS-005** — `npm install` may resolve inside `^2.5.0` and rewrite the lockfile; `npm ci` cannot.
  In a job holding a protection-bypassing PAT, that difference is the whole point.
- **APPS-006** — a tag is mutable, a SHA is not. Pinning removes the moved-tag path; Dependabot stops
  the pin becoming a stale-version problem instead.
- **APPS-007** — the old pattern was quadratic because `\s` matches `\n`, so `(^|\n)` and `\s*`
  overlapped and a match could start at every newline. The anchored `^[ \t]*<<[ \t]*:/m` is linear and
  matches the same directive (proved equivalent on four spellings). Streaming the body with a byte
  budget stops a large response *while* it arrives rather than after buffering it.
- **APPS-011/-012** — `cgroup_parent` escapes the cgroup slice the platform assigns, which is the same
  class as the already-rejected `cgroup: host`. The scalar normalisation is hygiene, not a fix for an
  exploit: Docker Compose rejects scalars there, so nothing was reachable.
- **APPS-014** — untrusted manifest fields reached `catalog.json` unchecked; `name` was truthiness-only
  and then sorted with `localeCompare`, so a numeric name crashed the build. Types, lengths, env-key
  syntax and port ranges are now checked at the boundary the catalog owns.

### Two mistakes I made and corrected — visible so you can judge the rest

1. **APPS-017 was wrong.** I claimed midnight-crossing Isha mis-selected the next prayer, implemented
   a fix, then simulated a full day comparing old and new: **zero** observable difference, because the
   `order` array already checks Fajr before Isha. I reverted the fix rather than ship an unnecessary
   change, and withdrew the finding.
2. **A font change I made caused a regression, caught before commit.** Adding a Naskh face to the
   global font stacks made *English* render in it (a headless render showed `fontStartsWith: "Noto
   Naskh Arabic"` on an English page). Scoped it to `:lang(ar)` etc. instead. That work is no longer
   on this branch — `examples/` is out of scope — but it is the reason I now check computed output
   rather than assuming a CSS edit is inert.

Also worth knowing: **my own test caught my own error.** The equinox invariant initially asserted a
12.000 h day at the equator; the code returned 12.111 h, which is *correct* — sunrise/sunset are taken
0.833° below the horizon, so the apparent day is longer by `2 × 0.833 / 15 = 0.111 h`. I fixed the
test, not the code, and made it pin that constant.

---

## Deferred — and why

| Finding | Sev | Why not fixed |
|---|---|---|
| APPS-008 | Medium | `examples/` out of scope. **Both reference apps are still incomplete on `main`** — `src/index.html`, `src/css/style.css`, `icon.svg`, `screenshots/1.svg` were dropped by `cabcbae` and never restored, so a copied template serves nothing. Recoverable with `git show cabcbae^:apps/<app>/<file>`. |
| APPS-009 | Medium | `examples/` out of scope. `ar`/`ur` are offered but `dir` is never set; `docs/DESIGN.md:36` gives the exact line. |
| APPS-013 | Low | `examples/` out of scope. No lat/lng range check. |
| APPS-018 | Low | `examples/` out of scope. Prayer grid rebuilt via `innerHTML` every second on a 24/7 Pi. |
| APPS-023 | Low | `examples/` out of scope. The image-build template re-pushes the same version tag on every push to `main`, making app image tags mutable. |
| APPS-015 (part) | Low | `.gitignore` half shipped; the `.dockerignore` half is under `examples/`. |
| APPS-019 | Low | Needs a digest pin in **another repo's** compose — impossible from `registry.yaml`. See `ACTION_REQUIRED.md` §4c. |
| APPS-021 | Info | Nothing to fix — history is clean. |
| APPS-022 | Info | Assessed and accepted: no PR checkout, one SHA-pinned action. |
| *3 prayer/Hijri findings* | — | **Withdrawn**, not deferred. Domain correctness belongs to each app's repo, not here. |

---

## Rollback

### Revert one fix

Each is independent **except** where noted. Run from the repo root:

```bash
git revert 14eb844   # Dependabot                                   [APPS-006]
git revert 64e8b1d   # CLAUDE.md / README scope wording
git revert bf0b86e   # APPS-003 write-up correction
git revert 82cfbdf   # branch scoping + status corrections
git revert f030efb   # .gitignore                                   [APPS-015]
git revert 5389c1a   # manifest field validation                    [APPS-014]
git revert 192e35c   # npm ci + SHA pins + CI gate      [APPS-005/-006/-020]
git revert c0da624   # ReDoS + fetch limits                         [APPS-007]
git revert 592f8b3   # labels, cgroup_parent, scalars    [APPS-004/-011/-012]
git revert defc437   # external/renamed networks                    [APPS-002]
git revert dca63c3   # path traversal                               [APPS-001]
git revert 6b24d5f   # test + lint infrastructure                   [APPS-020]
git revert fbb8426   # the audit report
```

**Ordering constraints — only two:**

- `5389c1a` (APPS-014) uses the module introduced by `dca63c3` (APPS-001). **Revert `5389c1a`
  before `dca63c3`.**
- `192e35c` adds `npm run lint` / `npm test` to CI, which need `6b24d5f`. **Revert `192e35c` before
  `6b24d5f`**, or CI will call scripts that no longer exist.

Reverting anything under `scripts/` or `.github/workflows/` on `main` triggers the publish workflow —
expect a `Build catalog` run. `catalog.json` should stay byte-identical either way.

### Revert the whole run

```bash
# Undo the merge commit (preferred once merged — keeps history).
git revert -m 1 <merge-sha>
git push origin main

# Or reset main to the exact pre-audit state.
git reset --hard pre-audit-2026-07-31   # 4f4a7f0486b4228c630156bf5b51e162f24c34eb
```

The tag `pre-audit-2026-07-31` is **local only** until you push it:

```bash
git push origin pre-audit-2026-07-31
```

### Discard the branch entirely (nothing was pushed)

```bash
git branch -D audit/security-2026-07-31
git tag -d pre-audit-2026-07-31
```

`origin/main` is untouched at `4f4a7f0`, so no remote cleanup is needed.
