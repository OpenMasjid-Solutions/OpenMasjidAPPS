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
    return { errors: [...errors], warnings: [...warnings] };
  }

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

  // Top-level file-based secrets/configs bind a host file into the container.
  for (const [section, key] of [['secret', 'secrets'], ['config', 'configs']]) {
    const defs = doc[key] && typeof doc[key] === 'object' ? doc[key] : {};
    for (const [name, def] of Object.entries(defs)) {
      if (def && typeof def === 'object') checkFileSource(name, def.file, errors, section);
    }
  }

  return { errors: [...errors], warnings: [...warnings] };
}
