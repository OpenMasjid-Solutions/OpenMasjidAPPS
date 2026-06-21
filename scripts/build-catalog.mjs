/**
 * Builds catalog.json by aggregating the app repositories listed in registry.yaml.
 *
 * Each app lives in its OWN repository. For every registry entry this script:
 *   1. fetches that repo's manifest.yaml and docker-compose.yml (at the pinned ref),
 *   2. validates the id / required fields / category and scans the compose for
 *      disallowed (dangerous) directives,
 *   3. rewrites icon/screenshots to absolute raw URLs in that repo,
 *   4. embeds the compose text as the entry's `compose` string,
 * then writes { apps: [...] } to catalog.json at the repo root — the exact file
 * and shape OpenMasjidOS fetches. The platform contract is unchanged; only the
 * SOURCE of each entry moved from local folders to external repos. See CLAUDE.md.
 *
 * Run: npm install && node scripts/build-catalog.mjs   (needs network access)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parse } from 'yaml';

const REGISTRY = 'registry.yaml';

// Must match OpenMasjidOS's isValidAppId — the platform drops invalid ids.
const APP_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const CATEGORIES = new Set(['displays', 'donations', 'community', 'quran', 'admin', 'utilities']);

// Compose directives we refuse to publish. The platform also warns on these, but
// the catalog should never ship a stack that asks for host-level privilege.
const DANGEROUS = [
  { re: /\bprivileged:\s*true\b/, why: 'privileged: true' },
  { re: /\bnetwork_mode:\s*["']?host\b/, why: 'network_mode: host' },
  { re: /\bpid:\s*["']?host\b/, why: 'pid: host' },
  { re: /\bipc:\s*["']?host\b/, why: 'ipc: host' },
  { re: /\bcap_add\s*:/, why: 'cap_add' },
  { re: /\/var\/run\/docker\.sock/, why: 'mounting the Docker socket' },
];

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// raw.githubusercontent.com base for a repo/ref (+ optional subpath), trailing slash.
function rawBase(repo, ref, path) {
  const sub = path ? `${String(path).replace(/^\/+|\/+$/g, '')}/` : '';
  return `https://raw.githubusercontent.com/${repo}/${ref}/${sub}`;
}

let registry = { apps: [] };
if (existsSync(REGISTRY)) {
  try {
    registry = parse(readFileSync(REGISTRY, 'utf8')) ?? { apps: [] };
  } catch (e) {
    fail(`${REGISTRY} is not valid YAML — ${e.message}`);
  }
}
const entries = Array.isArray(registry.apps) ? registry.apps : [];

const apps = [];
const seen = new Set();

for (const entry of entries) {
  const { id, repo, ref = 'main', path } = entry || {};
  if (!id || !repo) fail(`registry entry is missing "id" or "repo": ${JSON.stringify(entry)}`);
  if (!APP_ID_RE.test(id)) fail(`${id}: invalid id — use kebab-case (a-z, 0-9, -), max 80 chars`);
  if (seen.has(id)) fail(`duplicate id in registry: ${id}`);
  seen.add(id);

  const base = rawBase(repo, ref, path);

  let manifestText, composeText;
  try {
    manifestText = await fetchText(base + 'manifest.yaml');
  } catch (e) {
    fail(`${id}: could not fetch manifest.yaml from ${repo}@${ref} (${e.message})`);
  }
  try {
    composeText = await fetchText(base + 'docker-compose.yml');
  } catch (e) {
    fail(`${id}: could not fetch docker-compose.yml from ${repo}@${ref} (${e.message})`);
  }

  let m;
  try {
    m = parse(manifestText) ?? {};
  } catch (e) {
    fail(`${id}: manifest.yaml is not valid YAML — ${e.message}`);
  }

  if (m.id !== id) fail(`${id}: manifest id "${m.id}" must equal the registry id "${id}"`);
  if (!m.name) fail(`${id}: manifest "name" is required`);
  if (!m.version) fail(`${id}: manifest "version" is required`);
  if (m.category && !CATEGORIES.has(m.category)) {
    fail(`${id}: unknown category "${m.category}" (use: ${[...CATEGORIES].join(', ')})`);
  }
  for (const { re, why } of DANGEROUS) {
    if (re.test(composeText)) fail(`${id}: docker-compose.yml requests "${why}", which is not allowed. See CLAUDE.md §security.`);
  }

  apps.push({
    id,
    name: m.name,
    tagline: m.tagline,
    category: m.category,
    version: String(m.version),
    author: m.author,
    license: m.license,
    icon: m.icon ? base + String(m.icon).replace(/^\/+/, '') : undefined,
    screenshots: Array.isArray(m.screenshots)
      ? m.screenshots.map((s) => base + String(s).replace(/^\/+/, ''))
      : undefined,
    description: m.description,
    settings: m.settings,
    ports: m.ports,
    compose: composeText,
  });
  console.log(`✓ ${id} ← ${repo}@${ref}`);
}

apps.sort((a, b) => a.name.localeCompare(b.name));
// Drop undefined keys for a tidy catalog.
const clean = apps.map((a) => JSON.parse(JSON.stringify(a)));
writeFileSync('catalog.json', JSON.stringify({ apps: clean }, null, 2) + '\n');
console.log(`✓ Built catalog.json with ${clean.length} app(s).`);
