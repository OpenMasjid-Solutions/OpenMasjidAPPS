// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * channels.mjs — the update-channel model shared by the build and the linter.
 *
 * OpenMasjidOS has an Update Channel setting that swaps the branch in the one URL
 * it fetches:
 *
 *   https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidAPPS/<branch>/catalog.json
 *                                                                          ^^^^^^^^
 *                                                        main = stable, dev = development
 *
 * So each branch of THIS repo publishes its own single-channel catalog.json, and
 * `registry.yaml` (one schema, identical on both branches) carries both addresses
 * per app: `ref` for stable, `dev_ref` for development. The branch decides which
 * column is built — see CLAUDE.md "Channels".
 *
 * The rule that matters: **a dev ref or a dev-tagged image must never reach the
 * main catalog.** main/catalog.json is production — every masjid fetches it
 * directly, with no deploy step in between — so leakage there ships unreleased
 * images to real masjids. Everything below exists to make that detectable.
 */

export const CHANNELS = ['main', 'dev'];
export const DEFAULT_CHANNEL = 'main';
/** The branch each channel is published from (and the only branches CI may commit to). */
export const CHANNEL_BRANCH = { main: 'main', dev: 'dev' };
export const ENV_VAR = 'OPENMASJID_CHANNEL';

/** True for a value that names a channel we publish. */
export function isChannel(v) {
  return typeof v === 'string' && CHANNELS.includes(v);
}

/**
 * Read `--channel dev` / `--channel=dev` out of an argv tail.
 * Returns the raw string (unvalidated) or null. Throws if the flag is present
 * with no value — a silent fall-through to the default channel there could build
 * the wrong catalog.
 */
export function parseChannelArg(argv = []) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--channel') {
      const v = argv[i + 1];
      if (v == null || v.startsWith('-')) throw new Error('--channel needs a value: --channel main|dev');
      return v;
    }
    if (a.startsWith('--channel=')) return a.slice('--channel='.length);
  }
  return null;
}

/**
 * Which channel a git branch publishes. `dev` (and `dev/*` working branches) build
 * the development catalog; everything else defaults to stable.
 *
 * Deliberately conservative: an unrecognised branch resolves to `main`, so a
 * stray local build can never invent dev content — it just rebuilds what main
 * already publishes. CI never relies on this: both workflows pass the channel
 * explicitly (from the pushed branch, or a PR's base branch).
 */
export function channelFromBranch(branch) {
  if (typeof branch !== 'string' || !branch) return DEFAULT_CHANNEL;
  const b = branch.trim();
  if (b === 'dev' || b.startsWith('dev/')) return 'dev';
  return DEFAULT_CHANNEL;
}

/**
 * Resolve the channel to build, most explicit source first:
 *   --channel flag  →  OPENMASJID_CHANNEL env  →  current git branch  →  main
 *
 * Returns { channel, source, branch }. Throws on an explicitly stated but invalid
 * channel — a typo must stop the build, not quietly publish the other channel.
 */
export function resolveChannel({ argv = [], env = {}, branch = null } = {}) {
  const flag = parseChannelArg(argv);
  if (flag != null) {
    if (!isChannel(flag)) throw new Error(`unknown channel "${flag}" — use one of: ${CHANNELS.join(', ')}`);
    return { channel: flag, source: 'flag', branch };
  }

  const fromEnv = env[ENV_VAR];
  if (fromEnv != null && String(fromEnv).trim() !== '') {
    const v = String(fromEnv).trim();
    if (!isChannel(v)) throw new Error(`${ENV_VAR}="${v}" is not a channel — use one of: ${CHANNELS.join(', ')}`);
    return { channel: v, source: 'env', branch };
  }

  if (typeof branch === 'string' && branch) {
    return { channel: channelFromBranch(branch), source: 'git', branch };
  }

  return { channel: DEFAULT_CHANNEL, source: 'default', branch };
}

// --- refs -----------------------------------------------------------------

/** A full git commit SHA — the only immutable pin (a tag or branch can be moved). */
export const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * A published release tag: `v1.2.3`, `1.2`, `v0.66.0-rc.1`, `2.0.0+build.4`.
 * The stable channel accepts nothing else (bar a commit SHA), because a branch
 * name in the `ref` column means main's catalog silently follows a moving
 * branch — which is what the dev channel is for.
 */
export const RELEASE_TAG_RE = /^v?\d+(\.\d+)*(-[0-9A-Za-z][0-9A-Za-z.-]*)?(\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

export function isReleaseTag(ref) {
  return typeof ref === 'string' && RELEASE_TAG_RE.test(ref);
}

export function isCommitSha(ref) {
  return typeof ref === 'string' && COMMIT_SHA_RE.test(ref);
}

/** What the stable channel will accept as a `ref`: a release tag or a commit SHA. */
export function isStableRef(ref) {
  return isReleaseTag(ref) || isCommitSha(ref);
}

/**
 * Branch names that are development lines by convention. Used to explain WHY a
 * stable `ref` was rejected — the rejection itself is isStableRef()'s job, so a
 * branch named something else is still refused.
 */
const DEV_BRANCH_NAMES = new Set(['dev', 'develop', 'development', 'next', 'main', 'master', 'trunk', 'staging', 'head']);

export function looksLikeBranch(ref) {
  if (typeof ref !== 'string' || !ref) return false;
  return DEV_BRANCH_NAMES.has(ref.toLowerCase()) || ref.includes('/');
}

// --- images ---------------------------------------------------------------

/** Every `image:` value in a compose file, in order. */
export function imageRefsIn(composeText) {
  const out = [];
  if (typeof composeText !== 'string') return out;
  const re = /^[ \t]*image:[ \t]*["']?([^"'\s#]+)/gm;
  for (let m; (m = re.exec(composeText)); ) out.push(m[1]);
  return out;
}

/**
 * The tag part of an image reference, or null when there isn't one.
 *
 *   ghcr.io/o/r:dev            → "dev"
 *   ghcr.io/o/r:1.2.3@sha256:… → "1.2.3"
 *   ghcr.io/o/r@sha256:…       → null   (digest only)
 *   localhost:5000/r           → null   (that colon is a registry port, not a tag)
 *   nginx                      → null   (implicit :latest)
 */
export function imageTagOf(imageRef) {
  if (typeof imageRef !== 'string' || !imageRef) return null;
  const withoutDigest = imageRef.split('@')[0];
  const lastSlash = withoutDigest.lastIndexOf('/');
  const namePart = lastSlash === -1 ? withoutDigest : withoutDigest.slice(lastSlash + 1);
  const colon = namePart.indexOf(':');
  if (colon === -1) return null;
  const tag = namePart.slice(colon + 1);
  return tag === '' ? null : tag;
}

/**
 * Tags that mark a pre-release/rolling image. These are exactly what an app's
 * dev branch publishes, and exactly what must never appear in main's catalog.
 * `latest` is not here: it is a release-channel mistake rather than a dev image,
 * and the build already warns about any tag that isn't digest-pinned.
 */
const DEV_TAGS = new Set(['dev', 'develop', 'development', 'nightly', 'edge', 'unstable', 'canary', 'snapshot', 'preview']);

/** True if the tag is a dev-channel tag (`dev`, `1.2.0-dev`, `dev-abc123`, `nightly`…). */
export function isDevImageTag(tag) {
  if (typeof tag !== 'string' || !tag) return false;
  const t = tag.toLowerCase();
  if (DEV_TAGS.has(t)) return true;
  // Semver-ish prerelease or suffixed forms: 1.2.0-dev, dev-abc123, 2.0-nightly.1
  for (const word of DEV_TAGS) {
    if (
      t.startsWith(`${word}-`) ||
      t.startsWith(`${word}.`) ||
      t.endsWith(`-${word}`) ||
      t.endsWith(`.${word}`) ||
      t.includes(`-${word}-`) ||
      t.includes(`-${word}.`)
    ) {
      return true;
    }
  }
  return false;
}

export function isDevImageRef(imageRef) {
  return isDevImageTag(imageTagOf(imageRef));
}

// --- the leakage gate -----------------------------------------------------

/**
 * Everything about this entry that belongs to the dev channel, as human-readable
 * reasons. On the stable channel each one is a build failure; on dev they are
 * expected.
 *
 * `ref` is the DECLARED registry ref (not the SHA it resolved to — a resolved SHA
 * is never recognisably "dev", which is exactly why the declared value is what
 * gets judged).
 */
export function findDevArtifacts({ ref, composeText } = {}) {
  const reasons = [];

  if (typeof ref === 'string' && ref && !isStableRef(ref)) {
    reasons.push(
      `ref "${ref}" is not a published release tag or commit SHA` +
        (looksLikeBranch(ref) ? ' — it names a branch, which only the dev channel may track' : ''),
    );
  }

  for (const imageRef of imageRefsIn(composeText)) {
    if (imageRef.includes('${')) continue; // substituted at install time — not judgeable here
    if (isDevImageRef(imageRef)) {
      reasons.push(`image "${imageRef}" is tagged "${imageTagOf(imageRef)}", a development tag`);
    }
  }

  return reasons;
}
