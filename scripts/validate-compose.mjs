// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Hasan Ismail
/**
 * validate-compose.mjs — the catalog's compose-safety check.
 *
 * The catalog VOUCHES for every app it lists: the platform installs whatever
 * compose ends up in catalog.json. A compromised or careless app repo must not be
 * able to put an over-privileged stack in front of every OpenMasjidOS user, so we
 * reject dangerous composes at build time. This mirrors the platform's install-
 * time risk check (OpenMasjidOS apps/compose-validate.ts) so that
 * "passes the catalog build" === "installs on the platform".
 *
 * validateCompose(text) -> { errors: string[], warnings: string[] }
 *   errors   → the build must FAIL (a dangerous, host-reaching directive).
 *   warnings → surfaced but non-fatal (e.g. a plain bind mount of a host path).
 *
 * It parses the YAML for structured checks and also scans the raw text, so it
 * still catches the worst directives even if the document fails to parse.
 */
import { parse } from 'yaml';

// Absolute host paths that must never be bind-mounted into an app container.
const SENSITIVE_ROOTS = [
  '/etc', '/root', '/var', '/proc', '/sys', '/boot', '/dev', '/home',
  '/usr', '/bin', '/sbin', '/lib', '/lib64', '/run', '/srv', '/opt', '/mnt', '/media',
];

function classifyVolumeSource(src) {
  // Returns 'named' | 'sock' | 'escape' | 'sensitive' | 'host' (other absolute/path bind).
  const p = String(src).trim();
  if (p.includes('docker.sock')) return 'sock';
  const pathy = p.includes('/') || p.startsWith('.') || p.startsWith('~') || /^[A-Za-z]:[\\/]/.test(p);
  if (!pathy) return 'named';
  if (p.includes('..')) return 'escape';
  if (p === '/' || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('~')) return 'sensitive';
  if (p.startsWith('/')) {
    if (SENSITIVE_ROOTS.some((r) => p === r || p.startsWith(r + '/'))) return 'sensitive';
    return 'host'; // some other absolute host bind — discouraged, not fatal
  }
  return 'host'; // relative bind (./data) — discouraged, not fatal
}

// Docker Compose coerces true/yes/on/1/y (and the number 1) to boolean true, so
// a strict `=== true` check missed `privileged: yes|on|1|"true"`.
function isTruthyFlag(v) {
  if (v === true) return true;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return /^(true|yes|on|1|y)$/i.test(v.trim());
  return false;
}

// A file-based secret/config (`file:`) is bind-mounted from the host, so treat
// its source like a bind mount: socket/escape/sensitive host paths are fatal.
function checkFileSource(name, file, errors, section) {
  if (typeof file !== 'string' || !file) return;
  switch (classifyVolumeSource(file)) {
    case 'sock':
      errors.add(`${section} "${name}": file source is the Docker socket ("${file}")`);
      break;
    case 'escape':
      errors.add(`${section} "${name}": file source escapes the app folder with ".." ("${file}")`);
      break;
    case 'sensitive':
      errors.add(`${section} "${name}": file source is a sensitive host path ("${file}")`);
      break;
    default:
      break; // relative/in-folder file — fine
  }
}

function checkVolumeEntry(v, errors, warnings, where) {
  let source;
  if (typeof v === 'string') {
    const parts = v.split(':');
    if (parts.length === 1) return; // anonymous volume — fine
    source = parts[0];
  } else if (v && typeof v === 'object') {
    if (v.type === 'tmpfs') return;
    source = v.source;
    if (!source) return;
  } else {
    return;
  }
  switch (classifyVolumeSource(source)) {
    case 'sock':
      errors.add(`${where}: mounts the Docker socket ("${source}") — grants full host control`);
      break;
    case 'escape':
      errors.add(`${where}: bind mount escapes the app folder with ".." ("${source}")`);
      break;
    case 'sensitive':
      errors.add(`${where}: bind-mounts a sensitive host path ("${source}")`);
      break;
    case 'host':
      warnings.add(`${where}: bind-mounts a host path ("${source}") — prefer a named volume`);
      break;
    default:
      break; // named — fine
  }
}

// A merge key hides configuration the structured checks would otherwise see, which
// is why it is refused outright. Detecting it with a LINE regex only catches BLOCK
// style: written inside a flow mapping — `services: {app: {<<: *tpl}}` — the "<<"
// never starts a line. The `yaml` package parses with YAML-1.2 core-schema
// semantics, where merging is OFF by default, so "<<" survives as a LITERAL KEY in
// the parsed tree. Walking for that key catches every spelling at once.
function findsMergeKey(node, depth = 0) {
  if (depth > 100 || node == null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((v) => findsMergeKey(v, depth + 1));
  for (const [k, v] of Object.entries(node)) {
    if (k === '<<') return true;
    if (findsMergeKey(v, depth + 1)) return true;
  }
  return false;
}

// Positions where an install-time ${VAR} would let an app choose something the
// catalog has just promised a masjid it does not do. Compose interpolates these from
// the .env the platform writes, so `privileged: ${HW:-true}` resolves to
// `privileged: true` on the masjid's host while this validator sees only the literal
// string "${HW:-true}" — which isTruthyFlag() correctly calls falsy, and
// classifyVolumeSource() reads as a harmless named volume. Verified with
// `docker compose config`: the resolved stack really does get privileged: true,
// network_mode: host and a bind of "/".
//
// Interpolation stays legal where it is MEANT to be used — `environment:`, label
// values and `ports:` — because that is the whole mechanism by which a masjid's
// install-time answers reach the container.
const UNSAFE_INTERP_KEYS = [
  'privileged', 'network_mode', 'pid', 'ipc', 'userns_mode', 'cgroup', 'uts',
  'cgroup_parent', 'env_file', 'cap_add', 'devices', 'device_cgroup_rules',
  'security_opt', 'group_add', 'volumes_from', 'user',
];
const hasInterp = (v) => typeof v === 'string' && v.includes('${');
function interpProblems(doc, errors) {
  const services = doc && typeof doc.services === 'object' && !Array.isArray(doc.services) ? doc.services : {};
  for (const [name, svcRaw] of Object.entries(services)) {
    const svc = svcRaw && typeof svcRaw === 'object' && !Array.isArray(svcRaw) ? svcRaw : {};
    for (const key of UNSAFE_INTERP_KEYS) {
      const v = svc[key];
      if (v == null) continue;
      const values = Array.isArray(v) ? v : [v];
      if (values.some(hasInterp)) {
        errors.add(
          'service "' + name + '": "' + key + '" is chosen at install time with ${...} — ' +
            'the catalog cannot vouch for a value it never sees. Write the literal you mean.',
        );
      }
    }
    // A volume entry that is assembled at install time cannot be judged here at all:
    // splitting "${DATA_DIR:-/}:/hostdata" on ":" does not even recover the source,
    // because the default value contains one. So any interpolation anywhere in a
    // volumes entry is refused, and the whole entry is quoted back.
    const vols = Array.isArray(svc.volumes) ? svc.volumes : [];
    for (const entry of vols) {
      const shown = typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? String(entry.source ?? '') : '';
      const interp = typeof entry === 'string' ? hasInterp(entry) : entry && typeof entry === 'object' ? hasInterp(entry.source) : false;
      if (interp) {
        errors.add(
          'service "' + name + '": a volume is assembled at install time with ${...} ("' +
            shown + '") — it could resolve to any host path',
        );
      }
    }
  }
  // A top-level volume or network that names or adopts something at install time
  // escapes the "a listed app owns its storage" rule the same way.
  for (const section of ['volumes', 'networks']) {
    const block = doc && typeof doc[section] === 'object' && !Array.isArray(doc[section]) ? doc[section] : {};
    for (const [name, defRaw] of Object.entries(block)) {
      const def = defRaw && typeof defRaw === 'object' && !Array.isArray(defRaw) ? defRaw : {};
      for (const key of ['name', 'external', 'driver']) {
        if (hasInterp(def[key])) {
          errors.add(
            (section === 'volumes' ? 'volume "' : 'network "') + name + '": "' + key +
              '" is chosen at install time with ${...}',
          );
        }
      }
    }
  }
}

export function validateCompose(text) {
  const errors = new Set();
  const warnings = new Set();

  // --- Raw-text scans (work even if YAML parsing fails) --------------------
  // The previous pattern was /(^|\n)\s*<<\s*:/. Because \s also matches \n, the
  // (^|\n) alternation and \s* overlapped: a match could start at every newline
  // and \s* then ran to end-of-input before failing, giving quadratic behaviour on
  // attacker-controlled compose text (measured: 102ms at 20 KB, 6.4s at 160 KB,
  // ~4 min at 1 MB). The anchored form below is linear and matches the same
  // directive — a merge key can only be preceded by spaces/tabs on its line. (APPS-007)
  // Kept as the PARSE-FAILURE fallback only: when the document parses, the
  // structural walk below is authoritative, because it also sees flow style.
  let mergeSeen = /^[ \t]*<<[ \t]*:/m.test(text);
  if (/\/var\/run\/docker\.sock/.test(text)) {
    errors.add('references the Docker socket (/var/run/docker.sock)');
  }

  let doc;
  try {
    doc = parse(text) ?? {};
    if (findsMergeKey(doc)) mergeSeen = true;
    interpProblems(doc, errors);
  } catch (e) {
    // Couldn't parse — fall back to coarse regexes so we still reject the worst.
    const RAW = [
      [/\bprivileged:\s*["']?(true|yes|on|1|y)\b/i, 'privileged (full host access)'],
      [/\bvolumes_from\s*:/, 'volumes_from (inherits another container\'s mounts)'],
      [/\benv_file\s*:\s*["']?(\/|[^\n]*\.\.)/, 'env_file outside the app folder'],
      [/\bnetwork_mode:\s*["']?(host|container:)/, 'host/container network_mode'],
      [/\b(pid|ipc):\s*["']?(host|container:)/, 'host/container pid or ipc namespace'],
      [/\b(userns_mode|cgroup|uts):\s*["']?host\b/, 'host namespace'],
      [/\bcap_add\s*:/, 'cap_add'],
      [/\bdevices\s*:/, 'devices (host device passthrough)'],
      [/\bdevice_cgroup_rules\s*:/, 'device_cgroup_rules'],
      [/\bunconfined\b/i, 'security_opt: unconfined'],
      [/\bextends\s*:/, 'extends'],
      [/^\s*include\s*:/m, 'include'],
      [/^\s*build\s*:/m, 'build (must ship a pre-built image)'],
    ];
    for (const [re, why] of RAW) if (re.test(text)) errors.add(why);
    warnings.add(`compose did not parse as YAML (${e.message}); ran coarse checks only`);
    if (mergeSeen) errors.add('uses a YAML merge key ("<<:") — merges config the safety check cannot see');
    return { errors: [...errors], warnings: [...warnings] };
  }

  if (mergeSeen) errors.add('uses a YAML merge key ("<<:") — merges config the safety check cannot see');

  if (doc.include !== undefined) errors.add('top-level "include" merges config the safety check cannot see');

  const services = doc.services && typeof doc.services === 'object' ? doc.services : {};
  for (const [name, svc] of Object.entries(services)) {
    if (!svc || typeof svc !== 'object') continue;
    const where = `service "${name}"`;
    const str = (v) => (v == null ? '' : String(v));

    if (isTruthyFlag(svc.privileged)) errors.add(`${where}: privileged (full host access)`);

    // volumes_from copies another container's mounts — it can inherit the core's
    // Docker socket + data dir. No listed app needs it.
    if (svc.volumes_from && (!Array.isArray(svc.volumes_from) || svc.volumes_from.length)) {
      errors.add(`${where}: volumes_from copies another container's mounts (can inherit the Docker socket + data dir)`);
    }

    // env_file is read relative to the compose file's folder; an absolute path or
    // one containing ".." escapes the app folder and can read other apps'/the
    // platform's secrets into this container's environment.
    for (const ef of Array.isArray(svc.env_file) ? svc.env_file : svc.env_file != null ? [svc.env_file] : []) {
      const p = typeof ef === 'string' ? ef : ef && typeof ef === 'object' ? String(ef.path ?? '') : '';
      if (p && (p.trim().startsWith('/') || p.includes('..'))) {
        errors.add(`${where}: env_file reads outside the app folder ("${p}")`);
      }
    }

    const nm = str(svc.network_mode);
    if (nm === 'host' || nm.startsWith('container:')) errors.add(`${where}: network_mode "${nm}" (host/other-container network namespace)`);

    for (const k of ['pid', 'ipc']) {
      const v = str(svc[k]);
      if (v === 'host' || v.startsWith('container:')) errors.add(`${where}: ${k} "${v}" (host/other-container namespace)`);
    }
    for (const k of ['userns_mode', 'cgroup', 'uts']) {
      if (str(svc[k]) === 'host') errors.add(`${where}: ${k}: host`);
    }

    // These three were gated on Array.isArray(), so a scalar value skipped the
    // check entirely while `devices` and `volumes_from` handled both shapes. Docker
    // Compose does reject a scalar here ("must be a array"), so it was never an
    // exploitable bypass — but CLAUDE.md §10 requires lockstep with the platform's
    // separate validator, and a safety check must not depend on YAML shape. (APPS-012)
    const toList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

    const capAdd = toList(svc.cap_add);
    if (capAdd.length) errors.add(`${where}: cap_add ${JSON.stringify(capAdd)}`);
    if (svc.devices && (!Array.isArray(svc.devices) || svc.devices.length)) errors.add(`${where}: devices (host device passthrough)`);
    if (svc.device_cgroup_rules) errors.add(`${where}: device_cgroup_rules`);
    if (toList(svc.security_opt).some((s) => str(s).includes('unconfined'))) {
      errors.add(`${where}: security_opt unconfined`);
    }
    if (toList(svc.group_add).some((g) => ['root', 'docker', '0', 0].includes(g))) {
      errors.add(`${where}: group_add of a privileged group (root/docker)`);
    }

    // cgroup_parent places the container outside the cgroup slice the platform
    // assigns it, escaping the memory/CPU limits that keep a Raspberry Pi alive.
    // The validator already rejects `cgroup: host`; this is the same class. (APPS-011)
    if (svc.cgroup_parent != null && String(svc.cgroup_parent).trim() !== '') {
      errors.add(`${where}: cgroup_parent "${svc.cgroup_parent}" escapes the platform's cgroup limits`);
    }
    // Docker only permits namespaced sysctls without --privileged, so the reach is
    // the container's own namespace: worth surfacing, not worth failing an app over.
    if (svc.sysctls && (typeof svc.sysctls === 'object' || String(svc.sysctls).trim())) {
      warnings.add(`${where}: sets sysctls — kernel tunables should not be needed by a masjid app`);
    }
    if (svc.build !== undefined) errors.add(`${where}: "build" — apps must reference a pre-built, published image, not build on the host`);
    if (svc.extends !== undefined) errors.add(`${where}: "extends" merges config the safety check cannot see`);

    if (Array.isArray(svc.volumes)) {
      for (const v of svc.volumes) checkVolumeEntry(v, errors, warnings, where);
    }
  }

  // Top-level named volumes that are actually host binds via the local driver,
  // or that attach to an ALREADY-EXISTING Docker volume.
  const topVols = doc.volumes && typeof doc.volumes === 'object' ? doc.volumes : {};
  for (const [name, def] of Object.entries(topVols)) {
    if (!def || typeof def !== 'object') continue;
    const o = def.driver_opts || {};
    const type = String(o.type || '').toLowerCase();
    const oo = String(o.o || '').toLowerCase();
    if (type === 'bind' || type === 'none' || /\bbind\b/.test(oo)) {
      errors.add(`volume "${name}": local-driver bind mount to the host (${o.device || 'device unset'})`);
    }
    // `external: true` uses the volume name verbatim and `name:` overrides the
    // project-scoped name, so either can attach to ANOTHER app's data without
    // ever naming a host path — classifyVolumeSource() sees only "named" and
    // waves it through. Every OpenMasjid app's data lives in an `omos-*` volume.
    // Mirrors OpenMasjidOS apps/compose-validate.ts checkExternalVolumes().
    const isExternal = isTruthyFlag(def.external) || (!!def.external && typeof def.external === 'object');
    const explicit =
      typeof def.name === 'string'
        ? def.name
        : def.external && typeof def.external === 'object' && typeof def.external.name === 'string'
          ? def.external.name
          : null;
    if (!isExternal && explicit == null) continue;
    const target = String(explicit ?? name).trim();
    if (/^omos[-_]/i.test(target)) {
      errors.add(`volume "${name}": attaches to another OpenMasjid app's data volume ("${target}")`);
    } else {
      errors.add(
        `volume "${name}": attaches to a pre-existing Docker volume ("${target}") — a listed app must own its storage`,
      );
    }
  }

  // Top-level networks. This mirrors the external-volume rule above, for the same
  // reason: `external: true` uses the network name verbatim and `name:` overrides
  // the project-scoped name, so either attaches the app to a network it does not
  // own — including the platform's own internal network, where the core API and
  // other apps' containers live. classifyVolumeSource() never sees a network, so
  // nothing caught this before. A listed app must own its network exactly as it
  // must own its storage. Mirrors OpenMasjidOS apps/compose-validate.ts. (APPS-002)
  const topNets = doc.networks && typeof doc.networks === 'object' ? doc.networks : {};
  const declaredNets = new Set(Object.keys(topNets));
  for (const [name, def] of Object.entries(topNets)) {
    if (!def || typeof def !== 'object') continue; // `mynet:` with an empty body — project-scoped, fine

    const driver = String(def.driver ?? '').toLowerCase();
    if (driver === 'host' || driver === 'none') {
      errors.add(`network "${name}": driver "${driver}" bypasses network isolation`);
    }

    const isExternal = isTruthyFlag(def.external) || (!!def.external && typeof def.external === 'object');
    const explicit =
      typeof def.name === 'string'
        ? def.name
        : def.external && typeof def.external === 'object' && typeof def.external.name === 'string'
          ? def.external.name
          : null;
    if (!isExternal && explicit == null) continue;
    const target = String(explicit ?? name).trim();
    if (/^omos[-_]/i.test(target)) {
      errors.add(
        `network "${name}": attaches to an OpenMasjid platform network ("${target}") — that reaches the core and other apps' containers`,
      );
    } else {
      errors.add(
        `network "${name}": attaches to a pre-existing Docker network ("${target}") — a listed app must own its network`,
      );
    }
  }

  // A service must not join a network the file never declares: compose resolves it
  // against pre-existing networks instead of creating a project-scoped one.
  for (const [name, svc] of Object.entries(services)) {
    if (!svc || typeof svc !== 'object') continue;
    const nets = Array.isArray(svc.networks)
      ? svc.networks
      : svc.networks && typeof svc.networks === 'object'
        ? Object.keys(svc.networks)
        : [];
    for (const n of nets) {
      const key = typeof n === 'string' ? n : null;
      if (key && key !== 'default' && !declaredNets.has(key)) {
        errors.add(`service "${name}": joins network "${key}" without declaring it under top-level "networks:"`);
      }
    }
  }

  // Discovery labels are platform-internal: CLAUDE.md §4C forbids them and
  // docs/BUILDING_AN_APP.md states they are "Rejected at build AND at install" —
  // but nothing here ever looked at labels, so the documented guarantee was not
  // real. An app that declares another app's compose project label can confuse
  // platform inventory, lifecycle and uninstall. (APPS-004)
  const RESERVED_LABEL = /^(com\.docker\.compose\.|com\.openmasjid\.)/i;
  const checkLabels = (labels, where) => {
    if (!labels) return;
    // Compose accepts both the map form and the list form ("k=v").
    const keys = Array.isArray(labels)
      ? labels.map((l) => String(l).split('=')[0].trim())
      : typeof labels === 'object'
        ? Object.keys(labels)
        : [];
    for (const k of keys) {
      if (RESERVED_LABEL.test(k)) {
        errors.add(`${where}: sets the platform-internal label "${k}" — these are reserved for OpenMasjidOS`);
      }
    }
  };
  for (const [name, s] of Object.entries(services)) {
    if (!s || typeof s !== 'object') continue;
    checkLabels(s.labels, `service "${name}"`);
    // build: is rejected elsewhere, but its labels would apply to the image too.
    if (s.build && typeof s.build === 'object') checkLabels(s.build.labels, `service "${name}" build`);
  }
  for (const [key, section] of [
    ['network', doc.networks],
    ['volume', doc.volumes],
    ['secret', doc.secrets],
    ['config', doc.configs],
  ]) {
    if (!section || typeof section !== 'object') continue;
    for (const [name, def] of Object.entries(section)) {
      if (def && typeof def === 'object') checkLabels(def.labels, `${key} "${name}"`);
    }
  }

  // Top-level file-based secrets/configs bind a host file into the container.
  for (const [section, key] of [['secret', 'secrets'], ['config', 'configs']]) {
    const defs = doc[key] && typeof doc[key] === 'object' ? doc[key] : {};
    for (const [name, def] of Object.entries(defs)) {
      if (def && typeof def === 'object') checkFileSource(name, def.file, errors, section);
    }
  }

  return { errors: [...errors], warnings: [...warnings] };
}
