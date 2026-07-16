// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Hasan Ismail
/**
 * Builds catalog.json by aggregating the app repositories listed in registry.yaml.
 *
 * Each app lives in its OWN repository. For every registry entry this script:
 *   1. fetches that repo's manifest.yaml and docker-compose.yml (at the pinned ref),
 *   2. validates the id / required fields / category and scans the compose for
 *      disallowed (dangerous) directives,
 *   3. rewrites icon/screenshots to absolute raw URLs in that repo,
 *   4. embeds the compose text as the entry's `compose` string,
 * then writes { apps: [...] } to catalog.json at the repo root — the exact file
 * and shape OpenMasjidOS fetches. The platform contract is unchanged; only the
 * SOURCE of each entry moved from local folders to external repos. See CLAUDE.md.
 *
 * Run: npm install && node scripts/build-catalog.mjs   (needs network access)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parse } from 'yaml';
import { validateCompose } from './validate-compose.mjs';

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
// the unattended daily rebuild (see .github/workflows/build-catalog.yml) will
// republish it under a previously-reviewed ref. A SHA cannot be moved.
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

// A digest-pinned image reference contains @sha256:<64 hex>. Without it, a moved
// image tag can repoint a "pinned" version string to a different (backdoored)
// image — pinning the tag is NOT enough; pin the digest.
const IMAGE_LINE_RE = /^\s*image:\s*["']?([^"'\s#]+)/gm;
const IMAGE_DIGEST_RE = /@sha256:[0-9a-f]{64}/;

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

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Best-effort: resolve a mutable tag/branch to the commit SHA it currently points
// at, so a maintainer can copy that SHA into registry.yaml for an immutable pin.
// Uses the public GitHub commits API; returns null if unreachable/rate-limited —
// never hard-fails (the build must work offline-ish and without a token).
async function resolveRefToSha(repo, ref) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`, {
      headers: { Accept: 'application/vnd.github.sha' },
    });
    if (!res.ok) return null;
    const sha = (await res.text()).trim();
    return COMMIT_SHA_RE.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

// raw.githubusercontent.com base for a repo/ref (+ optional subpath), trailing slash.
function rawBase(repo, ref, path) {
  const sub = path ? `${String(path).replace(/^\/+|\/+$/g, '')}/` : '';
  return `https://raw.githubusercontent.com/${repo}/${ref}/${sub}`;
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

for (const entry of entries) {
  // `commit`/`sha` (an immutable 40-hex SHA) takes precedence over `ref` (a
  // mutable tag/branch). `ref` may itself be a 40-hex SHA — also immutable.
  const { id, repo, ref = 'main', path, commit, sha } = entry || {};
  if (!id || !repo) fail(`registry entry is missing "id" or "repo": ${JSON.stringify(entry)}`);
  if (!APP_ID_RE.test(id)) fail(`${id}: invalid id — use kebab-case (a-z, 0-9, -), max 80 chars`);
  if (seen.has(id)) fail(`duplicate id in registry: ${id}`);
  seen.add(id);

  // Decide what to fetch at. An explicit commit/sha pin wins; otherwise the ref.
  const pin = commit ?? sha;
  if (pin != null && !COMMIT_SHA_RE.test(String(pin))) {
    fail(`${id}: "commit"/"sha" must be a full 40-char lowercase hex commit SHA (got "${pin}")`);
  }
  let fetchRef = pin != null ? String(pin) : String(ref);
  let immutable = COMMIT_SHA_RE.test(fetchRef);

  if (!immutable) {
    // Mutable pin: resolve it to the commit SHA it currently points at and fetch
    // THAT, so catalog.json always references an immutable source that can't change
    // under a moving branch/tag. Still warn so a permanent `commit:` pin is added.
    const current = await resolveRefToSha(repo, fetchRef);
    if (current) {
      warn(`${id}: pinned to mutable ref "${fetchRef}" — resolved to ${current} for this build. Add "commit: ${current}" to registry.yaml to pin it permanently (a tag/branch can be moved to backdoored content under a previously-reviewed ref).`);
      fetchRef = current;
      immutable = true;
    } else {
      warn(`${id}: pinned to mutable ref "${fetchRef}" and could not resolve it to a commit SHA (offline/rate-limited); catalog.json will reference the mutable ref. Pin a "commit:" SHA in registry.yaml.`);
    }
  }

  const base = rawBase(repo, fetchRef, path);

  let manifestText, composeText;
  try {
    manifestText = await fetchText(base + 'manifest.yaml');
  } catch (e) {
    fail(`${id}: could not fetch manifest.yaml from ${repo}@${fetchRef} (${e.message})`);
  }
  try {
    composeText = await fetchText(base + 'docker-compose.yml');
  } catch (e) {
    fail(`${id}: could not fetch docker-compose.yml from ${repo}@${fetchRef} (${e.message})`);
  }

  let m;
  try {
    m = parse(manifestText) ?? {};
  } catch (e) {
    fail(`${id}: manifest.yaml is not valid YAML — ${e.message}`);
  }

  if (m.id !== id) fail(`${id}: manifest id "${m.id}" must equal the registry id "${id}"`);
  if (!m.name) fail(`${id}: manifest "name" is required`);
  if (!m.version) fail(`${id}: manifest "version" is required`);
  if (m.category && !CATEGORIES.has(m.category)) {
    fail(`${id}: unknown category "${m.category}" (use: ${[...CATEGORIES].join(', ')})`);
  }
  // Fabric app-to-app broker grants + tunnel-exposure request (validated here so a
  // malformed shape fails the build rather than silently dropping).
  const fabric = parseFabricManifest(id, m.fabric);
  if (m.tunnel != null && typeof m.tunnel !== 'boolean') {
    fail(`${id}: manifest "tunnel" must be true or false`);
  }
  const composeCheck = validateCompose(composeText);
  if (composeCheck.errors.length) {
    fail(`${id}: docker-compose.yml has disallowed settings:\n   - ${composeCheck.errors.join('\n   - ')}\n   See docs/BUILDING_AN_APP.md §2b (Security requirements).`);
  }
  for (const w of composeCheck.warnings) warn(`${id}: compose: ${w}`);

  // FIX B — warn on any image: that isn't digest-pinned (@sha256:<hex>). A pinned
  // tag is not enough: a tag can be moved to repoint at a different, backdoored
  // image. Warn only (don't break apps already shipping on tag pins).
  IMAGE_LINE_RE.lastIndex = 0;
  for (let mm; (mm = IMAGE_LINE_RE.exec(composeText)); ) {
    const imageRef = mm[1];
    if (imageRef.includes('${')) continue; // env-substituted at install — can't judge here
    if (!IMAGE_DIGEST_RE.test(imageRef)) {
      warn(`${id}: image "${imageRef}" is not digest-pinned — a moved tag could repoint it to a backdoored image. Pin it as "<image>:<tag>@sha256:<digest>" (see docs/BUILDING_AN_APP.md → Security requirements).`);
    }
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
    // Opt-in OpenMasjidOS Fabric capabilities. Carried through so the platform
    // issues the app a per-app secret at install and honours the matching calls
    // (sso → /api/auth/session, notifications → /api/fabric/notify,
    //  stripe → /api/fabric/stripe).
    sso: m.sso === true ? true : undefined,
    notifications: m.notifications === true ? true : undefined,
    // Fetch shared Stripe keys from the OS vault (one account, many apps) instead
    // of each app storing its own. The platform issues the per-app secret + honours
    // GET /api/fabric/stripe?account=<name>.
    stripe: m.stripe === true ? true : undefined,
    // Learn this app's PUBLIC URL (the admin's Cloudflare-tunnel domain + path) via
    // GET /api/fabric/site — for absolute links (Stripe return URLs, webhooks, QR).
    domain: m.domain === true ? true : undefined,
    // Require HTTPS — set ONLY by apps that use Stripe (they need a secure
    // context). The platform serves such an app on a dedicated HTTPS port.
    https: m.https === true ? true : undefined,
    // App-to-app broker grants (provides/consumes) — the platform issues the
    // per-app secret and brokers POST /api/fabric/app/<target>/<cap>/<method>.
    fabric,
    // Request internet exposure through the OS's Cloudflare tunnel (the admin still
    // confirms per-app in Settings). Off ⇒ the app stays on the LAN.
    tunnel: m.tunnel === true ? true : undefined,
    compose: composeText,
  });
  console.log(`✓ ${id} ← ${repo}@${fetchRef}${immutable ? '' : ' (mutable ref)'}`);
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
writeFileSync('catalog.json', JSON.stringify({ apps: clean }, null, 2) + '\n');
console.log(`✓ Built catalog.json with ${clean.length} app(s).`);
if (warnings > 0) {
  // Surface, but don't fail — these are supply-chain hardening nudges, not errors.
  console.warn(`⚠ ${warnings} security warning(s) above. Immutable commit-SHA pins (registry.yaml) and digest-pinned images are the integrity controls for the unattended daily rebuild.`);
}
