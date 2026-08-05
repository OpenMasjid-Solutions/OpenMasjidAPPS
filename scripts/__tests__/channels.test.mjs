// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Tests for the update-channel model (scripts/channels.mjs).
 *
 * The load-bearing property is the last group: **no dev ref and no dev-tagged
 * image may be publishable on the stable channel.** main/catalog.json is fetched
 * directly by every masjid with no deploy step in between, so a leak there is live
 * immediately. Everything else here supports that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNELS,
  DEFAULT_CHANNEL,
  CHANNEL_BRANCH,
  isChannel,
  parseChannelArg,
  channelFromBranch,
  resolveChannel,
  isReleaseTag,
  isCommitSha,
  isStableRef,
  looksLikeBranch,
  imageRefsIn,
  imageTagOf,
  isDevImageTag,
  isDevImageRef,
  findDevArtifacts,
  parseVersion,
  compareVersions,
  devVersionIsAcceptable,
} from '../channels.mjs';

const SHA = 'a'.repeat(40);

// --- channel identity -----------------------------------------------------

test('the two channels are main and dev, main is the default', () => {
  assert.deepEqual(CHANNELS, ['main', 'dev']);
  assert.equal(DEFAULT_CHANNEL, 'main');
});

test('each channel publishes from the branch of the same name', () => {
  // The workflow sets OPENMASJID_CHANNEL from the matrix branch; if these ever
  // diverged, a leg would build one channel and push it to the other's branch.
  assert.deepEqual(CHANNEL_BRANCH, { main: 'main', dev: 'dev' });
  for (const c of CHANNELS) assert.equal(CHANNEL_BRANCH[c], c);
});

test('isChannel accepts only the published channels', () => {
  assert.ok(isChannel('main'));
  assert.ok(isChannel('dev'));
  for (const v of ['Dev', 'MAIN', 'stable', 'prod', '', null, undefined, 0, ['dev']]) {
    assert.equal(isChannel(v), false, `${JSON.stringify(v)} is not a channel`);
  }
});

// --- --channel parsing ----------------------------------------------------

test('parseChannelArg reads both flag spellings', () => {
  assert.equal(parseChannelArg(['--channel', 'dev']), 'dev');
  assert.equal(parseChannelArg(['--channel=dev']), 'dev');
  assert.equal(parseChannelArg(['--channel', 'main']), 'main');
  assert.equal(parseChannelArg(['-x', '--channel=main', '-y']), 'main');
});

test('parseChannelArg returns null when the flag is absent', () => {
  assert.equal(parseChannelArg([]), null);
  assert.equal(parseChannelArg(['--verbose']), null);
  assert.equal(parseChannelArg(), null);
});

test('parseChannelArg throws on a valueless flag rather than silently defaulting', () => {
  // Falling through to the default channel here would build stable when the caller
  // plainly meant to state a channel.
  assert.throws(() => parseChannelArg(['--channel']), /needs a value/);
  assert.throws(() => parseChannelArg(['--channel', '--other']), /needs a value/);
});

test('parseChannelArg does not validate — resolveChannel does', () => {
  assert.equal(parseChannelArg(['--channel=nonsense']), 'nonsense');
});

// --- branch → channel -----------------------------------------------------

test('dev and dev/* branches build the dev channel', () => {
  assert.equal(channelFromBranch('dev'), 'dev');
  assert.equal(channelFromBranch('dev/kiosk-tweaks'), 'dev');
  assert.equal(channelFromBranch(' dev '), 'dev'); // trimmed
});

test('every other branch falls back to stable, never inventing dev content', () => {
  for (const b of ['main', 'feat/x', 'audit/security-2026-07-31', 'release/1.0', 'develop', '', null, undefined, 42]) {
    assert.equal(channelFromBranch(b), 'main', `branch ${JSON.stringify(b)}`);
  }
});

// --- resolveChannel precedence --------------------------------------------

test('resolveChannel prefers the flag over env and branch', () => {
  const r = resolveChannel({ argv: ['--channel=main'], env: { OPENMASJID_CHANNEL: 'dev' }, branch: 'dev' });
  assert.deepEqual({ channel: r.channel, source: r.source }, { channel: 'main', source: 'flag' });
});

test('resolveChannel prefers env over the branch', () => {
  const r = resolveChannel({ argv: [], env: { OPENMASJID_CHANNEL: 'dev' }, branch: 'main' });
  assert.deepEqual({ channel: r.channel, source: r.source }, { channel: 'dev', source: 'env' });
});

test('resolveChannel falls back to the branch, then to main', () => {
  assert.deepEqual(
    (({ channel, source }) => ({ channel, source }))(resolveChannel({ branch: 'dev' })),
    { channel: 'dev', source: 'git' },
  );
  assert.deepEqual(
    (({ channel, source }) => ({ channel, source }))(resolveChannel({})),
    { channel: 'main', source: 'default' },
  );
});

test('resolveChannel ignores a blank env value', () => {
  const r = resolveChannel({ env: { OPENMASJID_CHANNEL: '   ' }, branch: 'dev' });
  assert.equal(r.source, 'git');
  assert.equal(r.channel, 'dev');
});

test('resolveChannel throws on a stated but invalid channel', () => {
  // A typo must stop the build. Defaulting would publish the OTHER channel's
  // content to the branch the caller named.
  assert.throws(() => resolveChannel({ argv: ['--channel=stable'] }), /unknown channel "stable"/);
  assert.throws(() => resolveChannel({ env: { OPENMASJID_CHANNEL: 'prod' } }), /is not a channel/);
});

test('resolveChannel reports the branch it was given', () => {
  assert.equal(resolveChannel({ argv: ['--channel=dev'], branch: 'main' }).branch, 'main');
});

// --- ref shapes -----------------------------------------------------------

test('isReleaseTag accepts published version tags', () => {
  for (const t of ['v1.0.0', '1.0.0', 'v0.66.0', 'v0.10.1', '2.0', 'v3', 'v1.0.0-rc.1', '1.2.3+build.4']) {
    assert.ok(isReleaseTag(t), `${t} is a release tag`);
  }
});

test('isReleaseTag rejects branch names', () => {
  for (const t of ['dev', 'main', 'master', 'next', 'release/1.0', 'feature/x', 'latest', 'v', '', 'HEAD', null]) {
    assert.equal(isReleaseTag(t), false, `${JSON.stringify(t)} is not a release tag`);
  }
});

test('isCommitSha requires exactly 40 lowercase hex chars', () => {
  assert.ok(isCommitSha(SHA));
  assert.ok(isCommitSha('715139b589f3376315bc74af919a46565e443920'));
  assert.equal(isCommitSha(SHA.toUpperCase()), false);
  assert.equal(isCommitSha(SHA.slice(0, 39)), false);
  assert.equal(isCommitSha(SHA + 'a'), false);
  assert.equal(isCommitSha('g'.repeat(40)), false);
});

test('the stable channel accepts a release tag or a commit SHA, nothing else', () => {
  assert.ok(isStableRef('v0.66.0'));
  assert.ok(isStableRef(SHA));
  assert.equal(isStableRef('dev'), false);
  assert.equal(isStableRef('main'), false);
  assert.equal(isStableRef('feature/new-thing'), false);
});

test('looksLikeBranch explains a rejection without being the rejection', () => {
  assert.ok(looksLikeBranch('dev'));
  assert.ok(looksLikeBranch('MAIN'));
  assert.ok(looksLikeBranch('release/1.0'));
  assert.equal(looksLikeBranch('v1.0.0'), false);
  // A branch named something unusual is still refused by isStableRef.
  assert.equal(looksLikeBranch('wibble'), false);
  assert.equal(isStableRef('wibble'), false);
});

// --- image refs -----------------------------------------------------------

test('imageRefsIn finds every image line, quoted or not', () => {
  const compose = [
    'services:',
    '  web:',
    '    image: ghcr.io/o/r:1.0.0@sha256:' + 'b'.repeat(64),
    '  db:',
    "    image: 'postgres:16-alpine'",
    '  cache:',
    '    image: "redis:7"   # trailing comment',
  ].join('\n');
  assert.deepEqual(imageRefsIn(compose), [
    'ghcr.io/o/r:1.0.0@sha256:' + 'b'.repeat(64),
    'postgres:16-alpine',
    'redis:7',
  ]);
});

test('imageRefsIn tolerates non-strings and finds nothing in an empty compose', () => {
  assert.deepEqual(imageRefsIn(''), []);
  assert.deepEqual(imageRefsIn(null), []);
  assert.deepEqual(imageRefsIn('services:\n  a:\n    build: .\n'), []);
});

test('imageTagOf reads the tag, not a registry port', () => {
  assert.equal(imageTagOf('ghcr.io/o/r:dev'), 'dev');
  assert.equal(imageTagOf('ghcr.io/o/r:1.2.3'), '1.2.3');
  assert.equal(imageTagOf('nginx:alpine'), 'alpine');
  // A port before a slash is part of the host, not a tag.
  assert.equal(imageTagOf('localhost:5000/r'), null);
  assert.equal(imageTagOf('localhost:5000/r:dev'), 'dev');
  // Implicit :latest and digest-only refs have no tag.
  assert.equal(imageTagOf('nginx'), null);
  assert.equal(imageTagOf('ghcr.io/o/r@sha256:' + 'c'.repeat(64)), null);
  assert.equal(imageTagOf(''), null);
  assert.equal(imageTagOf(null), null);
});

test('imageTagOf keeps the tag from a tag+digest ref', () => {
  assert.equal(imageTagOf('ghcr.io/o/r:1.2.3@sha256:' + 'd'.repeat(64)), '1.2.3');
  assert.equal(imageTagOf('ghcr.io/o/r:dev@sha256:' + 'd'.repeat(64)), 'dev');
});

test('isDevImageTag recognises dev tags in their usual spellings', () => {
  for (const t of ['dev', 'DEV', 'nightly', 'edge', 'unstable', 'canary', 'snapshot', 'preview',
                   'dev-abc123', 'dev.4', '1.2.0-dev', '2.0.0-nightly.1', 'v1-dev-build']) {
    assert.ok(isDevImageTag(t), `${t} is a dev tag`);
  }
});

test('isDevImageTag does not fire on release tags', () => {
  for (const t of ['1.2.3', 'v0.66.0', 'alpine', '16-alpine', 'latest', 'stable', '7', '', null,
                   'developer-tools', 'devon']) {
    assert.equal(isDevImageTag(t), false, `${JSON.stringify(t)} is not a dev tag`);
  }
});

test('isDevImageRef judges the tag of a full reference', () => {
  assert.ok(isDevImageRef('ghcr.io/openmasjid-solutions/openmasjiddisplay:dev'));
  assert.equal(isDevImageRef('ghcr.io/openmasjid-solutions/openmasjiddisplay:0.66.0'), false);
  // A repo whose NAME contains "dev" is not a dev image.
  assert.equal(isDevImageRef('ghcr.io/dev-team/openmasjiddisplay:1.0.0'), false);
});

// --- the leakage gate -----------------------------------------------------

const digest = '@sha256:' + 'e'.repeat(64);
const releaseCompose = `services:\n  app:\n    image: ghcr.io/o/r:1.0.0${digest}\n`;
const devCompose = 'services:\n  app:\n    image: ghcr.io/o/r:dev\n';

test('a release tag with a digest-pinned release image is clean', () => {
  assert.deepEqual(findDevArtifacts({ ref: 'v1.0.0', composeText: releaseCompose }), []);
  assert.deepEqual(findDevArtifacts({ ref: SHA, composeText: releaseCompose }), []);
});

test('a dev branch ref is reported, and named as a branch', () => {
  const reasons = findDevArtifacts({ ref: 'dev', composeText: releaseCompose });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /ref "dev" is not a published release tag/);
  assert.match(reasons[0], /only the dev channel may track/);
});

test('a dev-tagged image is reported even when the ref is a release tag', () => {
  // The realistic leak: a release-tagged registry entry pointing at a repo whose
  // compose still references the moving :dev image.
  const reasons = findDevArtifacts({ ref: 'v1.0.0', composeText: devCompose });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /image "ghcr\.io\/o\/r:dev" is tagged "dev", a development tag/);
});

test('both halves are reported together', () => {
  assert.equal(findDevArtifacts({ ref: 'dev', composeText: devCompose }).length, 2);
});

test('every dev-tagged service is reported, not just the first', () => {
  const multi = [
    'services:',
    '  web:',
    '    image: ghcr.io/o/web:dev',
    '  worker:',
    '    image: ghcr.io/o/worker:nightly',
    '  db:',
    `    image: postgres:16-alpine${digest}`,
  ].join('\n');
  const reasons = findDevArtifacts({ ref: 'v1.0.0', composeText: multi });
  assert.equal(reasons.length, 2);
  assert.match(reasons[0], /web:dev/);
  assert.match(reasons[1], /worker:nightly/);
});

test('an env-substituted image is not judged here', () => {
  // ${IMAGE_TAG} is resolved at install time from the user's .env, so its value is
  // not knowable at build time. Nothing to assert about it either way.
  const compose = 'services:\n  app:\n    image: ghcr.io/o/r:${IMAGE_TAG}\n';
  assert.deepEqual(findDevArtifacts({ ref: 'v1.0.0', composeText: compose }), []);
});

test('findDevArtifacts copes with missing input', () => {
  assert.deepEqual(findDevArtifacts(), []);
  assert.deepEqual(findDevArtifacts({}), []);
  assert.deepEqual(findDevArtifacts({ ref: '', composeText: '' }), []);
});

// --- versions and the freshness invariant ---------------------------------

test('parseVersion accepts the shapes app manifests actually use', () => {
  assert.deepEqual(parseVersion('0.66.1').parts, [0, 66, 1]);
  assert.deepEqual(parseVersion('v0.66.1').parts, [0, 66, 1]);
  assert.deepEqual(parseVersion('1.2').parts, [1, 2, 0]);
  assert.deepEqual(parseVersion('3').parts, [3, 0, 0]);
  assert.deepEqual(parseVersion('1.2.3-rc.1').prerelease, ['rc', '1']);
  assert.equal(parseVersion('1.2.3+build.4').prerelease, null);
});

test('parseVersion rejects what is not a version', () => {
  for (const v of ['', 'dev', 'latest', 'v', '1.2.3.4', 'x1.0', null, undefined, 42, {}]) {
    assert.equal(parseVersion(v), null, `${JSON.stringify(v)}`);
  }
});

test('compareVersions orders releases', () => {
  assert.equal(compareVersions('0.66.1', '0.66.0'), 1);
  assert.equal(compareVersions('0.66.0', '0.66.1'), -1);
  assert.equal(compareVersions('0.66.1', '0.66.1'), 0);
  assert.equal(compareVersions('0.47.0', '0.45.2'), 1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions('v0.10.2', '0.10.1'), 1); // leading v is cosmetic
});

test('compareVersions follows semver on prereleases', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1); // release beats prerelease
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc.2'), -1);
  assert.equal(compareVersions('1.0.0-rc.2', '1.0.0-rc.10'), -1); // numeric, not lexical
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(compareVersions('1.0.0-rc', '1.0.0-rc.1'), -1); // fewer identifiers sort lower
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1); // numeric below alphanumeric
});

test('compareVersions returns null — not 0 — when it cannot tell', () => {
  // Treating "unknown" as "equal" would let a genuinely older dev build satisfy the
  // freshness floor, which is the whole thing the floor exists to stop.
  assert.equal(compareVersions('dev', '1.0.0'), null);
  assert.equal(compareVersions('1.0.0', 'nightly'), null);
  assert.equal(compareVersions(null, '1.0.0'), null);
});

test('THE INVARIANT: dev may publish a version at or ahead of stable', () => {
  assert.ok(devVersionIsAcceptable('0.66.1', '0.66.1')); // equal is the NORMAL case
  assert.ok(devVersionIsAcceptable('0.47.0', '0.45.2')); // ahead
  assert.ok(devVersionIsAcceptable('1.0.0-rc.1', '0.99.0'));
});

test('THE INVARIANT: dev may not publish a version behind stable', () => {
  // This is the 2026-08-05 regression, in one line per app. The dev catalog went
  // unrebuilt while three apps shipped stable releases, so switching a masjid to the
  // Development channel offered to move every app BACKWARDS.
  assert.equal(devVersionIsAcceptable('0.66.0', '0.66.1'), false); // display
  assert.equal(devVersionIsAcceptable('0.40.0', '0.40.1'), false); // donations
  assert.equal(devVersionIsAcceptable('0.10.1', '0.10.2'), false); // kiosk
  assert.equal(devVersionIsAcceptable('1.0.0-rc.1', '1.0.0'), false); // prerelease behind release
});

test('THE INVARIANT: an unverifiable version is refused, not waved through', () => {
  // Refusing means "fall back to the stable release", which is always safe. Claiming
  // freshness we cannot establish is not.
  assert.equal(devVersionIsAcceptable('dev', '0.66.1'), false);
  assert.equal(devVersionIsAcceptable(null, '0.66.1'), false);
  assert.equal(devVersionIsAcceptable('0.66.1', 'not-a-version'), false);
});

test('THE INVARIANT: with no stable release there is nothing to be behind', () => {
  assert.ok(devVersionIsAcceptable('0.1.0', null));
  assert.ok(devVersionIsAcceptable('anything', null));
});

test('a resolved commit SHA never reads as dev — which is why the DECLARED ref is judged', () => {
  // The build resolves `dev_ref: dev` to the SHA the branch is at. If the gate saw
  // only that SHA it would find nothing wrong, so build-catalog.mjs passes the
  // declared value. This test pins that reasoning.
  assert.deepEqual(findDevArtifacts({ ref: SHA, composeText: releaseCompose }), []);
  assert.equal(findDevArtifacts({ ref: 'dev', composeText: releaseCompose }).length, 1);
});
