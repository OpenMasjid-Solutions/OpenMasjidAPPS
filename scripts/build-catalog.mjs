// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Hasan Ismail
/**
 * Builds catalog.json by aggregating the app repositories listed in registry.yaml.
 *
 * Each app lives in its OWN repository. For every registry entry this script:
 *   1. fetches that repo's manifest.yaml and docker-compose.yml (at the pinned ref
 *      for the channel being built — see below),
 *   2. validates the id / required fields / category and scans the compose for
 *      disallowed (dangerous) directives,
 *   3. rewrites icon/screenshots to absolute raw URLs in that repo,
 *   4. embeds the compose text as the entry's `compose` string,
 * then writes { apps: [...] } to catalog.json at the repo root — the exact file
 * and shape OpenMasjidOS fetches. The platform contract is unchanged; only the
 * SOURCE of each entry moved from local folders to external repos. See CLAUDE.md.
 *
 * CHANNELS. The platform's Update Channel setting swaps the branch in the raw URL
 * it fetches, so each branch of this repo publishes its own catalog.json:
 * `main` = stable, `dev` = development. registry.yaml holds both addresses per app
 * (`ref` + `dev_ref`) with one schema on both branches; this script builds one
 * channel at a time and refuses to put development content in the stable catalog.
 *
 * Run: npm install && node scripts/build-catalog.mjs [--channel main|dev]
 *      (needs network access; the channel defaults from the current git branch)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { validateCompose } from './validate-compose.mjs';
import { validateSource, rawBase, validateManifestFields } from './registry-validate.mjs';
import { capabilityFields, capabilityProblems } from './capabilities.mjs';
import { parseCommands, isReservedAppId, COMMANDS_CAPABILITY, RESERVED_APP_ID_WORDS } from './commands.mjs';
import {
  resolveChannel,
  isStableRef,
  isDevImageRef,
  findDevArtifacts,
  imageRefsIn,
  CHANNEL_BRANCH,
  COMMIT_SHA_RE,
  devVersionIsAcceptable,
  compareVersions,
  devEntryProblems,
  IMAGE_DIGEST_RE,
  findVersionRegressions,
  PUBLISHED_MAIN_CATALOG_URL,
} from './channels.mjs';

const REGISTRY = 'registry.yaml';

// Must match OpenMasjidOS's isValidAppId — the platform drops invalid ids.
const APP_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const CATEGORIES = new Set(['displays', 'donations', 'community', 'quran', 'admin', 'utilities']);

// Fabric app-to-app broker shapes — mirror OpenMasjidOS's parseFabric
// (packages/core/src/apps/manager.ts): a capability is a kebab slug; a consume
// grant is "<app-id>/<capability>".
const CAPABILITY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const GRANT_RE = /^[a-z0-9][a-z0-9-]{0,79}\/[a-z0-9][a-z0-9-]{0,39}$/;

// A full git commit SHA — 40 lowercase hex chars. Pinning a registry entry to one
// of these is the ONLY immutable pin: tags and branches are mutable, so a repo
// owner (or whoever compromises the repo) can move them to backdoored content and
// the unattended hourly rebuild (see .github/workflows/build-catalog.yml) will
// republish it under a previously-reviewed ref. A SHA cannot be moved.
// Defined once in channels.mjs — the channel rules test the same shape, and two
// copies of this regex would eventually disagree.

// A digest-pinned image reference contains @sha256:<64 hex>. Without it, a moved
// image tag can repoint a "pinned" version string to a different (backdoored)
// image — pinning the tag is NOT enough; pin the digest. IMAGE_DIGEST_RE and the
// image scanner both live in channels.mjs so the dev entry contract and this warning
// cannot drift apart.

// Compose safety is enforced by validateCompose() (scripts/validate-compose.mjs),
// which parses the YAML and mirrors the platform's install-time risk check so that
// "passes the catalog build" === "installs on the platform".

let warnings = 0;
function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
// Non-fatal: surfaced prominently so a maintainer notices, but does not break the
// build (we must not start failing apps that already shipped on a mutable pin).
function warn(msg) {
  warnings++;
  console.warn(`⚠ ${msg}`);
}
// Expected-and-worth-saying — a channel fallback, or a dev tag on the dev channel.
// Not a warning: things that are working as designed must not train a maintainer
// to ignore the ⚠ lines that aren't.
function notice(msg) {
  console.log(`· ${msg}`);
}

// Which channel are we building? --channel wins, then OPENMASJID_CHANNEL, then the
// current git branch (see channels.mjs). Both workflows state it explicitly; the
// git fallback is for local runs.
function currentGitBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null; // no git, or a bare/detached checkout — fall through to the default
  }
}

let channel, channelSource;
try {
  ({ channel, source: channelSource } = resolveChannel({
    argv: process.argv.slice(2),
    env: process.env,
    branch: currentGitBranch(),
  }));
} catch (e) {
  fail(e.message);
}
const isDevChannel = channel === 'dev';
console.log(
  `▶ channel: ${channel} (from ${channelSource}) — this catalog.json belongs on the "${CHANNEL_BRANCH[channel]}" branch.`,
);

// Validate + normalise a manifest `fabric:` block (the app-to-app broker). Returns
// { provides?: [{capability}], consumes?: string[] } — the exact shape the platform
// consumes — or undefined when there's no (effective) block. fail()s on a bad shape
// so "passes the catalog build == safe to install" holds. A malformed shape is a
// hard error (NOT the silent `=== true ? true : undefined` coercion the flags use).
// Mirrors OpenMasjidOS parseFabric (packages/core/src/apps/manager.ts).
function parseFabricManifest(id, fabric) {
  if (fabric == null) return undefined;
  if (typeof fabric !== 'object' || Array.isArray(fabric)) {
    fail(`${id}: manifest "fabric" must be an object with "provides" and/or "consumes"`);
  }
  const provides = [];
  if (fabric.provides != null) {
    if (!Array.isArray(fabric.provides)) fail(`${id}: fabric.provides must be a list`);
    for (const p of fabric.provides) {
      const cap = p && typeof p === 'object' ? p.capability : undefined;
      if (typeof cap !== 'string' || !CAPABILITY_RE.test(cap)) {
        fail(`${id}: each fabric.provides entry needs a kebab-case "capability" (a-z, 0-9, -)`);
      }
      // Refused unconditionally, exactly as the platform does — NOT only when the app
      // also declares `commands:`. Refusing only the both-at-once case would let a
      // manifest pass the catalog build and then fail at install, which is the one
      // divergence this mirror exists to prevent.
      if (cap === COMMANDS_CAPABILITY) {
        fail(`${id}: "${COMMANDS_CAPABILITY}" is reserved for admin commands — declare them under "commands:", not fabric.provides. Both are served at /fabric/commands/run, but fabric.provides would expose that admin-only handler to any app that consumes "${id}/${COMMANDS_CAPABILITY}"`);
      }
      provides.push(cap);
    }
  }
  const consumes = [];
  if (fabric.consumes != null) {
    if (!Array.isArray(fabric.consumes)) fail(`${id}: fabric.consumes must be a list`);
    for (const c of fabric.consumes) {
      if (typeof c !== 'string' || !GRANT_RE.test(c.trim())) {
        fail(`${id}: each fabric.consumes entry must be "<app-id>/<capability>" (kebab-case)`);
      }
      consumes.push(c.trim());
    }
  }
  if (!provides.length && !consumes.length) return undefined;
  const out = {};
  if (provides.length) out.provides = provides.map((capability) => ({ capability }));
  if (consumes.length) out.consumes = consumes;
  return out;
}

// Validate + normalise a manifest `commands:` list — the admin commands a masjid admin
// runs by messaging the masjid's WhatsApp number (`!students`, `!display 2`). The rules
// live in scripts/commands.mjs, which mirrors OpenMasjidOS parseCommands and carries
// the reasoning; here we only translate its throw into the build's fail().
function parseCommandsManifest(id, commands) {
  try {
    return parseCommands(commands, id);
  } catch (e) {
    fail(`${id}: ${e.message}`);
  }
}

// Validate + normalise a manifest `alerts:` list (the granular admin-alert types).
// Returns a cleaned [{id,label,description?}] (or undefined when absent). fail()s on
// a bad shape. Mirrors OpenMasjidOS parseAlerts (packages/core/src/apps/manager.ts).
function parseAlertsManifest(id, alerts) {
  if (alerts == null) return undefined;
  if (!Array.isArray(alerts)) fail(`${id}: manifest "alerts" must be a list`);
  const out = [];
  const seen = new Set();
  for (const a of alerts) {
    const aid = a && typeof a === 'object' ? a.id : undefined;
    const label = a && typeof a === 'object' ? a.label : undefined;
    const description = a && typeof a === 'object' ? a.description : undefined;
    if (typeof aid !== 'string' || !CAPABILITY_RE.test(aid)) {
      fail(`${id}: each alert needs a kebab-case "id" (a-z, 0-9, -)`);
    }
    if (typeof label !== 'string' || !label.trim()) fail(`${id}: alert "${aid}" needs a "label"`);
    if (seen.has(aid)) fail(`${id}: duplicate alert id "${aid}"`);
    seen.add(aid);
    out.push({
      id: aid,
      label: label.trim().slice(0, 80),
      description: typeof description === 'string' ? description.trim().slice(0, 200) : undefined,
    });
  }
  return out.length ? out : undefined;
}

// Ceilings for anything fetched from an app repo. The largest real manifest is a
// couple of KB and the largest compose well under 10 KB, so these are generous —
// they exist so one repo cannot stall or exhaust the unattended nightly rebuild.
const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_BYTES = 2 * 1024 * 1024; // 2 MiB

// The build had no timeout and no size limit: res.text() buffered whatever the
// remote sent, so a slow or huge response could hang the job (up to the 6-hour
// Actions ceiling) or exhaust its memory. Read the body as a stream and stop the
// moment it goes over budget, rather than discovering the size after buffering it.
// (APPS-007)
async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    // Carry the status: the dev channel treats a definitive 404 (branch or file
    // simply not there) as "fall back to the stable release", and anything else —
    // a timeout, a 5xx — as a real failure. A transient error must NOT silently
    // downgrade an app to the other channel.
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_FETCH_BYTES) {
    throw new Error(`response is ${declared} bytes, over the ${MAX_FETCH_BYTES}-byte limit`);
  }
  if (!res.body) return '';

  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX_FETCH_BYTES) {
      throw new Error(`response exceeded the ${MAX_FETCH_BYTES}-byte limit`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Best-effort: resolve a mutable tag/branch to the commit SHA it currently points
// at, so a maintainer can copy that SHA into registry.yaml for an immutable pin.
// Uses the public GitHub commits API; returns null if unreachable/rate-limited —
// never hard-fails (the build must work offline-ish and without a token).
async function resolveRefToSha(repo, ref) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`, {
      headers: { Accept: 'application/vnd.github.sha' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const sha = (await res.text()).trim();
    return COMMIT_SHA_RE.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

// rawBase() (the raw.githubusercontent.com URL builder) and the validation for
// everything untrusted that reaches it live in ./registry-validate.mjs so they can
// be unit-tested — importing this file runs the whole build.

/**
 * Resolve one declared ref and fetch the two files the catalog needs from it.
 *
 * Returns null — rather than failing the build — when the ref is definitively
 * absent (HTTP 404) and `allowMissing` is set. That is how the dev channel copes
 * with an app that hasn't cut its `dev` branch yet: it falls back to the stable
 * release instead of taking the whole dev catalog down with it.
 *
 * `mutableIsExpected` suppresses the "pin a commit SHA" warning: on the dev
 * channel a moving branch is the entire point, so warning about it every build
 * would be noise. The ref is still resolved to the SHA it currently points at, so
 * the catalog references immutable content for that build either way.
 */
async function loadFrom(id, repo, path, declared, { allowMissing = false, mutableIsExpected = false, manifestOnly = false } = {}) {
  let fetchRef = String(declared);
  let immutable = COMMIT_SHA_RE.test(fetchRef);

  if (!immutable) {
    const current = await resolveRefToSha(repo, fetchRef);
    if (current) {
      if (mutableIsExpected) {
        notice(`${id}: dev ref "${fetchRef}" is at ${current} for this build.`);
      } else {
        warn(`${id}: pinned to mutable ref "${fetchRef}" — resolved to ${current} for this build. Add "commit: ${current}" to registry.yaml to pin it permanently (a tag/branch can be moved to backdoored content under a previously-reviewed ref).`);
      }
      fetchRef = current;
      immutable = true;
    } else if (!mutableIsExpected) {
      warn(`${id}: pinned to mutable ref "${fetchRef}" and could not resolve it to a commit SHA (offline/rate-limited); catalog.json will reference the mutable ref. Pin a "commit:" SHA in registry.yaml.`);
    }
  }

  const base = rawBase(repo, fetchRef, path);
  let manifestText, composeText;
  try {
    manifestText = await fetchText(base + 'manifest.yaml');
  } catch (e) {
    if (allowMissing && e.status === 404) return null;
    fail(`${id}: could not fetch manifest.yaml from ${repo}@${fetchRef} (${e.message})`);
  }
  // A version peek (manifestOnly) skips the compose fetch — it exists only to
  // answer "is the dev branch behind the stable release?" before deciding which
  // source to actually publish, so paying for the compose would be waste.
  if (!manifestOnly) {
    try {
      composeText = await fetchText(base + 'docker-compose.yml');
    } catch (e) {
      if (allowMissing && e.status === 404) return null;
      fail(`${id}: could not fetch docker-compose.yml from ${repo}@${fetchRef} (${e.message})`);
    }
  }
  return { declared: String(declared), fetchRef, immutable, base, manifestText, composeText };
}

/**
 * Split an image reference into the pieces a registry API needs.
 *   ghcr.io/o/r:1.0.0        → { host: 'ghcr.io', name: 'o/r', reference: '1.0.0' }
 *   postgres:16-alpine       → { host: 'registry-1.docker.io', name: 'library/postgres', … }
 *   ghcr.io/o/r@sha256:…     → reference is the digest
 */
function parseImageRef(ref) {
  const [beforeDigest, digest] = String(ref).split('@');
  const parts = beforeDigest.split('/');
  let host = 'registry-1.docker.io';
  if (parts.length > 1 && (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost')) {
    host = parts.shift();
  }
  let name = parts.join('/');
  let reference = 'latest';
  const colon = name.lastIndexOf(':');
  if (colon !== -1 && !name.slice(colon + 1).includes('/')) {
    reference = name.slice(colon + 1);
    name = name.slice(0, colon);
  }
  if (host === 'registry-1.docker.io' && !name.includes('/')) name = `library/${name}`;
  if (digest) reference = `sha256:${digest.replace(/^sha256:/, '')}`;
  return { host, name, reference };
}

/**
 * Does this image actually exist in its registry?
 *
 * Returns true / false / null, where **null means "could not tell"** — a timeout,
 * a rate limit, a registry that needs credentials. Only a definitive 404 counts as
 * false, so a flaky network can never demote an app.
 *
 * This exists because the dev channel now pins an EXACT tag. An app that bumps its
 * manifest before its CI publishes the matching image would otherwise have that
 * missing tag published to the catalog, and a masjid on the dev channel would get a
 * pull failure at install. Caught live on 2026-08-05: kiosk's dev entry pinned
 * 0.11.0-dev.1 minutes before that image existed.
 */
async function imageExists(ref) {
  const { host, name, reference } = parseImageRef(ref);
  const url = `https://${host}/v2/${name}/manifests/${encodeURIComponent(reference)}`;
  const accept = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.docker.distribution.manifest.v2+json',
  ].join(', ');
  try {
    let res = await fetch(url, { method: 'HEAD', headers: { Accept: accept }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 401) {
      // Standard OCI token flow: the challenge tells us where to get a token.
      const challenge = res.headers.get('www-authenticate') || '';
      const realm = /realm="([^"]+)"/.exec(challenge)?.[1];
      const service = /service="([^"]+)"/.exec(challenge)?.[1];
      if (!realm) return null;
      const tokenUrl = new URL(realm);
      if (service) tokenUrl.searchParams.set('service', service);
      tokenUrl.searchParams.set('scope', `repository:${name}:pull`);
      const tok = await fetch(tokenUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!tok.ok) return null;
      const token = (await tok.json()).token || (await Promise.resolve(null));
      if (!token) return null;
      res = await fetch(url, {
        method: 'HEAD',
        headers: { Accept: accept, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    }
    if (res.status === 404) return false;
    if (res.ok) return true;
    return null; // 429, 5xx, anything else — unknown, not absent
  } catch {
    return null;
  }
}

// The version a manifest declares, without validating the rest of it (that happens
// later, on whichever source we end up publishing). Returns null if unreadable.
function peekVersion(manifestText) {
  try {
    const m = parse(manifestText) ?? {};
    return m.version == null ? null : String(m.version);
  } catch {
    return null;
  }
}

let registry = { apps: [] };
if (existsSync(REGISTRY)) {
  try {
    registry = parse(readFileSync(REGISTRY, 'utf8')) ?? { apps: [] };
  } catch (e) {
    fail(`${REGISTRY} is not valid YAML — ${e.message}`);
  }
}
const entries = Array.isArray(registry.apps) ? registry.apps : [];

const apps = [];
const seen = new Set();
// What each app resolved to versus its stable release, so the freshness invariant
// can be asserted over the whole catalog once it is built (not just per entry).
const versionLedger = [];

for (const entry of entries) {
  // Two channel columns, one schema (CLAUDE.md "Channels"):
  //   stable  — `ref` (the published release TAG) + `commit`/`sha` (the immutable
  //             40-hex SHA that tag was cut at; it is what actually gets fetched).
  //   dev     — `dev_ref` (a branch, deliberately moving; may also be a SHA).
  const { id, repo, ref, path, commit, sha, dev_ref: devRef } = entry || {};
  if (!id || !repo) fail(`registry entry is missing "id" or "repo": ${JSON.stringify(entry)}`);
  if (!APP_ID_RE.test(id)) fail(`${id}: invalid id — use kebab-case (a-z, 0-9, -), max 80 chars`);
  // A command's namespace IS the app id, so an app called `os` would shadow `!os` in
  // the masjid's WhatsApp chat. OpenMasjidOS refuses these at install; refuse them
  // here so such an entry can never reach a masjid in the first place.
  if (isReservedAppId(id)) {
    fail(`${id}: this id names the platform, not an app — it would shadow "!${id}" in the WhatsApp admin commands. Reserved: ${[...RESERVED_APP_ID_WORDS].join(', ')}`);
  }
  if (seen.has(id)) fail(`duplicate id in registry: ${id}`);
  seen.add(id);

  // Validate everything that becomes part of a fetch URL BEFORE building one.
  // Without this, a `..` segment in `path` silently redirected the entry to a
  // different repository while `repo`/`commit`, the review diff and the build log
  // all still named the pinned one — defeating the only integrity control the
  // unattended hourly rebuild has. See registry-validate.mjs. (APPS-001)
  const sourceProblems = validateSource({ repo, ref, path, dev_ref: devRef });
  if (sourceProblems.length) {
    fail(`${id}: unsafe registry entry:\n   - ${sourceProblems.join('\n   - ')}`);
  }

  const pin = commit ?? sha;
  if (pin != null && !COMMIT_SHA_RE.test(String(pin))) {
    fail(`${id}: "commit"/"sha" must be a full 40-char lowercase hex commit SHA (got "${pin}")`);
  }

  // The stable column is validated on BOTH branches — registry.yaml is one file
  // with one schema, so a bad release pin is caught by whichever channel builds
  // first. `ref` must be a release tag (or a SHA): a branch name here would make
  // main's catalog silently follow a moving branch, which is what `dev_ref` is for.
  if (ref == null && pin == null) {
    fail(`${id}: needs a "ref" (the published release tag) or an immutable "commit" SHA`);
  }
  if (ref != null && !isStableRef(String(ref))) {
    fail(
      `${id}: "ref" is the STABLE channel and must be a published release tag (e.g. v1.2.3) or a ` +
        `40-char commit SHA — got "${ref}". To track a branch, put it in "dev_ref" (dev channel only).`,
    );
  }

  // Pick this channel's address. On dev, `dev_ref` wins over the stable pin —
  // otherwise the dev channel would just republish stable.
  const stableDeclared = pin != null ? String(pin) : String(ref);
  let src = null;
  let stableVersion = null;
  if (isDevChannel && devRef) {
    src = await loadFrom(id, repo, path, String(devRef), { allowMissing: true, mutableIsExpected: true });
    if (!src) {
      // The dev branch isn't there (yet). Fall back rather than take the whole dev
      // catalog down for one app — but say so loudly, because this app is NOT
      // shipping dev content and someone expected it to.
      warn(
        `${id}: dev_ref "${devRef}" does not exist in ${repo} (HTTP 404) — the dev catalog is falling ` +
          `back to the stable release "${stableDeclared}". Create that branch in the app repo, or drop dev_ref.`,
      );
    } else {
      // THE FRESHNESS FLOOR. The dev channel must never offer a version older than
      // stable — to a masjid that reads as an app DOWNGRADE. An app's dev branch can
      // legitimately fall behind its own release (a hotfix cut on main and not merged
      // down), so peek at the stable version and prefer whichever is newer. Equal is
      // fine and is the normal case: a moving `:dev` tag ships new content under an
      // unchanged version string.
      const stablePeek = await loadFrom(id, repo, path, stableDeclared, {
        allowMissing: true,
        mutableIsExpected: true, // the real load below warns; don't warn twice
        manifestOnly: true,
      });
      stableVersion = stablePeek ? peekVersion(stablePeek.manifestText) : null;
      const devVersion = peekVersion(src.manifestText);
      if (!devVersionIsAcceptable(devVersion, stableVersion)) {
        warn(
          `${id}: dev branch "${devRef}" declares version ${JSON.stringify(devVersion)} but the stable ` +
            `release is ${JSON.stringify(stableVersion)} — publishing it would offer a DOWNGRADE on the dev ` +
            `channel, so the dev catalog is serving the stable release instead. Merge the release into ` +
            `${repo}@${devRef} (or bump its manifest version) and the dev channel will pick it up.`,
        );
        src = null; // fall through to the stable load below
      } else {
        // THE DEV ENTRY CONTRACT. A dev entry needs a version axis the platform can
        // compare and an image reference it can actually pin — a repeated version
        // string plus a moving `:dev` tag means a new dev build changes nothing in
        // the catalog, so the platform stays silent and the update button has no
        // target. See devEntryProblems() in channels.mjs.
        //
        // MIGRATION (agreed 2026-08-05, "option b"): a non-compliant entry falls back
        // to the app's stable release with this warning, rather than failing the
        // build. That keeps the dev channel valid and lets apps migrate one at a time
        // instead of all at once. **Flip this to fail() once every listed app
        // publishes prerelease-versioned dev images** — the fallback is a migration
        // aid, not the destination.
        const problems = devEntryProblems({ version: devVersion, composeText: src.composeText });
        // Pinning an exact tag is only an improvement if the tag is there. An app that
        // bumps its manifest before CI publishes the image would otherwise ship a
        // catalog entry a masjid cannot install. Only a definitive 404 demotes it.
        if (!problems.length) {
          for (const imageRef of imageRefsIn(src.composeText)) {
            if (imageRef.includes('${')) continue;
            if ((await imageExists(imageRef)) === false) {
              problems.push(
                `image "${imageRef}" does not exist in its registry yet — publish the image before the ` +
                  `entry, or a masjid on the dev channel gets a pull failure at install`,
              );
            }
          }
        }
        if (problems.length) {
          warn(
            `${id}: dev entry does not meet the dev channel contract, so the dev catalog is serving the ` +
              `stable release ${JSON.stringify(stableVersion)} instead:\n     - ${problems.join('\n     - ')}\n` +
              `     Fix in ${repo}@${devRef}: publish the dev image under its exact manifest version ` +
              `(e.g. "<image>:X.Y.Z-dev.N") and reference that tag — not ":dev" — for every service. ` +
              `See docs/BUILDING_AN_APP.md §8b.`,
          );
          src = null; // fall through to the stable load below
        }
      }
    }
  }
  let usedFallback = false;
  if (!src) {
    if (isDevChannel) {
      usedFallback = true;
      if (!devRef) notice(`${id}: no dev_ref — the dev catalog lists the stable release "${stableDeclared}".`);
    }
    src = await loadFrom(id, repo, path, stableDeclared);
  }
  const { fetchRef, immutable, base, manifestText, composeText } = src;

  // Parsed here rather than after the leakage gate, because the gate has to judge the
  // entry's VERSION too — a prerelease is dev content whatever ref carried it. (APPS-024)
  let m;
  try {
    m = parse(manifestText) ?? {};
  } catch (e) {
    fail(`${id}: manifest.yaml is not valid YAML — ${e.message}`);
  }


  // THE LEAKAGE GATE. main/catalog.json is production: the platform fetches that
  // raw file with no deploy step in between, so a dev ref or a dev-tagged image
  // that lands here is immediately live to every masjid on the stable channel.
  // Fail the build rather than publish it.
  if (!isDevChannel) {
    const devArtifacts = findDevArtifacts({ ref: src.declared, version: m.version, composeText });
    if (devArtifacts.length) {
      fail(
        `${id}: development content cannot be published on the stable channel:\n   - ` +
          devArtifacts.join('\n   - ') +
          `\n   The stable catalog is built from "ref"/"commit" and release-tagged images only; dev ` +
          `content belongs on the dev branch (CLAUDE.md "Channels").`,
      );
    }
  } else if (devRef && !usedFallback && !imageRefsIn(composeText).some(isDevImageRef)) {
    // Declared a dev branch but it still points at a release image — usually the
    // dev branch's compose was never switched to the :dev tag.
    notice(`${id}: dev_ref "${devRef}" resolved, but its compose references no dev-tagged image — the dev channel will install the release image.`);
  }

  if (m.id !== id) fail(`${id}: manifest id "${m.id}" must equal the registry id "${id}"`);

  // Type/length/shape validation for every field copied into the catalog entry.
  // These come from an untrusted remote manifest and were passed through
  // unchecked: `name` was only tested for truthiness, then sorted on with
  // localeCompare (a numeric name crashed the build), and wrong types silently
  // violated the platform contract in CLAUDE.md §2.3. Caps are far above the
  // largest live value, so nothing currently listed is affected. (APPS-014)
  const manifestProblems = validateManifestFields(m);
  if (manifestProblems.length) {
    fail(`${id}: manifest.yaml is not valid:\n   - ${manifestProblems.join('\n   - ')}`);
  }

  if (m.category && !CATEGORIES.has(m.category)) {
    fail(`${id}: unknown category "${m.category}" (use: ${[...CATEGORIES].join(', ')})`);
  }
  // Fabric app-to-app broker grants + tunnel-exposure request (validated here so a
  // malformed shape fails the build rather than silently dropping).
  const fabric = parseFabricManifest(id, m.fabric);
  // Every boolean capability is type-checked from ONE list (scripts/capabilities.mjs),
  // so a new one cannot be validated here but forgotten in the entry below — which is
  // exactly how `whatsapp` went missing and cost apps a 403 they could not diagnose.
  for (const problem of capabilityProblems(m)) fail(`${id}: ${problem}`);
  const alerts = parseAlertsManifest(id, m.alerts);
  const commands = parseCommandsManifest(id, m.commands);

  // The compose text is embedded verbatim into catalog.json, which every masjid
  // fetches. A real one is well under 10 KB; anything near the fetch ceiling is a
  // mistake or an attempt to bloat the catalog. (APPS-007)
  const MAX_COMPOSE_BYTES = 64 * 1024;
  if (Buffer.byteLength(composeText, 'utf8') > MAX_COMPOSE_BYTES) {
    fail(
      `${id}: docker-compose.yml is ${Buffer.byteLength(composeText, 'utf8')} bytes, over the ` +
        `${MAX_COMPOSE_BYTES}-byte limit — it is embedded in catalog.json for every install`,
    );
  }
  const composeCheck = validateCompose(composeText);
  if (composeCheck.errors.length) {
    fail(`${id}: docker-compose.yml has disallowed settings:\n   - ${composeCheck.errors.join('\n   - ')}\n   See docs/BUILDING_AN_APP.md §2b (Security requirements).`);
  }
  for (const w of composeCheck.warnings) warn(`${id}: compose: ${w}`);

  // FIX B — warn on any image: that isn't digest-pinned (@sha256:<hex>). A pinned
  // tag is not enough: a tag can be moved to repoint at a different, backdoored
  // image. Warn only (don't break apps already shipping on tag pins).
  for (const imageRef of imageRefsIn(composeText)) {
    if (imageRef.includes('${')) continue; // env-substituted at install — can't judge here
    if (IMAGE_DIGEST_RE.test(imageRef)) continue;
    if (isDevChannel && isDevImageRef(imageRef)) {
      // A dev tag is a moving tag by definition — that is what the dev channel is.
      // Warning on it every build would bury the warnings that do matter. It stays
      // a hard failure on the stable channel (the leakage gate above).
      notice(`${id}: image "${imageRef}" tracks a moving dev tag — expected on the dev channel.`);
      continue;
    }
    warn(`${id}: image "${imageRef}" is not digest-pinned — a moved tag could repoint it to a backdoored image. Pin it as "<image>:<tag>@sha256:<digest>" (see docs/BUILDING_AN_APP.md → Security requirements).`);
  }

  apps.push({
    id,
    name: m.name,
    tagline: m.tagline,
    category: m.category,
    version: String(m.version),
    author: m.author,
    license: m.license,
    icon: m.icon ? base + String(m.icon).replace(/^\/+/, '') : undefined,
    screenshots: Array.isArray(m.screenshots)
      ? m.screenshots.map((s) => base + String(s).replace(/^\/+/, ''))
      : undefined,
    description: m.description,
    settings: m.settings,
    ports: m.ports,
    // Opt-in OpenMasjidOS Fabric capabilities, copied from the SINGLE list in
    // scripts/capabilities.mjs so the set the build validates and the set it emits
    // cannot drift apart. Each one carried through here is what makes the platform
    // issue the app a per-app secret at install and honour the matching calls; a key
    // that never reaches catalog.json reads on the platform as "the app never asked",
    // which is a 403 the app author cannot debug from their own repo.
    // Only `true` survives — an absent key means "did not ask".
    ...capabilityFields(m),
    // App-to-app broker grants (provides/consumes) — the platform issues the
    // per-app secret and brokers POST /api/fabric/app/<target>/<cap>/<method>.
    // Not a boolean, so it is parsed and carried separately.
    fabric,
    // Alert types this app can raise (POST /api/fabric/alert); the admin gets a
    // granular on/off per alert in Settings → Alerts. Also not a boolean.
    alerts,
    // Admin commands a masjid admin runs by messaging the masjid's WhatsApp number.
    // Declaring these alone issues the app its Fabric secret — no other capability
    // needed, exactly as `alerts:` already does.
    commands,
    compose: composeText,
  });
  // On a fallback the published version IS the stable one, so the floor holds by
  // construction. Record both so the invariant can be asserted over the finished
  // catalog rather than trusted per entry.
  versionLedger.push({
    id,
    published: String(m.version),
    stable: usedFallback ? String(m.version) : stableVersion,
  });

  const via = isDevChannel ? (usedFallback ? ' [stable fallback]' : ' [dev]') : '';
  console.log(`✓ ${id} ← ${repo}@${fetchRef}${immutable ? '' : ' (mutable ref)'}${via}`);
}

// THE FRESHNESS ASSERTION. The floor above should make this unreachable — it is
// here because "the dev channel is never behind stable" is the invariant a masjid
// actually feels (switching to Development must never offer a downgrade), and an
// invariant that matters should be checked, not assumed. If this fires, the floor
// has a bug: fail rather than publish a catalog that downgrades apps.
//
// This is the mirror of the stable channel's gate. main refuses to publish dev
// content; dev refuses to publish anything older than main.
if (isDevChannel) {
  const behind = [];
  for (const v of versionLedger) {
    if (v.stable == null) continue; // no stable release to be behind
    const cmp = compareVersions(v.published, v.stable);
    if (cmp === null) {
      warn(
        `${v.id}: cannot compare dev version ${JSON.stringify(v.published)} with stable ` +
          `${JSON.stringify(v.stable)} — neither is semver, so freshness could not be verified`,
      );
    } else if (cmp < 0) {
      behind.push(`${v.id}: dev would publish ${v.published}, older than the stable release ${v.stable}`);
    }
  }
  if (behind.length) {
    fail(
      `the dev channel must never be behind stable — a masjid switching to Development would be ` +
        `offered a DOWNGRADE:\n   - ${behind.join('\n   - ')}\n   This should have been prevented by the ` +
        `freshness floor in this script; treat it as a bug in the floor, not a reason to relax the check.`,
    );
  }
  console.log(`✓ freshness: all ${versionLedger.length} entry(ies) are at or ahead of their stable release.`);
}

// Coming-soon teasers — metadata only, no repo/compose. The platform renders
// these with a "Coming soon" badge and refuses to install them.
const comingSoon = Array.isArray(registry.coming_soon) ? registry.coming_soon : [];
for (const entry of comingSoon) {
  const { id, name, tagline, category, description, icon, https } = entry || {};
  if (!id || !name) fail(`coming_soon entry is missing "id" or "name": ${JSON.stringify(entry)}`);
  if (!APP_ID_RE.test(id)) fail(`${id}: invalid coming_soon id — use kebab-case (a-z, 0-9, -), max 80 chars`);
  if (seen.has(id)) fail(`duplicate id (coming_soon vs apps): ${id}`);
  seen.add(id);
  if (category && !CATEGORIES.has(category)) {
    fail(`${id}: unknown category "${category}" (use: ${[...CATEGORIES].join(', ')})`);
  }
  apps.push({ id, name, tagline, category, description, icon, https: https === true ? true : undefined, comingSoon: true });
  console.log(`✓ ${id} (coming soon)`);
}

apps.sort((a, b) => a.name.localeCompare(b.name));
// Drop undefined keys for a tidy catalog.
const clean = apps.map((a) => JSON.parse(JSON.stringify(a)));
// THE STABLE REGRESSION GATE. Before writing anything, check this catalog against
// the one masjids are actually running. Publishing a lower version than they have
// installed is an app DOWNGRADE, live instantly and with no deploy step to catch it.
//
// Checked only on the stable channel: the dev channel legitimately moves backwards
// when an entry falls back to its stable release (a missing image, a dev branch
// behind its own release), and the freshness floor already bounds it from below.
//
// A deliberate rollback is a real operation — `display: roll the catalog back to
// v0.61.0` has happened — so this is overridable with OPENMASJID_ALLOW_DOWNGRADE=1.
// It must be stated, not stumbled into.
if (!isDevChannel) {
  let published = null;
  try {
    published = JSON.parse(await fetchText(PUBLISHED_MAIN_CATALOG_URL));
  } catch (e) {
    // Unreachable/rate-limited/malformed — say so and continue. Refusing to publish
    // because GitHub was briefly unavailable would be a worse failure than the one
    // this guards against.
    warn(`could not read the published stable catalog to check for downgrades (${e.message}) — regression check skipped`);
  }
  if (published) {
    const regressions = findVersionRegressions(clean, published.apps);
    if (regressions.length) {
      const lines = regressions.map((r) => `${r.id}: ${r.from} → ${r.to}`);
      if (process.env.OPENMASJID_ALLOW_DOWNGRADE === '1') {
        warn(
          `publishing ${regressions.length} DOWNGRADE(s) because OPENMASJID_ALLOW_DOWNGRADE=1:\n   - ` +
            lines.join('\n   - '),
        );
      } else {
        fail(
          `this build would move ${regressions.length} app(s) BACKWARDS for every masjid on the stable ` +
            `channel:\n   - ${lines.join('\n   - ')}\n   Usually this means registry.yaml is stale on the ` +
            `branch being released — check whether those apps were bumped directly on main, and merge main ` +
            `into dev before releasing. If the rollback is deliberate, set OPENMASJID_ALLOW_DOWNGRADE=1.`,
        );
      }
    } else {
      console.log(`✓ no downgrades: every app is at or ahead of what the stable channel publishes today.`);
    }
  }
}

// Single-channel per branch, and the envelope shape is untouched: no channel key is
// added here. catalog.json is the platform's contract (CLAUDE.md §2) and the branch
// it is fetched from is what identifies the channel.
writeFileSync('catalog.json', JSON.stringify({ apps: clean }, null, 2) + '\n');
console.log(`✓ Built catalog.json with ${clean.length} app(s) for the ${channel} channel.`);
if (warnings > 0) {
  // Surface, but don't fail — these are supply-chain hardening nudges, not errors.
  console.warn(`⚠ ${warnings} security warning(s) above. Immutable commit-SHA pins (registry.yaml) and digest-pinned images are the integrity controls for the unattended hourly rebuild.`);
}
