// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * lint.mjs — dependency-free static checks for this repo.
 *
 * The catalog has one runtime dependency on purpose (CLAUDE.md §12), so rather
 * than pull in a linter this uses what Node already ships:
 *   1. `node --check` parses every .mjs/.js file (syntax + early errors).
 *   2. Every source file must carry the SPDX header CLAUDE.md §10 mandates.
 *   3. registry.yaml and catalog.json must parse, and catalog.json must still
 *      match the platform contract in CLAUDE.md §2 — the shape the platform
 *      reads is the one thing we must never break.
 *   4. Channel hygiene (CLAUDE.md "Channels"): every stable `ref` is a release
 *      tag, and the COMMITTED catalog.json on the stable channel carries no dev
 *      refs or dev-tagged images.
 *
 * (4) is the gate that matters at merge time. The build enforces the same rule,
 * but the build needs network and only runs after a push; this runs on the pull
 * request. A dev → main release PR whose catalog.json still holds dev content is
 * therefore red before it can be merged — which is the whole defence, because
 * main/catalog.json is fetched by every masjid with no deploy step in between.
 *
 * Run: npm run lint [-- --channel main|dev]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, extname, relative } from 'node:path';
import { parse } from 'yaml';
import { resolveChannel, isStableRef, isDevImageRef, imageTagOf, imageRefsIn, isDevVersion } from './channels.mjs';
import { validateSource } from './registry-validate.mjs';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', '.github']);
const problems = [];
const fail = (f, msg) => problems.push(`${f}: ${msg}`);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(ROOT);

// 1 + 2 — parse and header-check every JS/MJS file.
const SPDX = 'SPDX-License-Identifier: AGPL-3.0-only';
let checked = 0;
for (const f of files) {
  const rel = relative(ROOT, f).replace(/\\/g, '/');
  if (!['.mjs', '.js'].includes(extname(f))) continue;
  checked++;
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    fail(rel, `does not parse — ${String(e.stderr || e.message).split('\n').slice(0, 3).join(' ')}`);
  }
  if (!readFileSync(f, 'utf8').includes(SPDX)) fail(rel, `missing "${SPDX}" header (CLAUDE.md §10)`);
}

// The SPDX rule applies to the other source formats too.
for (const f of files) {
  const rel = relative(ROOT, f).replace(/\\/g, '/');
  if (!['.yml', '.yaml', '.sh'].includes(extname(f))) continue;
  if (rel.startsWith('docs/')) continue;
  checked++;
  if (!readFileSync(f, 'utf8').includes(SPDX)) fail(rel, `missing "${SPDX}" header (CLAUDE.md §10)`);
}

// Which channel is this tree meant to publish? CI states it explicitly (the pushed
// branch, or a PR's base branch); locally it comes from the git branch.
function currentGitBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}
let channel = 'main';
let channelSource = 'default';
let branch = null;
try {
  branch = currentGitBranch();
  ({ channel, source: channelSource } = resolveChannel({ argv: process.argv.slice(2), env: process.env, branch }));
} catch (e) {
  console.error(`✗ lint: ${e.message}`);
  process.exit(1);
}

// Enforce "no dev content" only when we actually know this tree publishes stable:
// the channel was stated outright, or we are literally on `main`. A working branch
// off `dev` legitimately carries a dev catalog.json, and CI passes the base branch
// explicitly — which is where the guard has to hold.
const enforceStable = channel === 'main' && (channelSource === 'flag' || channelSource === 'env' || branch === 'main');

// 3 — registry.yaml parses, and its channel columns are well-formed. This is the
// offline half of the build's validation, so a bad ref is caught on the PR rather
// than after the merge.
try {
  const reg = parse(readFileSync(join(ROOT, 'registry.yaml'), 'utf8')) ?? {};
  if (!Array.isArray(reg.apps)) {
    fail('registry.yaml', '"apps" must be a list');
  } else {
    for (const e of reg.apps) {
      const at = `registry.yaml[${e && e.id}]`;
      if (!e || typeof e !== 'object') { fail(at, 'entry is not an object'); continue; }
      for (const p of validateSource({ repo: e.repo, ref: e.ref, path: e.path, dev_ref: e.dev_ref })) fail(at, p);
      if (e.ref == null && e.commit == null && e.sha == null) {
        fail(at, 'needs a "ref" (the published release tag) or an immutable "commit" SHA');
      }
      if (e.ref != null && !isStableRef(String(e.ref))) {
        fail(at, `"ref" must be a release tag (e.g. v1.2.3) or a 40-char commit SHA, not "${e.ref}" — a branch belongs in "dev_ref"`);
      }
    }
  }
} catch (e) {
  fail('registry.yaml', `is not valid YAML — ${e.message}`);
}

// 3 — catalog.json still matches the platform contract (CLAUDE.md §2.2/§2.3).
const APP_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const CATEGORIES = new Set(['displays', 'donations', 'community', 'quran', 'admin', 'utilities']);
try {
  const cat = JSON.parse(readFileSync(join(ROOT, 'catalog.json'), 'utf8'));
  if (!cat || !Array.isArray(cat.apps)) {
    fail('catalog.json', 'must be an envelope { "apps": [ … ] } (CLAUDE.md §2.2)');
  } else {
    for (const a of cat.apps) {
      const at = `catalog.json[${a && a.id}]`;
      if (!a || typeof a !== 'object') { fail(at, 'entry is not an object'); continue; }
      if (typeof a.id !== 'string' || !APP_ID_RE.test(a.id)) fail(at, 'invalid id — the platform drops it');
      if (typeof a.name !== 'string' || !a.name) fail(at, '"name" must be a non-empty string');
      if (a.category != null && !CATEGORIES.has(a.category)) fail(at, `unknown category "${a.category}"`);
      if (a.comingSoon === true) continue; // teasers carry no version/compose by design
      if (typeof a.version !== 'string' || !a.version) fail(at, '"version" must be a non-empty string');
      if (typeof a.compose !== 'string' || !a.compose.trim()) fail(at, '"compose" must be the compose text');
      for (const k of ['icon']) {
        if (a[k] != null && !/^https:\/\//.test(a[k])) fail(at, `"${k}" must be an absolute https URL`);
      }
      for (const s of Array.isArray(a.screenshots) ? a.screenshots : []) {
        if (!/^https:\/\//.test(s)) fail(at, 'every screenshot must be an absolute https URL');
      }
      // 4 — the leakage gate. On the stable channel a dev-tagged image here would
      // be installed by every masjid the moment this file lands on main.
      // An entry's own VERSION is the authoritative marker of dev content, and it is
      // the one an image check cannot see: a digest-pinned dev entry has no tag to
      // inspect, so the image loop below finds nothing while the entry still announces
      // a prerelease to every masjid on the stable channel. (2026-08-18 audit)
      if (enforceStable && isDevVersion(a.version)) {
        fail(at, `version "${a.version}" is a prerelease — development versions must never ship on the stable channel. Rebuild with "npm run build -- --channel main".`);
      }
      if (enforceStable && typeof a.compose === 'string') {
        for (const img of imageRefsIn(a.compose)) {
          if (img.includes('${')) continue;
          if (isDevImageRef(img)) {
            fail(at, `compose references "${img}" — tag "${imageTagOf(img)}" is a development tag and must never ship on the stable channel. Rebuild with "npm run build -- --channel main".`);
          }
        }
      }
    }
  }
} catch (e) {
  fail('catalog.json', `is not valid JSON — ${e.message}`);
}

if (problems.length) {
  console.error(`✗ lint: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`   - ${p}`);
  process.exit(1);
}
const channelNote = enforceStable
  ? 'no dev refs or dev-tagged images'
  : `dev content allowed (channel ${channel}, from ${channelSource})`;
console.log(`✓ lint: ${checked} file(s) checked, catalog.json matches the platform contract — ${channelNote}.`);
