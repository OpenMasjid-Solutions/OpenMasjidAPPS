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
import { parse } from 'yaml';

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

// --- versions -------------------------------------------------------------

/**
 * Parse a semver-ish version into comparable parts, or null if it isn't one.
 * Accepts `1`, `1.2`, `1.2.3`, `v1.2.3`, `1.2.3-rc.1`, `1.2.3+build.4`.
 */
export function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return {
    parts: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)],
    // Semver: a version WITH a prerelease is lower than the same without one.
    prerelease: m[4] ? m[4].split('.') : null,
  };
}

/**
 * Compare two versions: -1 / 0 / 1, or **null when either is not parseable**.
 *
 * null means "don't know" and callers must treat it as such — never as equal.
 * Silently treating an unreadable version as equal would let a genuinely older
 * dev build pass the freshness floor below.
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;

  for (let i = 0; i < 3; i++) {
    if (pa.parts[i] !== pb.parts[i]) return pa.parts[i] < pb.parts[i] ? -1 : 1;
  }
  // 1.2.3 > 1.2.3-rc.1
  if (!pa.prerelease && !pb.prerelease) return 0;
  if (!pa.prerelease) return 1;
  if (!pb.prerelease) return -1;

  const n = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < n; i++) {
    const x = pa.prerelease[i];
    const y = pb.prerelease[i];
    if (x === undefined) return -1; // fewer identifiers sorts lower
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers sort lower than alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * THE FRESHNESS INVARIANT: **the dev channel must never be behind stable.**
 *
 * A masjid switching to the Development channel must never be offered a version
 * older than the one it is already running — that reads as an app downgrade in the
 * dashboard, which is what happened on 2026-08-05 when the dev catalog went
 * unrebuilt while three apps shipped stable releases.
 *
 * Equal versions are fine and are the normal case: a moving `:dev` tag publishes
 * new content under an unchanged version string, and the platform compares
 * channels rather than version numbers.
 *
 * Returns true when `devVersion` may be published on the dev channel. An
 * unparseable pair returns false — refuse to claim freshness we cannot establish,
 * and let the caller fall back to the stable release.
 */
export function devVersionIsAcceptable(devVersion, stableVersion) {
  if (stableVersion == null) return true; // nothing to be behind
  const cmp = compareVersions(devVersion, stableVersion);
  if (cmp === null) return false;
  return cmp >= 0;
}

/**
 * Does this version string identify a DEVELOPMENT build?
 *
 * A dev entry is required to carry a semver prerelease (`X.Y.Z-dev.N`, §3b), so the
 * prerelease suffix — not the image tag — is the authoritative marker of dev content.
 * That matters because an entry can be digest-pinned, which leaves the image ref with
 * no tag to inspect at all: the leakage gate would then find nothing to object to
 * while the entry itself still announces a prerelease to every masjid.
 */
export function isDevVersion(version) {
  return parseVersion(version)?.prerelease != null;
}

// --- images ---------------------------------------------------------------

/**
 * Every `image:` value in a compose file, in order.
 *
 * PARSED, not grepped. A line-anchored regex over YAML gets this wrong in both
 * directions, and every caller of this function is a gate:
 *
 *   - MISSES real images — `services: {app: {image: "ghcr.io/o/r:dev"}}` (flow style),
 *     or an image written on a continuation line. A missed image is a dev tag that
 *     walks straight onto the stable channel.
 *   - INVENTS images that do not exist — an `image:` line inside a block scalar
 *     (a `command: |` or a comment-like literal) was collected as if it were a
 *     service's image, which can fail a build for an image nobody references.
 *
 * The regex survives as the parse-failure fallback: validate-compose.mjs refuses an
 * unparseable compose anyway, so a document that lands here without parsing is being
 * rejected for other reasons — but a leakage gate should still see what it can.
 */
export function imageRefsIn(composeText) {
  const out = [];
  if (typeof composeText !== 'string') return out;
  try {
    const doc = parse(composeText);
    const services = doc && typeof doc.services === 'object' && !Array.isArray(doc.services) ? doc.services : null;
    if (services) {
      for (const svc of Object.values(services)) {
        if (svc && typeof svc === 'object' && !Array.isArray(svc) && svc.image != null) {
          const ref = String(svc.image).trim();
          if (ref) out.push(ref);
        }
      }
      return out;
    }
    // Parsed, but there is no services map to read — fall through to the raw scan
    // rather than silently reporting "no images at all".
  } catch {
    // Unparseable — fall through.
  }
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

/** A digest-pinned reference — the only pin a moved tag cannot subvert. */
export const IMAGE_DIGEST_RE = /@sha256:[0-9a-f]{64}/;

/** The catalog every masjid on the stable channel actually fetches (CLAUDE.md §2.1). */
export const PUBLISHED_MAIN_CATALOG_URL =
  'https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidAPPS/main/catalog.json';

/**
 * Apps that would move BACKWARDS if `nextApps` replaced `previousApps`.
 *
 * The stable channel had no such guard. The freshness floor added in v0.2.0
 * guarantees dev is never behind stable, but nothing checked that a new stable
 * catalog is not behind the stable catalog it replaces — so a registry edit that
 * lowered a pin would publish a downgrade to every masjid, silently and instantly.
 *
 * That nearly happened on 2026-08-13: three apps had been released by committing
 * their registry bumps straight onto `main`, leaving `dev` pinning older tags, and
 * the documented `dev` → `main` release would have taken donations back two
 * releases, kiosk one and students four. It was caught by simulating the release by
 * hand, which is not a control.
 *
 * Only compares apps present on BOTH sides: a newly listed app has nothing to
 * regress from, and a delisted one is a deliberate registry edit (see the
 * parking-attendant removal), not a downgrade. Entries whose versions cannot be
 * compared are skipped rather than assumed equal.
 */
export function findVersionRegressions(nextApps, previousApps) {
  const out = [];
  if (!Array.isArray(nextApps) || !Array.isArray(previousApps)) return out;
  const prev = new Map(previousApps.filter((a) => a && a.id).map((a) => [a.id, a]));
  for (const a of nextApps) {
    if (!a || !a.id || a.comingSoon === true) continue;
    const p = prev.get(a.id);
    if (!p || p.comingSoon === true) continue; // newly listed, or was only a teaser
    const cmp = compareVersions(a.version, p.version);
    if (cmp !== null && cmp < 0) out.push({ id: a.id, from: String(p.version), to: String(a.version) });
  }
  return out;
}

// --- the dev entry contract -----------------------------------------------

/**
 * THE DEV ENTRY CONTRACT. A dev-channel entry must give the platform a version
 * axis and an immutable target, exactly as a stable entry does:
 *
 *   1. `version` is a semver **prerelease** — `X.Y.Z-dev.N`, where X.Y.Z is the
 *      release being worked toward. It must never equal the stable version, or
 *      there is nothing for the platform to compare and an update is undetectable.
 *   2. **Every** service's image is immutable: `@sha256:<digest>`, or a tag equal
 *      to this entry's `version`. Never `:dev`.
 *
 * Why both: with a moving `:dev` tag the catalog names one build and pulls
 * another, so "what you were told about" and "what you get" diverge. With a
 * repeated version string there is no axis to compare at all — a new dev build
 * changes nothing in the catalog, the platform stays silent, and the update
 * button has no target.
 *
 * A third-party image (a database, say) can only satisfy this by digest, which is
 * correct: it is as much a part of what gets installed as the app's own image.
 *
 * Returns human-readable problems; empty means the entry is publishable on dev.
 * This does NOT apply to a stable-fallback entry — that legitimately carries a
 * plain release version and a release image. See build-catalog.mjs.
 */
export function devEntryProblems({ version, composeText } = {}) {
  const problems = [];

  const parsed = parseVersion(version);
  if (!parsed) {
    problems.push(
      `version ${JSON.stringify(version)} is not a semver version, so the platform cannot order it`,
    );
  } else if (!parsed.prerelease) {
    problems.push(
      `version "${version}" has no prerelease suffix — a dev entry needs X.Y.Z-dev.N (e.g. "${parsed.parts[0]}.${parsed.parts[1] + 1}.0-dev.1"), ` +
        `so it can never equal the stable version and a new dev build is detectable`,
    );
  }

  for (const ref of imageRefsIn(composeText)) {
    if (ref.includes('${')) {
      problems.push(
        `image "${ref}" is substituted at install time, so the catalog cannot know which build it names`,
      );
      continue;
    }
    if (IMAGE_DIGEST_RE.test(ref)) continue; // digest — immutable, always fine
    const tag = imageTagOf(ref);
    if (!tag) {
      problems.push(`image "${ref}" has neither a tag nor a digest`);
    } else if (version == null || tag !== String(version)) {
      problems.push(
        `image "${ref}" is tagged "${tag}", which is neither an @sha256 digest nor this entry's version ` +
          `"${version}" — the catalog would name one build and install another`,
      );
    }
  }

  return problems;
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
