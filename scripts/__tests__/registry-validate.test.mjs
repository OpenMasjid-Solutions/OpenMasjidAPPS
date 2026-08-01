// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Tests for scripts/registry-validate.mjs.
 *
 * The headline case is APPS-001: a `..` segment in a registry entry's `path`
 * redirected a commit-SHA-pinned entry at a completely different repository,
 * while the entry, the review diff and the build log all still named the pinned
 * one. `rawBase` must refuse to build such a URL.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSource, rawBase, validateAssetPath } from '../registry-validate.mjs';

const SHA = 'a32816bf5e3e3576b4a0bcfb400713b12383e98f';
const ok = (src) => assert.deepEqual(validateSource(src), [], `expected ${JSON.stringify(src)} to be accepted`);
const bad = (src, needle) => {
  const problems = validateSource(src);
  assert.ok(problems.length > 0, `expected ${JSON.stringify(src)} to be rejected`);
  if (needle) {
    assert.ok(
      problems.some((p) => p.includes(needle)),
      `expected a problem mentioning ${JSON.stringify(needle)}, got ${JSON.stringify(problems)}`,
    );
  }
};

// --- APPS-001: the regression that motivated this module -------------------
test('APPS-001 a ".." segment in path is rejected', () => {
  bad({ repo: 'OpenMasjid-Solutions/OpenMasjidDisplay', ref: SHA, path: '../../../../attacker/evil/main' }, '..');
});

test('APPS-001 rawBase refuses to build a traversing URL at all', () => {
  assert.throws(
    () => rawBase('OpenMasjid-Solutions/OpenMasjidDisplay', SHA, '../../../../attacker/evil/main'),
    /unsafe catalog source/,
  );
});

test('APPS-001 the pre-fix URL really did escape the pinned repo (documents the bug)', () => {
  // This is what the old, unvalidated builder produced. Kept as an executable
  // record of why the check exists: URL normalisation moves it to another repo.
  const naive = `https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidDisplay/${SHA}/../../../../attacker/evil/main/manifest.yaml`;
  assert.equal(new URL(naive).href, 'https://raw.githubusercontent.com/attacker/evil/main/manifest.yaml');
  // And the guarded builder never emits it.
  assert.throws(() => rawBase('OpenMasjid-Solutions/OpenMasjidDisplay', SHA, '../../../../attacker/evil/main'));
});

test('APPS-001 a nested ".." deeper in the path is rejected too', () => {
  bad({ repo: 'a/b', ref: 'main', path: 'sub/../../../evil' }, '..');
  bad({ repo: 'a/b', ref: 'main', path: 'a/b/..' }, '..');
});

// --- the legitimate shapes must keep working ------------------------------
test('the five live registry entries are all accepted', () => {
  for (const src of [
    { repo: 'OpenMasjid-Solutions/OpenMasjidDisplay', ref: 'v0.65.0', commit: SHA },
    { repo: 'OpenMasjid-Solutions/OpenMasjidDonations', ref: 'v0.37.0' },
    { repo: 'OpenMasjid-Solutions/OpenMasjidKiosk', ref: 'v0.9.36' },
    { repo: 'OpenMasjid-Solutions/OpenMasjidStudents', ref: 'v0.44.0' },
    { repo: 'SyButter/OpenMasjidParkingAttendant', ref: 'v0.2.1' },
  ]) {
    ok({ repo: src.repo, ref: src.ref, path: undefined });
  }
});

test('a plain subpath is accepted and lands inside the pinned repo', () => {
  ok({ repo: 'owner/repo', ref: 'main', path: 'apps/thing' });
  assert.equal(
    rawBase('owner/repo', SHA, 'apps/thing'),
    `https://raw.githubusercontent.com/owner/repo/${SHA}/apps/thing/`,
  );
});

test('an absent or empty path is accepted', () => {
  ok({ repo: 'owner/repo', ref: 'main' });
  ok({ repo: 'owner/repo', ref: 'main', path: '' });
  assert.equal(rawBase('owner/repo', 'main', ''), 'https://raw.githubusercontent.com/owner/repo/main/');
});

test('refs with dots, dashes and slashes are accepted', () => {
  for (const ref of ['v1.0.0', 'main', 'release/1.x', SHA, 'feature-a_b']) ok({ repo: 'o/r', ref });
});

// --- repo -----------------------------------------------------------------
test('repo must be exactly owner/repo', () => {
  bad({ repo: 'no-slash', ref: 'main' }, '"repo"');
  bad({ repo: 'a/b/c', ref: 'main' }, '"repo"');
  bad({ repo: '/leading', ref: 'main' }, '"repo"');
  bad({ repo: 'trailing/', ref: 'main' }, '"repo"');
  bad({ repo: 'a/../b', ref: 'main' }, '"repo"');
  bad({ repo: 42, ref: 'main' }, '"repo"');
  bad({ repo: undefined, ref: 'main' }, '"repo"');
});

test('a dotted name is accepted — it is only a path segment, it cannot change the host', () => {
  // "evil.com/a" is a legal GitHub owner/repo shape and lands at
  // raw.githubusercontent.com/evil.com/a/... — a nonexistent repo that 404s, not
  // a different host. Rejecting it would be theatre; the host is asserted in rawBase.
  ok({ repo: 'evil.com/a', ref: 'main' });
  assert.equal(new URL(rawBase('evil.com/a', 'main')).host, 'raw.githubusercontent.com');
});

test('repo cannot smuggle URL punctuation or an authority', () => {
  for (const repo of ['a/b?x=1', 'a/b#f', 'a@evil.com/b', 'a/b%2e%2e', 'a\\b', 'a /b']) {
    bad({ repo, ref: 'main' }, '"repo"');
  }
});

// --- ref ------------------------------------------------------------------
test('ref cannot contain ".." or URL punctuation or whitespace', () => {
  for (const ref of ['main/../../other', '..', 'a..b', 'main?x', 'main#f', 'ma in', 'ma\tin', 'ma\nin', '%2e%2e']) {
    bad({ repo: 'o/r', ref }, '"ref"');
  }
});

// --- asset paths ----------------------------------------------------------
test('asset paths reject traversal, absolute URLs and protocol-relative URLs', () => {
  assert.deepEqual(validateAssetPath('icon', 'icon.svg'), []);
  assert.deepEqual(validateAssetPath('icon', 'assets/icon.svg'), []);
  assert.ok(validateAssetPath('icon', '../../../other/repo/main/x.svg').length);
  assert.ok(validateAssetPath('icon', 'https://evil.example/x.svg').length);
  assert.ok(validateAssetPath('icon', '//evil.example/x.svg').length);
  assert.ok(validateAssetPath('icon', 'data:image/svg+xml,<svg/>').length);
  assert.ok(validateAssetPath('icon', 'has space.svg').length);
  assert.ok(validateAssetPath('icon', '').length);
});

test('a leading slash on an asset path is tolerated (it is stripped) but not traversal', () => {
  // build-catalog strips leading slashes when making the URL absolute, so this
  // stays accepted for backwards compatibility.
  assert.deepEqual(validateAssetPath('icon', '/icon.svg'), []);
  assert.ok(validateAssetPath('icon', '/../icon.svg').length);
});
