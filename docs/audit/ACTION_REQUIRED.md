<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# ACTION REQUIRED — things only you can do

Audit of **2026-07-31** · baseline `main` @ `4f4a7f0` · branch `audit/security-2026-07-31`

Everything here is outside what an autonomous run may do, or outside this repository. Ordered by
what needs a decision soonest. **Nothing on this list is urgent — there is no leaked credential and
no live exploit.**

---

## 1. Merge the PR (the only thing needed to land this audit)

> **You must merge it yourself. Autonomous push was disabled.**

**Why:** `catalog.json` on `main` **is** the production artifact — the platform fetches
`https://raw.githubusercontent.com/…/OpenMasjidAPPS/main/catalog.json` directly, with no build or
deploy gate. A merge is live to every OpenMasjidOS App Store immediately. On top of that, the branch
touches `scripts/**`, which triggers `build-catalog.yml` on push to `main`; that job regenerates
`catalog.json` and **auto-commits and pushes it unattended**, using `CATALOG_PUSH_TOKEN` — a PAT
chosen specifically to bypass branch protection. So a push both ships the artifact and fires a job
that re-publishes it, with no human in the loop. That is exactly the pre-flight condition that
overrides an instruction to push.

**What to expect when you merge:** the `Build catalog` workflow will run, now with `npm ci`,
`npm run lint` and `npm test` ahead of the build. `catalog.json` rebuilds **byte-identical** — I
verified this after every commit — so the auto-commit step should print `catalog.json already up to
date.` and push nothing. If instead it commits a change to `catalog.json`, something is wrong:
revert the merge (§7) and tell me.

**Rollback is in `REMEDIATION.md`**, per commit and for the whole run.

---

## 2. Credentials to rotate

**None. No credential was found leaked, in the tree or in history.**

All 475 commits on all branches were content-scanned (`git log --all -p -G`) for 18 patterns — AWS
keys, GitHub PAT/OAuth/fine-grained tokens, Stripe live/test/restricted keys and webhook secrets,
Slack tokens, PEM private keys and certificates, Google API keys, JWTs, SendGrid keys, npm tokens,
and Postgres/MySQL/MongoDB URLs with embedded passwords. **Zero hits.** No `.env`, certificate,
backup or database dump has ever been committed.

Listed only so you have the priority order **if** one is ever suspected:

| Priority | Secret | Why it ranks here |
|---|---|---|
| 1 | `CATALOG_PUSH_TOKEN` | Bypasses branch protection on `main` and can publish `catalog.json` to every masjid. The single most powerful credential in this repo. |
| 2 | `PERSONAL_ACCESS_TOKEN` (CLA workflow) | Optional and elevated; used by a `pull_request_target` workflow any commenter can trigger. |
| 3 | GHCR publish tokens in app repos | Not in this repo — each app's `GITHUB_TOKEN` with `packages: write`. |

**One thing worth checking (not a finding):** confirm `CATALOG_PUSH_TOKEN` is scoped as narrowly as
its comment in `build-catalog.yml` claims (Contents: write on this repo only) and is not a broad
`repo`-scoped classic PAT. Repository secrets are not readable, so I could not verify this.

---

## 3. Git history

**No rewrite needed, and I recommend against one.** History is clean of secrets (§2), so there is
nothing to expunge. `filter-repo`/BFG would rewrite 475 commits and break every existing clone and
every `commit:` SHA reference for no benefit. Nothing was force-pushed and no history was rewritten
during this audit.

---

## 4. Cross-repo — changes I could not make here

Per the rule that a cross-repo contract change is never made autonomously, I implemented the safe
half in this repo (validate, reject, log) and recorded the counterpart below. **Sibling repos are
being audited in parallel by sessions that cannot see these changes**, so treat each as a request,
not a done deal.

### 4a. OpenMasjidOS — mirror the new compose checks *(recommended)*

`CLAUDE.md` §10 makes it an invariant that `scripts/validate-compose.mjs` stays in lockstep with the
platform's `apps/compose-validate.ts`, so that *"passes the catalog build == safe to install."* This
audit added four rejections on the catalog side. **Until the platform adds the same ones, an app
that fails the catalog build could still install if it reached the platform another way.**

| Add to `apps/compose-validate.ts` | Finding | Notes |
|---|---|---|
| Reject a top-level network that is `external:` or carries an explicit `name:`, with a distinct message when the target matches `^omos[-_]`; reject `driver: host`/`none`; reject a service joining an undeclared network | APPS-002 | The mirror of the existing `checkExternalVolumes`. Confirmed valid Docker Compose that passed clean. |
| Reject `com.docker.compose.*` and `com.openmasjid.*` label keys on services, networks, volumes, secrets and configs, in both map and `k=v` list form | APPS-004 | `docs/BUILDING_AN_APP.md:573` already **promises** this is "Rejected at build AND at install". |
| Reject `cgroup_parent`; warn on `sysctls` | APPS-011 | `cgroup: host` is already rejected; `cgroup_parent` is the same class. |
| Normalise `cap_add` / `security_opt` / `group_add` to a list before checking | APPS-012 | Not exploitable (Docker rejects scalars) — hygiene, so the check never depends on YAML shape. |

### 4b. OpenMasjidOS — two questions that change a severity here

Both are **unverified**, because I cannot see the platform source. Neither is asserted as a finding.

1. **Does the App Store sanitise the `description` markdown?** It comes verbatim from an untrusted
   app manifest. If the renderer allows raw HTML, hostile manifest markdown is XSS in the dashboard;
   if it escapes, this is cosmetic. The catalog now length-caps and type-checks it (APPS-014), which
   is the half that belongs here.
2. **Does the `.env` writer quote values?** `CLAUDE.md` §7 says answers are written as `KEY=VALUE`.
   If unquoted, a newline in a `settings[].default` injects extra environment variables. The catalog
   now rejects control characters in defaults (APPS-014) — but the platform should quote regardless,
   since it also accepts values typed by the admin.
3. **What is reachable on an `omos_*` Docker network?** Determines the true blast radius of APPS-002.
   The reject is correct either way, so this is for accurate severity, not for the fix.

### 4c. `SyButter/OpenMasjidParkingAttendant` — digest-pin the image *(APPS-019)*

The only third-party entry is the only one not meeting the digest-pinning control this repo
documents. The build says so on every run:

```
⚠ parking-attendant: image "ghcr.io/sybutter/openmasjidparkingattendant:0.2.1" is not digest-pinned
  — a moved tag could repoint it to a backdoored image.
```

Its registry `commit:` pin is correct, so the *compose* is immutable — but the image tag that compose
names is not, so the owner (or anyone who compromises that GHCR account) can repoint `:0.2.1` at
different content and every masjid pulls it on the next install or recreate.

**Why I did not fix it:** the digest must go in **that repo's** `docker-compose.yml`; there is no
field in `registry.yaml` that can pin it. Ask the author to change `image:` to
`ghcr.io/sybutter/openmasjidparkingattendant:0.2.1@sha256:<digest>`, then bump the `commit:` pin here.
Get the digest with:

```bash
docker buildx imagetools inspect ghcr.io/sybutter/openmasjidparkingattendant:0.2.1 --format '{{.Manifest.Digest}}'
```

### 4d. `OpenMasjidDisplay` — one optional check, **not a finding**

Recorded for completeness only, and explicitly **not** a claim about that repo. I never read its
source: the catalog build fetches only each app's `manifest.yaml` and `docker-compose.yml`, so its
application code was never visible to this audit.

While reading the *reference scaffolding* under `examples/`, I noticed a pattern worth a one-minute
check in any prayer-time implementation: clamping the hour-angle equation into `[-1, 1]` instead of
reporting "no solution" turns persistent-twilight nights (normal above ~48°N in summer) into a
confident wrong time. **If** `display` computes prayer times this way, the symptom is distinctive:

> Compute MWL times for London (51.5074, −0.1278) on 21 June. If **Fajr equals Isha**, or Fajr lands
> near 01:00, the clamp is present and a high-latitude rule (Angle-Based / Middle of Night /
> One-Seventh) is needed.

That is a matter for `OpenMasjidDisplay`'s own audit, by whoever can read that code. Prayer-time
correctness is not this repository's concern (`CLAUDE.md` §1, corrected in this branch).

---

## 5. Infra / provider / policy

Nothing was changed; these need your judgement.

1. **Consider whether the auto-publish design is what you want** (no change made, no finding filed —
   it is a deliberate architecture choice). Today an unattended cron can publish to every masjid
   using a protection-bypassing PAT. It now runs behind lint + tests, and the registry is fully
   `commit:`-pinned, so content is stable. If you want a stronger gate, the options are: publish only
   on `workflow_dispatch`/`repository_dispatch` and let cron open a PR instead; or require a review
   on catalog-only commits. Both cost you latency on app releases.
2. **Major action upgrades.** I pinned to the tip of the **same major** each workflow already used —
   deliberately no behaviour change. Newer majors exist (`actions/checkout` v7, `actions/setup-node`
   v7, `docker/*` v4–v7). A major bump is a Tier 2 change; Dependabot (added in this branch) will now
   propose them for review.
3. **Enable Dependabot alerts / security updates** in repo settings if not already on. The config
   added here covers version updates; alerts are a separate toggle.

---

## 6. Assumptions I made — flag any you disagree with

1. **`examples/` is out of scope.** Treated as illustrative scaffolding, not maintained software, per
   your direction and now per corrected `CLAUDE.md` §1/§15. Consequence: the two reference apps are
   **still incomplete on `main`** (`src/index.html`, `src/css/style.css`, `icon.svg`,
   `screenshots/1.svg` were dropped by commit `cabcbae` and never restored), so an author who copies
   one gets a non-serving app. Recorded as APPS-008, unfixed by choice.
2. **New rejections must not break a listed app.** Every new check was verified against all five live
   composes before shipping, and `catalog.json` rebuilds byte-identical after every commit.
3. **Caps are generous, not tight.** `description` 16 KiB (largest live: ~1.7 KB), compose 64 KiB
   (largest live: well under 10 KB), fetch 2 MiB, fetch timeout 20 s. Chosen so nothing real is
   affected; tighten if you prefer.
4. **`path:` with a leading `/` is now rejected rather than silently stripped.** No entry uses it.
5. **APPS-022 accepted as-is.** `cla.yml` uses `pull_request_target` with `actions: write`, triggered
   by any comment — but it never checks out PR code and runs one SHA-pinned action, which is the
   official setup. Not changed.
6. **The `cla` status check.** The PR will need it. As a maintainer you are on the workflow's
   allowlist, so it should pass without action.

---

## 7. If `main` breaks after merge

```bash
# Find the merge, revert it, push the revert.
git -C OpenMasjidAPPS log --oneline -5 main
git -C OpenMasjidAPPS revert -m 1 <merge-sha>
git -C OpenMasjidAPPS push origin main

# Or reset main to the exact pre-audit state (the tag is local until you push it):
git -C OpenMasjidAPPS push origin pre-audit-2026-07-31   # optional: publish the tag first
git -C OpenMasjidAPPS reset --hard pre-audit-2026-07-31  # 4f4a7f0486b4228c630156bf5b51e162f24c34eb
```

Then confirm `catalog.json` on `main` is back to the pre-audit content — that is the file every
masjid reads. Per-finding reverts are in `REMEDIATION.md`.
