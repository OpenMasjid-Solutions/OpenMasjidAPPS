// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Admin commands (`commands:` in manifest.yaml).
 *
 * A masjid admin runs these by sending a WhatsApp message to the masjid's own number
 * — `!students`, `!display 2`. The PLATFORM decides who may run what, renders the
 * numbered menu, asks for confirmation and formats the reply; the app is only ever
 * asked to execute one command it declared.
 *
 * ── WHY THIS IS ITS OWN MODULE ──────────────────────────────────────────────────
 *
 * It is a MIRROR of OpenMasjidOS `parseCommands` (packages/core/src/apps/manager.ts),
 * and a mirror is only worth anything while it still matches. So it lives here, with
 * the platform's own signature — `parseCommands(commands, appId)`, throwing on a bad
 * shape — so the two can be read side by side, and so it can be unit-tested at all
 * (`build-catalog.mjs`'s `fail()` exits the process, which no test can catch).
 *
 * Where the two disagree, "passes the catalog build" stops meaning "installs
 * cleanly", and a masjid discovers the difference at install time. Keep them in step:
 * the clamps (label 80, description 200, argument.label 40) and the emit shape are
 * part of the contract, not incidental.
 *
 * THROW on a wrong type or a missing required field; TRUNCATE on length. That
 * asymmetry is deliberate — it is what `alerts:` already does on both sides.
 */

/** Matches the platform's CAPABILITY_RE and the catalog's, which are the same. */
const CAPABILITY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * The capability the platform uses to run an app's declared commands. RESERVED: an
 * app may not put it in `fabric.provides`.
 *
 * Both are served at `/fabric/commands/run`, but `commands:` is an ADMIN surface that
 * only the platform calls, whereas a `provides` entry would expose that same handler
 * to any other app through the broker (`consumes: ["<app>/commands"]`). Same path
 * prefix, very different trust boundary.
 */
export const COMMANDS_CAPABILITY = 'commands';

/**
 * Ids that name the PLATFORM rather than an app. A command's namespace IS the app id,
 * so an app called `os` would shadow `!os` in the chat. Mirrors OpenMasjidOS
 * RESERVED_ID_WORDS, which refuses them at install.
 */
export const RESERVED_APP_ID_WORDS = new Set(['os', 'omos', 'openmasjid', 'openmasjidos', 'platform', 'help']);

/** True if this id names the platform rather than an app. */
export function isReservedAppId(id) {
  return RESERVED_APP_ID_WORDS.has(String(id ?? '').toLowerCase());
}

/** Command ids that would collide with the platform's own words in a chat. */
export const RESERVED_COMMAND_IDS = new Set(['help', 'yes', 'no', 'cancel', 'stop']);

/** A numbered menu longer than this stops being a menu and stops fitting one message. */
export const MAX_APP_COMMANDS = 12;

/** Clamps. Part of the contract — the platform applies exactly these. */
export const COMMAND_LIMITS = { label: 80, description: 200, argumentLabel: 40 };

/**
 * Validate + normalise a manifest `commands:` list.
 *
 * @param commands the raw `m.commands` value (anything)
 * @param appId    the app id, for error messages
 * @returns the cleaned list, or `undefined` when there is nothing to carry
 * @throws Error on a malformed shape
 */
export function parseCommands(commands, appId) {
  if (commands == null) return undefined;
  if (!Array.isArray(commands)) throw new Error(`manifest "commands" must be a list`);
  if (commands.length > MAX_APP_COMMANDS) {
    throw new Error(
      `an app can offer at most ${MAX_APP_COMMANDS} commands (got ${commands.length}) — a longer numbered menu does not fit one message`,
    );
  }

  const out = [];
  const seen = new Set();

  for (const c of commands) {
    const obj = c && typeof c === 'object' && !Array.isArray(c) ? c : null;
    if (!obj) throw new Error(`each command must be an object with an "id" and a "label"`);
    const { id, label, description, argument, confirm } = obj;

    if (typeof id !== 'string' || !CAPABILITY_RE.test(id)) {
      throw new Error(`each command needs a kebab-case "id" (a-z, 0-9, -), max 40 chars`);
    }
    // An all-digit id is ambiguous with a menu selection: `!${appId} 2` must mean "the
    // second option" and nothing else. The parser's grammar depends on that holding at
    // the point people use most.
    if (/^\d+$/.test(id)) {
      throw new Error(`command id "${id}" cannot be all digits — it would be ambiguous with a menu selection`);
    }
    if (RESERVED_COMMAND_IDS.has(id)) {
      throw new Error(`command id "${id}" is reserved by OpenMasjidOS`);
    }
    if (seen.has(id)) throw new Error(`duplicate command id "${id}"`);
    seen.add(id);

    if (typeof label !== 'string' || !label.trim()) throw new Error(`command "${id}" needs a "label"`);
    if (description != null && typeof description !== 'string') {
      throw new Error(`command "${id}" has a "description" that is not text`);
    }
    if (confirm != null && typeof confirm !== 'boolean') {
      throw new Error(`command "${id}" has a "confirm" that is not true or false`);
    }

    // Deliberately strict, and NOT coerced. `argument: true` reads like "takes an
    // argument" but carries no label — the `=== true ? true : undefined` shape the
    // boolean capability flags use would happily accept it, and the platform would
    // then discard whatever a volunteer typed while telling them it worked.
    let arg;
    if (argument != null) {
      if (typeof argument !== 'object' || Array.isArray(argument)) {
        throw new Error(`command "${id}" — "argument" must be an object with a "label" (not true, not a string)`);
      }
      if (typeof argument.label !== 'string' || !argument.label.trim()) {
        throw new Error(`command "${id}" — "argument" needs a "label"`);
      }
      if (argument.required != null && typeof argument.required !== 'boolean') {
        throw new Error(`command "${id}" — "argument.required" must be true or false`);
      }
      arg = {
        label: argument.label.trim().slice(0, COMMAND_LIMITS.argumentLabel),
        // `required` defaults to TRUE, so only an explicit false is worth carrying.
        ...(argument.required === false ? { required: false } : {}),
      };
    }

    out.push({
      id,
      label: label.trim().slice(0, COMMAND_LIMITS.label),
      description: typeof description === 'string' ? description.trim().slice(0, COMMAND_LIMITS.description) : undefined,
      argument: arg,
      confirm: confirm === true ? true : undefined,
    });
  }

  return out.length ? out : undefined;
}
