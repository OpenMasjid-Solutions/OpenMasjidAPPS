// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Tests for scripts/validate-compose.mjs — the catalog's compose-safety gate.
 *
 * CLAUDE.md §10 marks this validator DO-NOT-REGRESS and requires it to stay in
 * lockstep with the platform's apps/compose-validate.ts, so that
 * "passes the catalog build" === "safe to install". Until this file existed that
 * invariant was maintained by hand. Every directive class the validator rejects
 * gets a case here; every audit finding gets a named regression case.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCompose } from '../validate-compose.mjs';

// --- helpers ---------------------------------------------------------------
const rejects = (text, needle) => {
  const { errors } = validateCompose(text);
  assert.ok(
    errors.some((e) => e.toLowerCase().includes(needle.toLowerCase())),
    `expected an error matching ${JSON.stringify(needle)}, got ${JSON.stringify(errors)}`,
  );
};
const clean = (text) => {
  const { errors } = validateCompose(text);
  assert.deepEqual(errors, [], `expected no errors, got ${JSON.stringify(errors)}`);
};
const warnsOnly = (text, needle) => {
  const { errors, warnings } = validateCompose(text);
  assert.deepEqual(errors, [], `expected no errors, got ${JSON.stringify(errors)}`);
  assert.ok(
    warnings.some((w) => w.toLowerCase().includes(needle.toLowerCase())),
    `expected a warning matching ${JSON.stringify(needle)}, got ${JSON.stringify(warnings)}`,
  );
};
const svc = (body) => `services:\n  app:\n    image: nginx:1.27-alpine\n${body}`;

// --- a legitimate app must keep passing ------------------------------------
// Shaped like the real listed apps (they use cap_drop + no-new-privileges).
test('a well-formed least-privilege app passes clean', () => {
  clean(`services:
  app:
    image: ghcr.io/o/r:1.2.3@sha256:${'a'.repeat(64)}
    restart: unless-stopped
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    environment:
      MASJID_NAME: \${MASJID_NAME}
    volumes:
      - app-data:/data
    ports:
      - "8731:80"
volumes:
  app-data:
`);
});

test('anonymous and named volumes are fine', () => {
  clean(svc('    volumes:\n      - /data\n      - app-data:/var/lib/app\nvolumes:\n  app-data:\n'));
});

test('tmpfs long syntax is fine', () => {
  clean(svc('    volumes:\n      - type: tmpfs\n        target: /tmp\n'));
});

// --- privileged / namespaces ----------------------------------------------
for (const spelling of ['true', 'yes', 'on', '1', '"true"', 'y']) {
  test(`privileged: ${spelling} is rejected (isTruthyFlag)`, () => {
    rejects(svc(`    privileged: ${spelling}\n`), 'privileged');
  });
}
test('privileged: false is allowed', () => clean(svc('    privileged: false\n')));

test('network_mode: host is rejected', () => rejects(svc('    network_mode: host\n'), 'network_mode'));
test('network_mode: container: is rejected', () =>
  rejects(svc('    network_mode: "container:other"\n'), 'network_mode'));
for (const k of ['pid', 'ipc']) {
  test(`${k}: host is rejected`, () => rejects(svc(`    ${k}: host\n`), k));
}
for (const k of ['userns_mode', 'cgroup', 'uts']) {
  test(`${k}: host is rejected`, () => rejects(svc(`    ${k}: host\n`), k));
}

// --- capabilities / devices ------------------------------------------------
test('cap_add list is rejected', () => rejects(svc('    cap_add: [SYS_ADMIN]\n'), 'cap_add'));
test('devices list is rejected', () => rejects(svc('    devices:\n      - /dev/mem:/dev/mem\n'), 'devices'));
test('devices scalar is rejected', () => rejects(svc('    devices: /dev/mem\n'), 'devices'));
test('device_cgroup_rules is rejected', () =>
  rejects(svc('    device_cgroup_rules:\n      - "c 1:3 rwm"\n'), 'device_cgroup_rules'));
test('security_opt unconfined is rejected', () =>
  rejects(svc('    security_opt:\n      - seccomp=unconfined\n'), 'unconfined'));
test('security_opt no-new-privileges is allowed', () =>
  clean(svc('    security_opt:\n      - no-new-privileges:true\n')));
test('group_add docker is rejected', () => rejects(svc('    group_add:\n      - docker\n'), 'group_add'));
test('group_add of a normal group is allowed', () => clean(svc('    group_add:\n      - staff\n')));

// --- the Docker socket ----------------------------------------------------
test('docker.sock bind mount is rejected', () =>
  rejects(svc('    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n'), 'docker socket'));
test('docker.sock at /run is rejected', () =>
  rejects(svc('    volumes:\n      - /run/docker.sock:/x\n'), 'docker socket'));
test('mounting the /var/run parent is rejected', () =>
  rejects(svc('    volumes:\n      - /var/run:/hostrun\n'), 'sensitive host path'));

// --- sensitive host paths / escapes ---------------------------------------
for (const p of ['/etc', '/root', '/var', '/proc', '/sys', '/boot', '/dev', '/home', '/usr', '/']) {
  test(`bind mount of ${p} is rejected`, () =>
    rejects(svc(`    volumes:\n      - "${p}:/host"\n`), 'sensitive host path'));
}
test('.. escape is rejected', () =>
  rejects(svc('    volumes:\n      - "../../secrets:/s"\n'), 'escapes the app folder'));
test('long-syntax bind of /etc is rejected', () =>
  rejects(svc('    volumes:\n      - type: bind\n        source: /etc\n        target: /he\n'), 'sensitive host path'));
test('a relative bind mount warns but does not fail', () =>
  warnsOnly(svc('    volumes:\n      - "./data:/data"\n'), 'bind-mounts a host path'));

// --- config merging the checker cannot see --------------------------------
test('YAML merge key is rejected', () =>
  rejects(`x-base: &b\n  image: n\nservices:\n  app:\n    <<: *b\n`, 'merge key'));

test('YAML merge key is still caught in its other spellings', () => {
  rejects(`services:\n  app:\n    <<: *b\n`, 'merge key'); // space before the colon
  rejects(`services:\n  app:\n\t<<: *b\n`, 'merge key'); // tab-indented
  rejects(`<<: *b\nservices:\n  app:\n    image: n\n`, 'merge key'); // column 0
});

test('APPS-007 the merge-key scan is linear, not quadratic, on hostile input', () => {
  // The old /(^|\n)\s*<<\s*:/ was quadratic: \s also matches \n, so the (^|\n)
  // alternation and the \s* quantifier overlapped and a match could start at every
  // newline. Measured on the old pattern: 99ms at 20 KB, 6.4s at 160 KB, 25.7s at
  // 320 KB — roughly 4x for each doubling. The new anchored pattern is linear.
  //
  // Timing thresholds are flaky on shared CI, so assert the SHAPE (doubling the
  // input roughly doubles the work) rather than an absolute wall-clock number.
  const scan = (text) => {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 20; i++) /^[ \t]*<<[ \t]*:/m.test(text);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  const evil = (bytes) => '\n'.repeat(bytes / 2) + ' '.repeat(bytes / 2);
  const small = scan(evil(200_000));
  const large = scan(evil(800_000)); // 4x the input
  // Linear => ~4x. Quadratic => ~16x. Allow generous headroom and still separate them.
  assert.ok(large < small * 8 + 50, `4x input took ${(large / small).toFixed(1)}x the time — looks super-linear`);
});

test('APPS-007 a whole hostile document is validated well inside the fetch ceiling', () => {
  // fetchText caps a fetched compose at 2 MiB, so that is the worst case that can
  // reach the validator. The residual cost is the YAML parser walking the document,
  // which is linear in size (~1.2s at 2 MiB). The old regex alone needed ~16 min.
  const evil = '\n'.repeat(1024 * 1024) + ' '.repeat(1024 * 1024); // 2 MiB
  const t0 = process.hrtime.bigint();
  validateCompose(evil);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 15_000, `2 MiB took ${ms.toFixed(0)}ms`);
});
test('top-level include is rejected', () =>
  rejects(`include:\n  - other.yml\nservices:\n  app:\n    image: n\n`, 'include'));
test('service extends is rejected', () =>
  rejects(svc('    extends:\n      service: other\n'), 'extends'));
test('build: is rejected (apps must ship a published image)', () =>
  rejects(`services:\n  app:\n    build: .\n`, 'build'));

// --- volumes_from / env_file ---------------------------------------------
test('volumes_from is rejected', () => rejects(svc('    volumes_from:\n      - other\n'), 'volumes_from'));
test('volumes_from scalar is rejected', () => rejects(svc('    volumes_from: other\n'), 'volumes_from'));
test('env_file with an absolute path is rejected', () =>
  rejects(svc('    env_file: /etc/secrets.env\n'), 'env_file'));
test('env_file with .. is rejected', () =>
  rejects(svc('    env_file:\n      - ../../.env\n'), 'env_file'));
test('env_file in the app folder is allowed', () => clean(svc('    env_file: ./app.env\n')));

// --- top-level volumes ---------------------------------------------------
test('local-driver bind volume is rejected', () =>
  rejects(`services:\n  app:\n    image: n\nvolumes:\n  d:\n    driver: local\n    driver_opts:\n      type: bind\n      device: /srv/x\n`, 'bind mount to the host'));
test('external volume is rejected', () =>
  rejects(`services:\n  app:\n    image: n\nvolumes:\n  d:\n    external: true\n`, 'pre-existing docker volume'));
test("external volume targeting another app's data is called out", () =>
  rejects(`services:\n  app:\n    image: n\nvolumes:\n  d:\n    external: true\n    name: omos-donations-data\n`, "another openmasjid app's data"));
test('renamed volume is rejected', () =>
  rejects(`services:\n  app:\n    image: n\nvolumes:\n  d:\n    name: somebody-elses\n`, 'pre-existing docker volume'));

// --- top-level networks (APPS-002) ---------------------------------------
// The mirror of the external-volume rule. Every case below is VALID Docker
// Compose (checked against Docker Compose v5.3.1) and used to pass with zero
// errors and zero warnings.
test('APPS-002 external network is rejected', () =>
  rejects(`services:\n  app:\n    image: n\n    networks: [shared]\nnetworks:\n  shared:\n    external: true\n`, 'pre-existing docker network'));

test('APPS-002 external network named omos_* is called out as a platform network', () =>
  rejects(`services:\n  app:\n    image: n\n    networks: [omos_internal]\nnetworks:\n  omos_internal:\n    external: true\n`, 'openmasjid platform network'));

test('APPS-002 the name: override form is rejected', () =>
  rejects(`services:\n  app:\n    image: n\nnetworks:\n  default:\n    name: omos_core_default\n    external: true\n`, 'openmasjid platform network'));

test('APPS-002 name: without external: is still rejected (it renames the scoped network)', () =>
  rejects(`services:\n  app:\n    image: n\nnetworks:\n  mynet:\n    name: somebody-elses\n`, 'pre-existing docker network'));

test('APPS-002 the long external form { external: { name } } is rejected', () =>
  rejects(`services:\n  app:\n    image: n\nnetworks:\n  mynet:\n    external:\n      name: omos-donations_default\n`, 'openmasjid platform network'));

test('APPS-002 network driver host/none is rejected', () => {
  rejects(`services:\n  app:\n    image: n\nnetworks:\n  default:\n    driver: host\n`, 'bypasses network isolation');
  rejects(`services:\n  app:\n    image: n\nnetworks:\n  default:\n    driver: none\n`, 'bypasses network isolation');
});

test('APPS-002 joining an undeclared network is rejected', () =>
  rejects(svc('    networks: [not-declared]\n'), 'without declaring it'));

test('APPS-002 an ordinary project-scoped network still passes', () => {
  clean(`services:\n  app:\n    image: n\n    networks: [internal]\nnetworks:\n  internal:\n`);
  clean(`services:\n  app:\n    image: n\n    networks:\n      internal:\n        aliases: [api]\nnetworks:\n  internal:\n    driver: bridge\n`);
});

test('APPS-002 no networks: block at all still passes (the common case)', () =>
  clean(`services:\n  app:\n    image: n\n    ports: ["8080:80"]\n`));

test('APPS-002 joining the implicit default network still passes', () =>
  clean(svc('    networks: [default]\n')));

// --- discovery labels (APPS-004) -----------------------------------------
// CLAUDE.md §4C forbids these and docs/BUILDING_AN_APP.md:573 claims they are
// "Rejected at build AND at install" — nothing checked them until now.
test('APPS-004 spoofing another app\'s compose project label is rejected', () =>
  rejects(svc('    labels:\n      com.docker.compose.project: omos-donations\n'), 'platform-internal label'));

test('APPS-004 com.openmasjid.* labels are rejected', () =>
  rejects(svc('    labels:\n      com.openmasjid.trusted: "true"\n'), 'platform-internal label'));

test('APPS-004 the list form of labels is checked too', () =>
  rejects(svc('    labels:\n      - "com.docker.compose.project=omos-kiosk"\n'), 'platform-internal label'));

test('APPS-004 reserved labels on networks, volumes and secrets are rejected', () => {
  rejects(`services:\n  app:\n    image: n\nvolumes:\n  d:\n    labels:\n      com.openmasjid.x: "1"\n`, 'platform-internal label');
  rejects(`services:\n  app:\n    image: n\nnetworks:\n  nn:\n    labels:\n      com.docker.compose.project: omos-x\n`, 'platform-internal label');
});

test('APPS-004 the match is case-insensitive', () =>
  rejects(svc('    labels:\n      COM.Docker.Compose.Project: omos-x\n'), 'platform-internal label'));

test('APPS-004 an app\'s own labels are still allowed', () => {
  clean(svc('    labels:\n      org.opencontainers.image.title: My App\n      my.app.role: web\n'));
  clean(svc('    labels:\n      - "org.opencontainers.image.licenses=MIT"\n'));
});

// --- cgroup_parent / sysctls (APPS-011) ----------------------------------
test('APPS-011 cgroup_parent is rejected', () =>
  rejects(svc('    cgroup_parent: /docker/evil\n'), 'cgroup_parent'));

test('APPS-011 an empty cgroup_parent is not flagged', () => clean(svc('    cgroup_parent: ""\n')));

test('APPS-011 sysctls warn but do not fail the build', () =>
  warnsOnly(svc('    sysctls:\n      net.ipv4.ip_forward: 1\n'), 'sysctls'));

// --- non-array shapes must not skip a check (APPS-012) -------------------
// Docker Compose v5.3.1 rejects all three of these ("must be a array"), so they
// are not an exploitable bypass — but CLAUDE.md §10 makes lockstep with the
// platform's independent validator an invariant, and it must not depend on shape.
test('APPS-012 scalar cap_add is rejected', () => rejects(svc('    cap_add: SYS_ADMIN\n'), 'cap_add'));
test('APPS-012 scalar security_opt unconfined is rejected', () =>
  rejects(svc('    security_opt: seccomp=unconfined\n'), 'unconfined'));
test('APPS-012 scalar group_add docker is rejected', () => rejects(svc('    group_add: docker\n'), 'group_add'));
test('APPS-012 scalar security_opt that is harmless still passes', () =>
  clean(svc('    security_opt: no-new-privileges:true\n')));

// --- file-based secrets / configs ---------------------------------------
test('secret with a sensitive file source is rejected', () =>
  rejects(`services:\n  app:\n    image: n\nsecrets:\n  s:\n    file: /etc/shadow\n`, 'sensitive host path'));
test('config with a .. file source is rejected', () =>
  rejects(`services:\n  app:\n    image: n\nconfigs:\n  c:\n    file: ../../x\n`, 'escapes the app folder'));
test('secret with an in-folder file source is allowed', () =>
  clean(`services:\n  app:\n    image: n\nsecrets:\n  s:\n    file: ./s.txt\n`));

// --- the raw-regex fallback still works when YAML will not parse ---------
test('unparseable YAML still rejects privileged, and now FAILS rather than warning', () => {
  const { errors, warnings } = validateCompose('services:\n  a:\n    privileged: true\n  : : :\n\tbad');
  assert.ok(errors.some((e) => e.includes('privileged')));
  assert.ok(errors.some((e) => e.includes('did not parse as YAML')));
});

test('a YAML alias bomb degrades to the raw checks instead of hanging', () => {
  const bomb =
    'x: &a ' + 'y'.repeat(200) + '\n' +
    Array.from({ length: 12 }, (_, i) =>
      `x${i}: &b${i} [${Array(60).fill(i === 0 ? '*a' : `*b${i - 1}`).join(',')}]`).join('\n') +
    '\nservices:\n  app:\n    image: n\n    privileged: true\n';
  const t0 = process.hrtime.bigint();
  const { errors, warnings } = validateCompose(bomb);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 1000, `alias bomb took ${ms}ms`);
  assert.ok(errors.some((e) => e.includes('did not parse as YAML')));
  assert.ok(errors.some((e) => e.includes('privileged')));
});

test('empty and non-object documents do not throw', () => {
  for (const t of ['', '\n', 'null\n', '[]\n', '"just a string"\n', 'services:\n']) {
    assert.doesNotThrow(() => validateCompose(t), `threw on ${JSON.stringify(t)}`);
  }
});

// ── APPS-020: install-time interpolation in a safety-relevant position ──────────
// Found by the 2026-08-18 audit. `validateCompose` reads the RAW compose, but Docker
// interpolates `${VAR}` from the .env the platform writes at install — so
// `privileged: ${HW:-true}` reached a masjid as `privileged: true` while this gate saw
// the literal string and called it falsy. Confirmed with `docker compose config`.
// The catalog cannot vouch for a value it never sees, so these are hard errors.

test('APPS-020 interpolated privileged is rejected, not read as falsy', () => {
  const r = validateCompose(`
services:
  app:
    image: ghcr.io/o/r:1.0.0
    privileged: \${ENABLE_HW:-true}
`);
  assert.ok(
    r.errors.some((e) => e.includes('"privileged" is chosen at install time')),
    `expected an interpolation error, got: ${JSON.stringify(r.errors)}`,
  );
});

test('APPS-020 every host-namespace key is covered, not just privileged', () => {
  for (const key of ['network_mode', 'pid', 'ipc', 'userns_mode', 'cgroup', 'uts', 'cgroup_parent']) {
    const r = validateCompose(`
services:
  app:
    image: ghcr.io/o/r:1.0.0
    ${key}: \${SOMETHING:-host}
`);
    assert.ok(
      r.errors.some((e) => e.includes(`"${key}" is chosen at install time`)),
      `${key} was not flagged: ${JSON.stringify(r.errors)}`,
    );
  }
});

test('APPS-020 list-valued keys are covered too (cap_add, devices, security_opt, group_add)', () => {
  for (const key of ['cap_add', 'devices', 'device_cgroup_rules', 'security_opt', 'group_add']) {
    const r = validateCompose(`
services:
  app:
    image: ghcr.io/o/r:1.0.0
    ${key}:
      - \${WANTED}
`);
    assert.ok(
      r.errors.some((e) => e.includes(`"${key}" is chosen at install time`)),
      `${key} was not flagged: ${JSON.stringify(r.errors)}`,
    );
  }
});

test('APPS-020 an interpolated volume is rejected — and the whole entry is quoted back', () => {
  // The message must not try to split the entry on ":", because the default value
  // contains one: "${DATA_DIR:-/}:/hostdata".
  const r = validateCompose(`
services:
  app:
    image: ghcr.io/o/r:1.0.0
    volumes:
      - \${DATA_DIR:-/}:/hostdata
`);
  const hit = r.errors.find((e) => e.includes('a volume is assembled at install time'));
  assert.ok(hit, `expected a volume interpolation error, got: ${JSON.stringify(r.errors)}`);
  assert.ok(hit.includes('${DATA_DIR:-/}:/hostdata'), `message should quote the whole entry, got: ${hit}`);
});

test('APPS-020 the long-form volume source is covered as well', () => {
  const r = validateCompose(`
services:
  app:
    image: ghcr.io/o/r:1.0.0
    volumes:
      - type: bind
        source: \${HOST_DIR}
        target: /data
`);
  assert.ok(r.errors.some((e) => e.includes('a volume is assembled at install time')), JSON.stringify(r.errors));
});

test('APPS-020 a top-level volume or network adopted at install time is rejected', () => {
  const r = validateCompose(`
services:
  app:
    image: ghcr.io/o/r:1.0.0
volumes:
  data:
    name: \${EXISTING_VOLUME}
networks:
  net:
    external: \${SHARE_IT}
`);
  assert.ok(r.errors.some((e) => e.includes('volume "data": "name" is chosen at install time')), JSON.stringify(r.errors));
  assert.ok(r.errors.some((e) => e.includes('network "net": "external" is chosen at install time')), JSON.stringify(r.errors));
});

test('APPS-020 interpolation stays LEGAL where a masjid\'s answers are meant to go', () => {
  // environment, label values and ports are the whole mechanism by which install-time
  // settings reach the container. Breaking these would break every real app.
  const r = validateCompose(`
services:
  app:
    image: ghcr.io/o/r:1.0.0@sha256:${'b'.repeat(64)}
    environment:
      - MASJID_NAME=\${MASJID_NAME}
      - API_KEY=\${OPENWA_API_KEY}
    labels:
      com.example.site: \${SITE}
    ports:
      - "\${HOST_PORT:-8080}:80"
    mem_limit: \${MEM:-2g}
    volumes:
      - app-data:/data
volumes:
  app-data:
`);
  assert.deepEqual(r.errors, [], `legitimate interpolation must pass: ${JSON.stringify(r.errors)}`);
});

// ── APPS-021: a merge key written in FLOW style ─────────────────────────────────
// The detector was a line-anchored regex, so `services: {app: {<<: *tpl}}` slipped
// past it — and `yaml` parses with merging OFF, so the merged keys were invisible to
// the structured checks too. Detected structurally now: "<<" survives as a literal key.

test('APPS-021 a flow-style merge key is rejected', () => {
  const r = validateCompose(`
x-tpl: &tpl
  privileged: true
services: {app: {<<: *tpl, image: "ghcr.io/o/r:1.0.0"}}
`);
  assert.ok(r.errors.some((e) => e.includes('YAML merge key')), JSON.stringify(r.errors));
});

test('APPS-021 a merge nested deep inside a flow mapping is still found', () => {
  const r = validateCompose(`
x-a: &a {cap_add: [SYS_ADMIN]}
services:
  app:
    image: ghcr.io/o/r:1.0.0
    deploy: {resources: {limits: {<<: *a}}}
`);
  assert.ok(r.errors.some((e) => e.includes('YAML merge key')), JSON.stringify(r.errors));
});

test('APPS-021 block-style merges are still rejected (no regression)', () => {
  const r = validateCompose(`
x-tpl: &tpl
  image: ghcr.io/o/r:1.0.0
services:
  app:
    <<: *tpl
`);
  assert.ok(r.errors.some((e) => e.includes('YAML merge key')), JSON.stringify(r.errors));
});

test('APPS-021 an unparseable compose still reports a merge key from the raw scan', () => {
  const r = validateCompose('services:\n  app:\n    <<: *tpl\n  : : :\n   bad');
  assert.ok(r.errors.some((e) => e.includes('YAML merge key')), JSON.stringify(r.errors));
});

test('APPS-021 a compose with no merge key is not flagged', () => {
  const r = validateCompose(`
services:
  app:
    image: ghcr.io/o/r:1.0.0
    environment:
      - SHIFT=<<never>>
`);
  assert.equal(r.errors.some((e) => e.includes('YAML merge key')), false, JSON.stringify(r.errors));
});

// ── APPS-022 / APPS-023: the gate must not be switchable off by the file it polices ──

test('APPS-022 an unparseable compose is a hard ERROR, not a warning', () => {
  // It used to warn and return, and warn() in build-catalog.mjs only increments a
  // counter — so the build exited 0 and published the compose verbatim.
  const r = validateCompose(`
services:
  app:
    image: ghcr.io/o/r:1.0.0
  bad: [unclosed
`);
  assert.ok(
    r.errors.some((e) => /did not parse as YAML/.test(e)),
    'expected a hard error, got: ' + JSON.stringify(r),
  );
});

test('APPS-022 THE BYPASS: an alias bomb cannot disable the structured checks', () => {
  // `yaml` refuses a document with >99 alias nodes ("Excessive alias count"), while
  // Docker Compose's Go parser reads the same file happily. ~2 KB of aliases in an
  // unused `x-` key used to drop EVERY structured check — bind mounts, group_add,
  // external volumes, reserved labels, the secrets `file:` rule — and the build still
  // exited 0, publishing the compose to the file every masjid installs from.
  const bomb =
    'x-l: &a q\n' +
    'x-list:\n' +
    Array.from({ length: 200 }, () => '  - *a').join('\n') +
    '\n' +
    'services:\n' +
    '  app:\n' +
    '    image: ghcr.io/o/r:1.0.0\n' +
    '    volumes:\n' +
    '      - /:/hostfs\n' +
    '    group_add: [docker]\n';
  const r = validateCompose(bomb);
  assert.ok(r.errors.length > 0, 'an unreadable compose must never pass');
  assert.ok(r.errors.some((e) => /did not parse as YAML/.test(e)), JSON.stringify(r.errors));
});

test('APPS-022 a compose that DOES parse is unaffected — no false failure', () => {
  const r = validateCompose(`
services:
  app:
    image: ghcr.io/o/r:1.0.0@sha256:${'a'.repeat(64)}
    ports: ['8080:80']
    volumes:
      - data:/app/data
volumes:
  data:
`);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('APPS-023 an interpolated volume driver_opts device is refused', () => {
  // The literal form (type: none / o: bind / device: /) was already caught. The
  // interpolated one is resolved by Compose at install from the .env the platform
  // writes, so the catalog would be vouching for a host path it never saw.
  const r = validateCompose(`
services:
  app:
    image: ghcr.io/o/r:1.0.0
    volumes:
      - data:/x
volumes:
  data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: \${HOST_DIR}
`);
  assert.ok(
    r.errors.some((e) => /driver_opts\."device" is chosen at install time/.test(e)),
    'expected the interpolated device to be refused, got: ' + JSON.stringify(r.errors),
  );
});

test('APPS-023 a literal driver_opts bind is still refused (no regression)', () => {
  const r = validateCompose(`
services:
  app:
    image: ghcr.io/o/r:1.0.0
    volumes:
      - data:/x
volumes:
  data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /
`);
  assert.ok(r.errors.some((e) => /local-driver bind mount/.test(e)), JSON.stringify(r.errors));
});
