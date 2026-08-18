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
import { validateSource, rawBase, validateAssetPath, validateManifestFields, LIMITS } from '../registry-validate.mjs';

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

// --- dev_ref (the dev channel's column) -----------------------------------
test('dev_ref accepts the branch shapes a dev channel tracks', () => {
  for (const dev_ref of ['dev', 'develop', 'dev/next', 'feature-a_b', SHA]) {
    ok({ repo: 'o/r', ref: 'v1.0.0', dev_ref });
  }
});

test('an absent or empty dev_ref is accepted — the dev channel falls back to the release', () => {
  ok({ repo: 'o/r', ref: 'v1.0.0' });
  ok({ repo: 'o/r', ref: 'v1.0.0', dev_ref: '' });
  ok({ repo: 'o/r', ref: 'v1.0.0', dev_ref: null });
});

test('dev_ref gets exactly the same URL safety checks as ref', () => {
  // Being the development channel is not a reason to relax URL validation: the
  // value is interpolated into the same raw.githubusercontent.com URL, so a `..`
  // there would redirect the entry to another repository just as it would in `ref`.
  for (const dev_ref of ['dev/../../other', '..', 'a..b', 'dev?x', 'dev#f', 'de v', 'de\tv', 'de\nv', '%2e%2e']) {
    bad({ repo: 'o/r', ref: 'v1.0.0', dev_ref }, '"dev_ref"');
  }
});

test('a bad dev_ref is named as dev_ref, not as ref', () => {
  // The message has to point at the right column or the maintainer edits the wrong line.
  const problems = validateSource({ repo: 'o/r', ref: 'v1.0.0', dev_ref: 'a..b' });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"dev_ref"/);
  assert.doesNotMatch(problems[0], /"ref"/);
});

test('both ref columns are reported when both are bad', () => {
  const problems = validateSource({ repo: 'o/r', ref: 'a..b', dev_ref: 'c..d' });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /"ref"/);
  assert.match(problems[1], /"dev_ref"/);
});

test('the four live entries are accepted with their dev column', () => {
  for (const repo of [
    'OpenMasjid-Solutions/OpenMasjidDisplay',
    'OpenMasjid-Solutions/OpenMasjidDonations',
    'OpenMasjid-Solutions/OpenMasjidKiosk',
    'OpenMasjid-Solutions/OpenMasjidStudents',
  ]) {
    ok({ repo, ref: 'v0.66.0', commit: SHA, dev_ref: 'dev' });
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

// --- APPS-014: manifest fields copied into the catalog --------------------
const mOK = (label, m) =>
  test(`APPS-014 accepted: ${label}`, () =>
    assert.deepEqual(validateManifestFields(m), [], `expected ${label} to be accepted`));
const mBad = (label, m, needle) =>
  test(`APPS-014 rejected: ${label}`, () => {
    const p = validateManifestFields(m);
    assert.ok(p.length > 0, `expected ${label} to be rejected`);
    if (needle) {
      assert.ok(p.some((x) => x.includes(needle)), `expected ${JSON.stringify(needle)}, got ${JSON.stringify(p)}`);
    }
  });

// A manifest shaped like the real reference app must pass untouched.
mOK('a full, realistic manifest', {
  id: 'prayer-times-display', name: 'Prayer Times Display', tagline: 'A calm clock',
  category: 'displays', version: '1.0.0', author: 'OpenMasjidAPPS', license: 'AGPL-3.0-only',
  icon: 'icon.svg', screenshots: ['screenshots/1.svg'], description: '# Heading\n\nMarkdown body.\n',
  settings: [
    { key: 'MASJID_NAME', label: 'Masjid name', type: 'text', default: 'Our Masjid' },
    { key: 'CALC_METHOD', label: 'Method', type: 'select', options: ['MWL', 'ISNA'], default: 'MWL' },
    { key: 'SHOW_TIME', label: 'Show clock', type: 'boolean', default: true },
  ],
  ports: [{ container: 80, label: 'Web interface' }],
});
mOK('a bare minimum manifest', { name: 'A', version: '1' });
mOK('a multi-line markdown description', { name: 'A', version: '1', description: 'a\n\nb\n- c\n' });

// name / version - required by the platform contract (CLAUDE.md 2.3).
mBad('a numeric name', { name: 123, version: '1' }, 'must be a string');
mBad('an object name', { name: { en: 'x' }, version: '1' }, 'must be a string');
mBad('a list name', { name: ['x'], version: '1' }, 'must be a string, got a list');
mBad('a blank name', { name: '   ', version: '1' }, 'must not be blank');
mBad('a missing name', { version: '1' }, 'is required');
mBad('a missing version', { name: 'A' }, 'is required');
mBad('a newline in the name', { name: 'A\nB', version: '1' }, 'single line');

test('APPS-014 a numeric name used to crash the build at sort time', () => {
  // apps.sort() does a.name.localeCompare(b.name); a number has no localeCompare.
  assert.throws(() => (123).localeCompare('x'), TypeError);
  assert.ok(validateManifestFields({ name: 123, version: '1' }).length, 'must be caught before the sort');
});

// Length caps - set well above the largest live value (biggest description ~1.7 KB).
mOK('a description at exactly the cap', { name: 'A', version: '1', description: 'x'.repeat(LIMITS.description) });
mBad('a description one byte over the cap', { name: 'A', version: '1', description: 'x'.repeat(LIMITS.description + 1) }, 'over the');
mBad('an over-long tagline', { name: 'A', version: '1', tagline: 'x'.repeat(LIMITS.tagline + 1) }, 'over the');

// settings - the platform writes these to .env as KEY=VALUE (CLAUDE.md 7).
mBad('settings as a map', { name: 'A', version: '1', settings: { K: 'v' } }, 'must be a list');
mBad('a setting that is not an object', { name: 'A', version: '1', settings: ['K'] }, 'must be an object');
mBad('a key that is not an env-var name', { name: 'A', version: '1', settings: [{ key: '9x', label: 'L' }] }, 'environment-variable name');
mBad('a key with a dash', { name: 'A', version: '1', settings: [{ key: 'A-B', label: 'L' }] }, 'environment-variable name');
mBad('a duplicate key', { name: 'A', version: '1', settings: [{ key: 'K', label: 'a' }, { key: 'K', label: 'b' }] }, 'duplicates');
mBad('a missing label', { name: 'A', version: '1', settings: [{ key: 'K' }] }, 'label is required');
mBad('an unknown type', { name: 'A', version: '1', settings: [{ key: 'K', label: 'L', type: 'colour' }] }, 'is unknown');
mBad('select with no options', { name: 'A', version: '1', settings: [{ key: 'K', label: 'L', type: 'select' }] }, 'options');
mBad('select with an empty options list', { name: 'A', version: '1', settings: [{ key: 'K', label: 'L', type: 'select', options: [] }] }, 'options');
mBad('a newline in a default (.env line injection)', { name: 'A', version: '1', settings: [{ key: 'K', label: 'L', default: 'a\nEXTRA=1' }] }, 'single line');
mBad('a carriage return in a default', { name: 'A', version: '1', settings: [{ key: 'K', label: 'L', default: 'a\rB' }] }, 'single line');
mBad('an object default', { name: 'A', version: '1', settings: [{ key: 'K', label: 'L', default: { a: 1 } }] }, 'must be a scalar');
mOK('a boolean default', { name: 'A', version: '1', settings: [{ key: 'K', label: 'L', type: 'boolean', default: false }] });
mOK('a numeric default', { name: 'A', version: '1', settings: [{ key: 'K', label: 'L', type: 'number', default: 12 }] });

// ports - CLAUDE.md 2.3 says [{ container: number, label?: string }].
mBad('a string port', { name: 'A', version: '1', ports: [{ container: '80' }] }, 'integer from 1 to 65535');
mBad('port 0', { name: 'A', version: '1', ports: [{ container: 0 }] }, 'integer from 1 to 65535');
mBad('a negative port', { name: 'A', version: '1', ports: [{ container: -1 }] }, 'integer from 1 to 65535');
mBad('a port above 65535', { name: 'A', version: '1', ports: [{ container: 70000 }] }, 'integer from 1 to 65535');
mBad('a fractional port', { name: 'A', version: '1', ports: [{ container: 80.5 }] }, 'integer from 1 to 65535');
mBad('ports as a map', { name: 'A', version: '1', ports: { container: 80 } }, 'must be a list');
mOK('valid ports', { name: 'A', version: '1', ports: [{ container: 1 }, { container: 65535, label: 'x' }] });

// icon / screenshots
mBad('an icon that traverses out of the repo', { name: 'A', version: '1', icon: '../../../evil/x.svg' }, '..');
mBad('an absolute icon URL', { name: 'A', version: '1', icon: 'https://evil.example/x.svg' }, 'not a URL');
mBad('screenshots as a string', { name: 'A', version: '1', screenshots: 'screenshots/1.svg' }, 'must be a list');
mBad('a screenshot that traverses', { name: 'A', version: '1', screenshots: ['ok.svg', '../../x.svg'] }, '..');

// ── APPS-024: the stripe-account setting type ──────────────────────────────────
// Found by the 2026-08-18 audit. docs/BUILDING_AN_APP.md §7 tells a Stripe app author
// to use `type: stripe-account`, and the platform's own SettingField union accepts it —
// but SETTING_TYPES here did not, so an app that followed the documentation had its
// entry FAIL the catalog build. The doc and the platform were right; this was stale.

test('APPS-024 the documented stripe-account picker is accepted', () => {
  const problems = validateManifestFields({
    name: 'Donations',
    version: '1.0.0',
    settings: [{ key: 'STRIPE_ACCOUNT', label: 'OpenMasjidOS Stripe account', type: 'stripe-account' }],
  });
  assert.deepEqual(problems, []);
});

test('APPS-024 every type in the platform union is accepted, and nothing else', () => {
  // The union is OpenMasjidOS packages/core/src/apps/types.ts SettingField.type.
  for (const type of ['text', 'select', 'number', 'password', 'boolean', 'stripe-account']) {
    const settings = [{ key: 'K', label: 'L', type, ...(type === 'select' ? { options: ['a'] } : {}) }];
    assert.deepEqual(validateManifestFields({ name: 'X', version: '1.0.0', settings }), [], `${type} should be valid`);
  }
  const bad = validateManifestFields({ name: 'X', version: '1.0.0', settings: [{ key: 'K', label: 'L', type: 'stripe' }] });
  assert.ok(bad.some((p) => p.includes('is unknown')), JSON.stringify(bad));
});

test('APPS-024 stripe-account needs no options list, unlike select', () => {
  assert.deepEqual(
    validateManifestFields({ name: 'X', version: '1.0.0', settings: [{ key: 'K', label: 'L', type: 'stripe-account' }] }),
    [],
  );
  const sel = validateManifestFields({ name: 'X', version: '1.0.0', settings: [{ key: 'K', label: 'L', type: 'select' }] });
  assert.ok(sel.some((p) => p.includes('needs a non-empty "options" list')), JSON.stringify(sel));
});
