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

export function validateCompose(text) {
  const errors = new Set();
  const warnings = new Set();

  // --- Raw-text scans (work even if YAML parsing fails) --------------------
  if (/(^|\n)\s*<<\s*:/.test(text)) {
    errors.add('uses a YAML merge key ("<<:") — merges config the safety check cannot see');
  }
  if (/\/var\/run\/docker\.sock/.test(text)) {
    errors.add('references the Docker socket (/var/run/docker.sock)');
  }

  let doc;
  try {
    doc = parse(text) ?? {};
  } catch (e) {
    // Couldn't parse — fall back to coarse regexes so we still reject the worst.
    const RAW = [
      [/\bprivileged:\s*true\b/, 'privileged: true'],
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
    return { errors: [...errors], warnings: [...warnings] };
  }

  if (doc.include !== undefined) errors.add('top-level "include" merges config the safety check cannot see');

  const services = doc.services && typeof doc.services === 'object' ? doc.services : {};
  for (const [name, svc] of Object.entries(services)) {
    if (!svc || typeof svc !== 'object') continue;
    const where = `service "${name}"`;
    const str = (v) => (v == null ? '' : String(v));

    if (svc.privileged === true) errors.add(`${where}: privileged: true`);

    const nm = str(svc.network_mode);
    if (nm === 'host' || nm.startsWith('container:')) errors.add(`${where}: network_mode "${nm}" (host/other-container network namespace)`);

    for (const k of ['pid', 'ipc']) {
      const v = str(svc[k]);
      if (v === 'host' || v.startsWith('container:')) errors.add(`${where}: ${k} "${v}" (host/other-container namespace)`);
    }
    for (const k of ['userns_mode', 'cgroup', 'uts']) {
      if (str(svc[k]) === 'host') errors.add(`${where}: ${k}: host`);
    }

    if (Array.isArray(svc.cap_add) && svc.cap_add.length) errors.add(`${where}: cap_add ${JSON.stringify(svc.cap_add)}`);
    if (svc.devices && (!Array.isArray(svc.devices) || svc.devices.length)) errors.add(`${where}: devices (host device passthrough)`);
    if (svc.device_cgroup_rules) errors.add(`${where}: device_cgroup_rules`);
    if (Array.isArray(svc.security_opt) && svc.security_opt.some((s) => str(s).includes('unconfined'))) {
      errors.add(`${where}: security_opt unconfined`);
    }
    if (Array.isArray(svc.group_add) && svc.group_add.some((g) => ['root', 'docker', '0', 0].includes(g))) {
      errors.add(`${where}: group_add of a privileged group (root/docker)`);
    }
    if (svc.build !== undefined) errors.add(`${where}: "build" — apps must reference a pre-built, published image, not build on the host`);
    if (svc.extends !== undefined) errors.add(`${where}: "extends" merges config the safety check cannot see`);

    if (Array.isArray(svc.volumes)) {
      for (const v of svc.volumes) checkVolumeEntry(v, errors, warnings, where);
    }
  }

  // Top-level named volumes that are actually host binds via the local driver.
  const topVols = doc.volumes && typeof doc.volumes === 'object' ? doc.volumes : {};
  for (const [name, def] of Object.entries(topVols)) {
    if (!def || typeof def !== 'object') continue;
    const o = def.driver_opts || {};
    const type = String(o.type || '').toLowerCase();
    const oo = String(o.o || '').toLowerCase();
    if (type === 'bind' || type === 'none' || /\bbind\b/.test(oo)) {
      errors.add(`volume "${name}": local-driver bind mount to the host (${o.device || 'device unset'})`);
    }
  }

  return { errors: [...errors], warnings: [...warnings] };
}
