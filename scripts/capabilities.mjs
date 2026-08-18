// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The boolean Fabric capabilities an app opts into in its `manifest.yaml`.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────
 *
 * These used to be a hand-maintained allow-list inlined in `build-catalog.mjs`: one
 * `foo: m.foo === true ? true : undefined` line per capability, plus a matching type
 * check twenty lines up. Adding a capability meant remembering both, in two places,
 * in a file nobody edits for that reason.
 *
 * On 2026-08-15 `whatsapp` was added to the manifest spec and to OpenMasjidStudents
 * and to the platform — and not here. The result is the worst shape a bug can take:
 *
 *   - the app's manifest was correct,
 *   - the catalog build was green,
 *   - `catalog.json` simply had no `whatsapp` key at all — not even `false`,
 *   - the platform therefore stored `whatsapp: false` and answered 403 to every send,
 *   - and it said, accurately, that the app "never asked".
 *
 * So the failure was silent, and it surfaced in a different repository from the one
 * that caused it. `email` surviving while `whatsapp` vanished is the whole diagnosis.
 *
 * The fix is not "remember harder". It is that the list lives in ONE place, is the
 * only thing the builder copies from, and is asserted against the documented
 * template in `docs/BUILDING_AN_APP.md` §3 by `capabilities.test.mjs` — so a
 * capability that is documented but not wired fails CI here, rather than failing as
 * a 403 on a masjid's install.
 *
 * ADDING A CAPABILITY: add one entry below, document it in the §3 template, and
 * write its section in §7. The test enforces the first two agreeing.
 */

/**
 * Every boolean capability the platform reads from a catalog entry, in the order
 * they are emitted. `key` is the manifest key AND the catalog key — they are the
 * same string by design, because a rename between the two is exactly the kind of
 * silent drop this file exists to prevent.
 */
export const BOOLEAN_CAPABILITIES = [
  {
    key: 'sso',
    summary: 'Share the dashboard login — the app checks the visitor with GET /api/auth/session.',
  },
  {
    key: 'notifications',
    summary: "Relay a message to the masjid's webhook over POST /api/fabric/notify; the app never sees the URL.",
  },
  {
    key: 'stripe',
    summary: 'Fetch shared Stripe keys from the OS vault (one account, many apps) via GET /api/fabric/stripe.',
  },
  {
    key: 'domain',
    summary: "Learn this app's PUBLIC URL (tunnel domain + path) via GET /api/fabric/site.",
  },
  {
    key: 'https',
    summary: 'Require HTTPS. ONLY for apps that use Stripe, which needs a secure context.',
  },
  {
    key: 'tunnel',
    summary: 'REQUEST internet exposure through the OS Cloudflare tunnel; the admin still confirms per app.',
  },
  {
    key: 'email',
    summary: "Send mail via the admin's provider over POST /api/fabric/email — the app never sees the credentials.",
  },
  {
    key: 'whatsapp',
    summary:
      'Send WhatsApp through the masjid\'s own OpenWA gateway over POST /api/fabric/whatsapp — the app never ' +
      'sees the gateway, its key, or the linked number. Every app shares ONE paced queue, which is the only ' +
      'thing standing between the masjid and a banned number. Covers group posting too (the admin approves ' +
      'which groups in Settings; apps read the approved list at runtime), so there is no separate groups key.',
  },
];

/** Just the keys, for callers that only need the set. */
export const CAPABILITY_KEYS = BOOLEAN_CAPABILITIES.map((c) => c.key);

/**
 * Type-check every capability on a manifest. Returns a list of problems; empty means
 * usable. A non-boolean is a hard error rather than a coercion: `whatsapp: "true"` is
 * a mistake the author wants to hear about at build time, not a silent false.
 */
export function capabilityProblems(m) {
  const problems = [];
  if (m == null || typeof m !== 'object') return problems;
  for (const { key } of BOOLEAN_CAPABILITIES) {
    const v = m[key];
    if (v != null && typeof v !== 'boolean') {
      problems.push(`manifest "${key}" must be true or false`);
    }
  }
  return problems;
}

/**
 * The capability fields to copy into a catalog entry.
 *
 * Only `true` survives; anything else becomes `undefined` so `JSON.stringify` drops
 * the key entirely. That is deliberate and matches what the platform expects — an
 * absent key means "did not ask", which is also the safe default on the platform side.
 */
export function capabilityFields(m) {
  const out = {};
  for (const { key } of BOOLEAN_CAPABILITIES) {
    out[key] = m?.[key] === true ? true : undefined;
  }
  return out;
}
