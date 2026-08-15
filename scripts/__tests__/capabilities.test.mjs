// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Tests for the Fabric capability allow-list (scripts/capabilities.mjs).
 *
 * THE CLASS OF BUG THESE EXIST FOR. On 2026-08-15, `whatsapp` was added to the
 * manifest spec, to OpenMasjidStudents and to the platform — but not to the
 * builder's hand-maintained allow-list. Nothing failed: the manifest was valid, the
 * build was green, and `catalog.json` simply had no `whatsapp` key. The platform
 * read that as "the app never asked", stored `whatsapp: false`, and answered 403 to
 * every send. The app author saw a 403 in THEIR repo caused by a missing line in
 * THIS one.
 *
 * So the important test here is not "does whatsapp survive" — that is the instance.
 * It is `every capability documented in BUILDING_AN_APP.md §3 survives into a built
 * entry`, which is the class. Document a capability without wiring it and CI goes
 * red here, instead of a masjid's install going quiet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BOOLEAN_CAPABILITIES, CAPABILITY_KEYS, capabilityFields, capabilityProblems } from '../capabilities.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

/**
 * The capabilities as an APP AUTHOR meets them: the commented manifest template in
 * docs/BUILDING_AN_APP.md §3, which is what people copy. Keys are declared there as
 * `# <key>: true`. Non-boolean opt-ins (`fabric:`, `alerts:`) do not match that
 * shape, which is what we want — they are carried separately by the builder.
 */
function documentedBooleanCapabilities() {
  const md = readFileSync(join(REPO, 'docs', 'BUILDING_AN_APP.md'), 'utf8');
  const start = md.indexOf('## 3. `manifest.yaml` template');
  assert.notEqual(start, -1, 'BUILDING_AN_APP.md no longer has a "## 3. `manifest.yaml` template" section — this test navigates by that heading');
  const end = md.indexOf('\n## ', start + 1);
  const section = md.slice(start, end === -1 ? undefined : end);
  const keys = [...section.matchAll(/^#?\s*([a-z][a-z0-9_]*):\s*true\b/gm)].map((m) => m[1]);
  return [...new Set(keys)];
}

// ── the class test ──────────────────────────────────────────────────────────────

test('THE CLASS: every capability documented in BUILDING_AN_APP.md §3 survives into a built entry', () => {
  const documented = documentedBooleanCapabilities();
  assert.ok(documented.length >= 5, `expected the §3 template to document several capabilities, found ${documented.length}`);

  // A fixture manifest that asks for everything the docs offer.
  const manifest = Object.fromEntries(documented.map((k) => [k, true]));
  const entry = capabilityFields(manifest);

  const dropped = documented.filter((k) => entry[k] !== true);
  assert.deepEqual(
    dropped,
    [],
    `these capabilities are documented in BUILDING_AN_APP.md §3 but the builder drops them, so the platform ` +
      `will read them as "never asked" and answer 403: ${dropped.join(', ')}. Add them to BOOLEAN_CAPABILITIES ` +
      `in scripts/capabilities.mjs.`,
  );
});

test('THE CLASS, other direction: nothing is wired that the docs never told an author about', () => {
  const documented = new Set(documentedBooleanCapabilities());
  const undocumented = CAPABILITY_KEYS.filter((k) => !documented.has(k));
  assert.deepEqual(
    undocumented,
    [],
    `these capabilities are copied into catalog.json but are absent from the BUILDING_AN_APP.md §3 template, ` +
      `so no app author would know to ask for them: ${undocumented.join(', ')}`,
  );
});

// ── the instance that started it ────────────────────────────────────────────────

test('THE 2026-08-15 BUG: whatsapp: true reaches the catalog entry', () => {
  assert.equal(capabilityFields({ whatsapp: true }).whatsapp, true);
});

test('THE 2026-08-15 BUG: whatsapp survives alongside email, which is how the drop was spotted', () => {
  const entry = capabilityFields({ email: true, whatsapp: true });
  assert.equal(entry.email, true);
  assert.equal(entry.whatsapp, true);
});

test('a whatsapp app that also posts to groups needs no extra key — whatsapp: true covers both', () => {
  // Group posting is gated by the ADMIN in OpenMasjidOS Settings, and apps read the
  // approved list at runtime. A `groups:` manifest key would imply the app decides,
  // which is exactly backwards.
  assert.ok(!CAPABILITY_KEYS.includes('groups'), 'there must be no "groups" capability');
});

// ── shape ───────────────────────────────────────────────────────────────────────

test('only true opts in — false, absent, and truthy strings do not', () => {
  for (const value of [false, undefined, null]) {
    assert.equal(capabilityFields({ whatsapp: value }).whatsapp, undefined, `${String(value)} must not opt in`);
  }
});

test('an undefined capability is dropped by JSON.stringify, not emitted as null', () => {
  // The platform treats an ABSENT key as "did not ask". Emitting `null` or `false`
  // would still be correct today, but absent is what the other entries look like and
  // what the contract in CLAUDE.md §2 describes.
  const json = JSON.parse(JSON.stringify({ id: 'x', ...capabilityFields({ email: true }) }));
  assert.equal('whatsapp' in json, false);
  assert.equal(json.email, true);
});

test('every capability is emitted for a manifest that asks for all of them', () => {
  const all = Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, true]));
  const entry = capabilityFields(all);
  for (const key of CAPABILITY_KEYS) assert.equal(entry[key], true, `${key} was dropped`);
});

// ── validation ──────────────────────────────────────────────────────────────────

test('a non-boolean capability is a build failure, not a silent false', () => {
  // "true" as a string is the mistake an author actually makes. Coercing it would
  // work; coercing it the other way (to false) would be the silent 403 all over again.
  assert.deepEqual(capabilityProblems({ whatsapp: 'true' }), ['manifest "whatsapp" must be true or false']);
  assert.deepEqual(capabilityProblems({ email: 1 }), ['manifest "email" must be true or false']);
});

test('every capability is type-checked, not just the ones someone remembered', () => {
  for (const key of CAPABILITY_KEYS) {
    assert.deepEqual(
      capabilityProblems({ [key]: 'yes' }),
      [`manifest "${key}" must be true or false`],
      `${key} is copied into the entry but never type-checked`,
    );
  }
});

test('a valid manifest produces no problems', () => {
  assert.deepEqual(capabilityProblems({ sso: true, email: false, whatsapp: true }), []);
  assert.deepEqual(capabilityProblems({}), []);
  assert.deepEqual(capabilityProblems(null), []);
});

test('each capability carries a summary, so the list documents itself', () => {
  for (const c of BOOLEAN_CAPABILITIES) {
    assert.equal(typeof c.key, 'string');
    assert.ok(c.key.length > 0, 'a capability needs a key');
    assert.ok(typeof c.summary === 'string' && c.summary.length > 20, `${c.key} needs a real summary`);
  }
});

test('capability keys are unique', () => {
  assert.equal(new Set(CAPABILITY_KEYS).size, CAPABILITY_KEYS.length);
});
