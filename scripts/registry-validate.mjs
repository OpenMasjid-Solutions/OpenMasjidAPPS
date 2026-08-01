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

/**
 * Validate the three registry fields that become part of a fetch URL.
 * Returns an array of human-readable problems; empty means safe to use.
 */
export function validateSource({ repo, ref, path }) {
  const problems = [];

  if (typeof repo !== 'string' || !REPO_RE.test(repo)) {
    problems.push(
      `"repo" must be "<owner>/<repo>" using only letters, digits, ".", "_" and "-" (got ${JSON.stringify(repo)})`,
    );
  }

  if (ref != null) {
    const r = String(ref);
    if (!REF_RE.test(r) || URL_UNSAFE.test(r)) {
      problems.push(`"ref" must be a plain git ref — letters, digits, ".", "_", "-", "/" (got ${JSON.stringify(ref)})`);
    } else if (r.includes('..')) {
      problems.push(`"ref" must not contain ".." (got ${JSON.stringify(ref)})`);
    }
  }

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
