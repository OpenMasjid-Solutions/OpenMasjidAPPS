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
test('unparseable YAML still rejects privileged and warns', () => {
  const { errors, warnings } = validateCompose('services:\n  a:\n    privileged: true\n  : : :\n\tbad');
  assert.ok(errors.some((e) => e.includes('privileged')));
  assert.ok(warnings.some((w) => w.includes('did not parse as YAML')));
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
  assert.ok(warnings.some((w) => w.includes('did not parse as YAML')));
  assert.ok(errors.some((e) => e.includes('privileged')));
});

test('empty and non-object documents do not throw', () => {
  for (const t of ['', '\n', 'null\n', '[]\n', '"just a string"\n', 'services:\n']) {
    assert.doesNotThrow(() => validateCompose(t), `threw on ${JSON.stringify(t)}`);
  }
});
