// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * registry-validate.mjs — validation for everything that crosses into the catalog
 * from outside this repository.
 *
 * Two distinct untrusted inputs get checked here:
 *
 *   1. The registry entry's own `repo` / `ref` / `path`. These are interpolated
 *      into a raw.githubusercontent.com URL. `path` used to be passed through
 *      with only leading/trailing slashes stripped, so a `..` segment silently
 *      redirected a commit-SHA-pinned entry at a DIFFERENT repository while the
 *      entry, the review diff and the build log all still named the pinned one —
 *      defeating the single integrity control registry.yaml documents.
 *      (APPS-001)
 *
 *   2. The remote manifest fields copied into catalog.json and read by the
 *      platform. The platform contract (CLAUDE.md §2.3) fixes their types;
 *      nothing checked them, so a bad manifest could break the build or emit an
 *      entry the platform cannot read. (APPS-014)
 *
 * Split out of build-catalog.mjs so it is unit-testable: importing that script
 * runs the whole build.
 */

// A GitHub "owner/repo". GitHub itself allows only [A-Za-z0-9._-] in each part.
// No slashes beyond the single separator, so no traversal and no authority change.
export const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
// A git ref: tag, branch or SHA. Slashes are legal (release/1.x) but `..` is not
// (it is also invalid in a git ref name).
export const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

// Anything that could change the meaning of the URL rather than just extend its
// path: whitespace, percent-encoding, query/fragment/userinfo punctuation,
// backslashes, and any control character.
const URL_UNSAFE = /[\s%?#@\\:]|[\x00-\x1f\x7f-\x9f]/;
// The platform writes settings to .env as KEY=VALUE lines, so a value containing
// a newline injects further environment variables (CLAUDE.md §7).
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/;

/**
 * Validate one ref-shaped field (`ref` or `dev_ref`). Both are interpolated into
 * the same fetch URL, so both get identical treatment — a dev channel is not a
 * reason to relax URL safety.
 */
function refProblems(field, value) {
  const problems = [];
  const r = String(value);
  if (!REF_RE.test(r) || URL_UNSAFE.test(r)) {
    problems.push(`"${field}" must be a plain git ref — letters, digits, ".", "_", "-", "/" (got ${JSON.stringify(value)})`);
  } else if (r.includes('..')) {
    problems.push(`"${field}" must not contain ".." (got ${JSON.stringify(value)})`);
  }
  return problems;
}

/**
 * Validate the registry fields that become part of a fetch URL.
 * Returns an array of human-readable problems; empty means safe to use.
 *
 * `dev_ref` is the dev channel's address for the same app (CLAUDE.md "Channels").
 * It is a moving branch by design, but it is still interpolated into a URL, so it
 * passes exactly the same checks as `ref`.
 */
export function validateSource({ repo, ref, path, dev_ref: devRef }) {
  const problems = [];

  if (typeof repo !== 'string' || !REPO_RE.test(repo)) {
    problems.push(
      `"repo" must be "<owner>/<repo>" using only letters, digits, ".", "_" and "-" (got ${JSON.stringify(repo)})`,
    );
  }

  if (ref != null) problems.push(...refProblems('ref', ref));
  if (devRef != null && String(devRef) !== '') problems.push(...refProblems('dev_ref', devRef));

  if (path != null && String(path) !== '') {
    const p = String(path);
    if (URL_UNSAFE.test(p)) {
      problems.push(
        `"path" must be a plain relative subpath with no spaces, backslashes or URL punctuation (got ${JSON.stringify(path)})`,
      );
    } else if (p.startsWith('/')) {
      // Historically tolerated (leading slashes were stripped); say so explicitly
      // rather than silently rewriting, so the registry means what it says.
      problems.push(`"path" must be relative, not absolute (got ${JSON.stringify(path)})`);
    } else if (p.split('/').some((seg) => seg === '..')) {
      problems.push(
        `"path" must not contain a ".." segment (got ${JSON.stringify(path)}) — it would redirect this entry ` +
          `to a different repository while still appearing pinned`,
      );
    }
  }

  return problems;
}

/**
 * Build the raw.githubusercontent.com base URL for a repo/ref/subpath.
 * validateSource() MUST have passed first; this asserts that rather than trusting
 * it, so the traversal cannot be reintroduced by a caller that forgets to validate.
 */
export function rawBase(repo, ref, path) {
  const problems = validateSource({ repo, ref, path });
  if (problems.length) throw new Error(`unsafe catalog source: ${problems.join('; ')}`);
  const sub = path ? `${String(path).replace(/^\/+|\/+$/g, '')}/` : '';
  const url = `https://raw.githubusercontent.com/${repo}/${ref}/${sub}`;
  // Belt and braces: the assembled URL must still be on the expected host and
  // must not have normalised its way out of the repo/ref prefix.
  const parsed = new URL(url);
  if (parsed.host !== 'raw.githubusercontent.com' || !parsed.pathname.startsWith(`/${repo}/${ref}/`)) {
    throw new Error(`unsafe catalog source: ${url} does not resolve inside ${repo}@${ref}`);
  }
  return url;
}

/** An asset path inside the app repo (icon, screenshot) — same rules as `path`. */
export function validateAssetPath(kind, value) {
  const v = String(value);
  if (!v) return [`${kind} must not be empty`];
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v) || v.startsWith('//')) {
    return [
      `${kind} must be a path inside the app repo, not a URL (got ${JSON.stringify(value)}) — the catalog makes it absolute`,
    ];
  }
  if (URL_UNSAFE.test(v)) {
    return [`${kind} contains characters that are not allowed in a repo path (got ${JSON.stringify(value)})`];
  }
  if (v.replace(/^\/+/, '').split('/').some((seg) => seg === '..')) {
    return [`${kind} must not contain a ".." segment (got ${JSON.stringify(value)})`];
  }
  return [];
}

// --- manifest field validation (APPS-014) ---------------------------------

// Caps are set far above the largest value any listed app uses (the biggest live
// description is ~1.7 KB) so nothing currently in the catalog is affected. They
// exist to bound what one app repo can push into the file every masjid fetches.
export const LIMITS = {
  name: 120,
  tagline: 200,
  author: 120,
  license: 60,
  version: 40,
  description: 16 * 1024,
};

// Mirrors the platform's SettingField union (OpenMasjidOS packages/core/src/apps/types.ts).
// 'stripe-account' is a platform-aware picker: the OS renders a dropdown of the Stripe
// accounts the admin configured in Settings -> Payments and passes the chosen account's
// name as the value, so nobody re-types Stripe details in the install dialog. It was
// documented in docs/BUILDING_AN_APP.md and supported by the platform, but missing here —
// so an app that followed the documentation had its entry FAIL the build. (2026-08-18 audit)
const SETTING_TYPES = new Set(['text', 'select', 'number', 'password', 'boolean', 'stripe-account']);
// The platform writes answers to .env as KEY=VALUE, so a key must be a valid
// environment-variable name.
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate the manifest fields copied into a catalog entry.
 * Returns an array of problems; empty means the manifest is usable as-is.
 */
export function validateManifestFields(m) {
  const problems = [];
  const str = (key, required) => {
    const v = m[key];
    if (v == null) {
      if (required) problems.push(`manifest "${key}" is required`);
      return;
    }
    if (typeof v !== 'string') {
      problems.push(`manifest "${key}" must be a string, got ${Array.isArray(v) ? 'a list' : typeof v}`);
      return;
    }
    if (required && !v.trim()) problems.push(`manifest "${key}" must not be blank`);
    const cap = LIMITS[key];
    if (cap && v.length > cap) problems.push(`manifest "${key}" is ${v.length} chars, over the ${cap}-char limit`);
    // description is markdown and legitimately multi-line; everything else is
    // rendered on one line in the App Store.
    if (key !== 'description' && CONTROL_CHARS.test(v)) {
      problems.push(`manifest "${key}" must be a single line without control characters`);
    }
  };

  // `name` and `version` are required by the platform contract; `name` is also
  // sorted on with localeCompare, so a non-string used to crash the build.
  str('name', true);
  str('version', true);
  for (const k of ['tagline', 'author', 'license', 'description']) str(k, false);

  if (m.settings != null) {
    if (!Array.isArray(m.settings)) {
      problems.push(`manifest "settings" must be a list (CLAUDE.md §7), got ${typeof m.settings}`);
    } else {
      const seen = new Set();
      m.settings.forEach((f, i) => {
        const at = `settings[${i}]`;
        if (!f || typeof f !== 'object' || Array.isArray(f)) {
          problems.push(`${at} must be an object with "key", "label" and "type"`);
          return;
        }
        if (typeof f.key !== 'string' || !ENV_KEY_RE.test(f.key)) {
          problems.push(`${at}.key must be a valid environment-variable name (got ${JSON.stringify(f.key)})`);
        } else if (seen.has(f.key)) {
          problems.push(`${at}.key duplicates an earlier setting ("${f.key}")`);
        } else {
          seen.add(f.key);
        }
        if (typeof f.label !== 'string' || !f.label.trim()) problems.push(`${at}.label is required`);
        if (f.type != null && !SETTING_TYPES.has(f.type)) {
          problems.push(`${at}.type "${f.type}" is unknown (use: ${[...SETTING_TYPES].join(', ')})`);
        }
        if (f.type === 'select' && (!Array.isArray(f.options) || !f.options.length)) {
          problems.push(`${at} is type "select" so it needs a non-empty "options" list`);
        }
        if (f.default != null) {
          if (typeof f.default === 'object') {
            problems.push(`${at}.default must be a scalar, not ${Array.isArray(f.default) ? 'a list' : 'an object'}`);
          } else if (CONTROL_CHARS.test(String(f.default))) {
            problems.push(
              `${at}.default must be a single line — the platform writes it to .env as KEY=VALUE (CLAUDE.md §7)`,
            );
          }
        }
      });
    }
  }

  if (m.ports != null) {
    if (!Array.isArray(m.ports)) {
      problems.push(`manifest "ports" must be a list of { container, label? }`);
    } else {
      m.ports.forEach((p, i) => {
        if (!p || typeof p !== 'object' || Array.isArray(p)) {
          problems.push(`ports[${i}] must be an object with a numeric "container"`);
          return;
        }
        if (!Number.isInteger(p.container) || p.container < 1 || p.container > 65535) {
          problems.push(`ports[${i}].container must be an integer from 1 to 65535 (got ${JSON.stringify(p.container)})`);
        }
        if (p.label != null && typeof p.label !== 'string') problems.push(`ports[${i}].label must be a string`);
      });
    }
  }

  if (m.icon != null) problems.push(...validateAssetPath('manifest "icon"', m.icon));
  if (m.screenshots != null) {
    if (!Array.isArray(m.screenshots)) problems.push(`manifest "screenshots" must be a list of paths`);
    else m.screenshots.forEach((s, i) => problems.push(...validateAssetPath(`screenshots[${i}]`, s)));
  }

  return problems;
}
