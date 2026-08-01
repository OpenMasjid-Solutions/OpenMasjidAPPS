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
 *
 * Run: npm run lint
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, extname, relative } from 'node:path';
import { parse } from 'yaml';

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

// 3 — registry.yaml parses.
try {
  const reg = parse(readFileSync(join(ROOT, 'registry.yaml'), 'utf8')) ?? {};
  if (!Array.isArray(reg.apps)) fail('registry.yaml', '"apps" must be a list');
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
console.log(`✓ lint: ${checked} file(s) checked, catalog.json matches the platform contract.`);
