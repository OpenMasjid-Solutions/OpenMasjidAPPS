// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Tests for admin commands (scripts/commands.mjs).
 *
 * This validator is a MIRROR of OpenMasjidOS `parseCommands`
 * (packages/core/src/apps/manager.ts). The property that matters is not "does it
 * reject nonsense" — it is that it rejects and normalises EXACTLY what the platform
 * does. Where the two disagree, "passes the catalog build" stops meaning "installs
 * cleanly", and the divergence is discovered by a masjid at install time.
 *
 * So the clamps and the emit shape are asserted as literals below. If the platform
 * changes one, this file has to be edited deliberately — which is the point.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCommands,
  isReservedAppId,
  COMMANDS_CAPABILITY,
  COMMAND_LIMITS,
  MAX_APP_COMMANDS,
  RESERVED_APP_ID_WORDS,
  RESERVED_COMMAND_IDS,
} from '../commands.mjs';

const ok = (commands) => parseCommands(commands, 'students');
const boom = (commands, re) => assert.throws(() => parseCommands(commands, 'students'), re);

// ── the shape the docs promise ──────────────────────────────────────────────────

test('the documented example parses to the documented shape', () => {
  const out = ok([
    { id: 'whats-on', label: 'What&apos;s on the screen now', description: 'Reads back the current notice.' },
    { id: 'post-notice', label: 'Put a message on the screen', argument: { label: 'message', required: false }, confirm: true },
  ]);
  assert.deepEqual(out, [
    {
      id: 'whats-on',
      label: 'What&apos;s on the screen now',
      description: 'Reads back the current notice.',
      argument: undefined,
      confirm: undefined,
    },
    {
      id: 'post-notice',
      label: 'Put a message on the screen',
      description: undefined,
      argument: { label: 'message', required: false },
      confirm: true,
    },
  ]);
});

test('absent commands carry nothing, and neither does an empty list', () => {
  assert.equal(ok(undefined), undefined);
  assert.equal(ok(null), undefined);
  assert.equal(ok([]), undefined);
});

test('required defaults to true, so only an explicit false is carried', () => {
  assert.deepEqual(ok([{ id: 'a', label: 'A', argument: { label: 'msg' } }])[0].argument, { label: 'msg' });
  assert.deepEqual(ok([{ id: 'a', label: 'A', argument: { label: 'msg', required: true } }])[0].argument, { label: 'msg' });
  assert.deepEqual(ok([{ id: 'a', label: 'A', argument: { label: 'msg', required: false } }])[0].argument, {
    label: 'msg',
    required: false,
  });
});

test('confirm is carried only when it is exactly true', () => {
  assert.equal(ok([{ id: 'a', label: 'A', confirm: true }])[0].confirm, true);
  assert.equal(ok([{ id: 'a', label: 'A', confirm: false }])[0].confirm, undefined);
  assert.equal(ok([{ id: 'a', label: 'A' }])[0].confirm, undefined);
});

// ── THE TRAP: argument must not be coerced ──────────────────────────────────────

test('THE TRAP: argument: true is REJECTED, not read as "takes an argument"', () => {
  // `=== true ? true : undefined` — the shape the boolean capability flags use —
  // would accept this. It reads like "yes, it takes an argument" but carries no
  // label, and the platform would then discard whatever a volunteer typed while
  // telling them it worked.
  boom([{ id: 'a', label: 'A', argument: true }], /"argument" must be an object with a "label"/);
});

test('THE TRAP: argument as a bare string is REJECTED too', () => {
  boom([{ id: 'a', label: 'A', argument: 'message' }], /"argument" must be an object with a "label"/);
});

test('an argument object still needs a non-empty label', () => {
  boom([{ id: 'a', label: 'A', argument: {} }], /"argument" needs a "label"/);
  boom([{ id: 'a', label: 'A', argument: { label: '   ' } }], /"argument" needs a "label"/);
  boom([{ id: 'a', label: 'A', argument: { label: 42 } }], /"argument" needs a "label"/);
});

test('argument.required must be boolean, not "yes"', () => {
  boom([{ id: 'a', label: 'A', argument: { label: 'm', required: 'yes' } }], /"argument.required" must be true or false/);
});

test('an argument list is rejected — arrays are objects in JS, so this needs its own guard', () => {
  boom([{ id: 'a', label: 'A', argument: ['message'] }], /"argument" must be an object with a "label"/);
});

// ── ids ─────────────────────────────────────────────────────────────────────────

test('THE GRAMMAR: an all-digit id is refused, because `!display 2` means "the second option"', () => {
  boom([{ id: '2', label: 'Two' }], /cannot be all digits/);
  boom([{ id: '007', label: 'Bond' }], /cannot be all digits/);
  // ...but a digit-leading id that is not ALL digits is fine.
  assert.equal(ok([{ id: '2fa-reset', label: 'Reset 2FA' }])[0].id, '2fa-reset');
});

test('reserved command ids are refused — "stop" reads as unsubscribe on WhatsApp', () => {
  for (const id of RESERVED_COMMAND_IDS) {
    boom([{ id, label: 'X' }], /is reserved by OpenMasjidOS/);
  }
  assert.deepEqual([...RESERVED_COMMAND_IDS], ['help', 'yes', 'no', 'cancel', 'stop']);
});

test('ids are kebab-case and capped at 40 characters', () => {
  boom([{ id: 'Not-Kebab', label: 'X' }], /kebab-case "id"/);
  boom([{ id: 'has space', label: 'X' }], /kebab-case "id"/);
  boom([{ id: '-leading', label: 'X' }], /kebab-case "id"/);
  boom([{ id: 'a'.repeat(41), label: 'X' }], /kebab-case "id"/);
  assert.equal(ok([{ id: 'a'.repeat(40), label: 'X' }])[0].id.length, 40);
});

test('duplicate ids within one app are refused', () => {
  boom(
    [
      { id: 'a', label: 'First' },
      { id: 'a', label: 'Second' },
    ],
    /duplicate command id "a"/,
  );
});

test('a missing or non-string id is refused', () => {
  boom([{ label: 'X' }], /kebab-case "id"/);
  boom([{ id: 2, label: 'X' }], /kebab-case "id"/);
});

// ── labels, descriptions, and the clamp/throw asymmetry ─────────────────────────

test('a missing label is a hard error, but an over-long one is truncated', () => {
  // Throw on a wrong type or a missing required field; truncate on length. The same
  // asymmetry `alerts:` uses, on both sides.
  boom([{ id: 'a' }], /needs a "label"/);
  boom([{ id: 'a', label: '   ' }], /needs a "label"/);
  boom([{ id: 'a', label: 99 }], /needs a "label"/);
  assert.equal(ok([{ id: 'a', label: 'L'.repeat(200) }])[0].label.length, COMMAND_LIMITS.label);
});

test('a non-string description is refused; a long one is truncated', () => {
  boom([{ id: 'a', label: 'A', description: 42 }], /"description" that is not text/);
  assert.equal(ok([{ id: 'a', label: 'A', description: 'D'.repeat(500) }])[0].description.length, COMMAND_LIMITS.description);
});

test('an over-long argument label is truncated to 40, not 80', () => {
  // The argument label is clamped tighter than the command label. Getting this wrong
  // is invisible until a menu renders differently on the two sides.
  assert.equal(ok([{ id: 'a', label: 'A', argument: { label: 'x'.repeat(100) } }])[0].argument.label.length, 40);
  assert.equal(COMMAND_LIMITS.argumentLabel, 40);
});

test('labels and descriptions are trimmed', () => {
  const c = ok([{ id: 'a', label: '  A  ', description: '  D  ', argument: { label: '  m  ' } }])[0];
  assert.equal(c.label, 'A');
  assert.equal(c.description, 'D');
  assert.equal(c.argument.label, 'm');
});

test('confirm must be boolean', () => {
  boom([{ id: 'a', label: 'A', confirm: 'yes' }], /"confirm" that is not true or false/);
});

// ── list shape ──────────────────────────────────────────────────────────────────

test('commands must be a list of objects', () => {
  boom({ id: 'a' }, /"commands" must be a list/);
  boom('a', /"commands" must be a list/);
  boom(['a'], /each command must be an object/);
  boom([null], /each command must be an object/);
  boom([['a']], /each command must be an object/);
});

test('at most 12 commands — a longer numbered menu does not fit one message', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => ({ id: `c-${i}`, label: `C${i}` }));
  assert.equal(ok(twelve).length, 12);
  boom([...twelve, { id: 'c-12', label: 'C12' }], /at most 12 commands/);
  assert.equal(MAX_APP_COMMANDS, 12);
});

// ── reserved app ids ────────────────────────────────────────────────────────────

test('app ids that name the platform are reserved — an app called "os" would shadow !os', () => {
  for (const id of RESERVED_APP_ID_WORDS) assert.equal(isReservedAppId(id), true, `${id} must be reserved`);
  assert.deepEqual([...RESERVED_APP_ID_WORDS], ['os', 'omos', 'openmasjid', 'openmasjidos', 'platform', 'help']);
});

test('the reserved-id check is case-insensitive and safe on rubbish', () => {
  assert.equal(isReservedAppId('OS'), true);
  assert.equal(isReservedAppId('OpenMasjidOS'), true);
  assert.equal(isReservedAppId('students'), false);
  assert.equal(isReservedAppId('os-tools'), false); // only the whole id is reserved
  assert.equal(isReservedAppId(undefined), false);
  assert.equal(isReservedAppId(null), false);
});

// ── the reserved fabric capability ──────────────────────────────────────────────

test('"commands" is the reserved broker capability name', () => {
  // The builder refuses it in fabric.provides. Asserted here so the constant the two
  // sides agree on cannot drift silently.
  assert.equal(COMMANDS_CAPABILITY, 'commands');
});

// ── the app id is only used for messages, never for validation ──────────────────

test('a reserved app id does not change how its commands parse', () => {
  // The app id gates elsewhere (the registry entry is refused outright); parseCommands
  // must not quietly behave differently depending on who is calling.
  assert.deepEqual(parseCommands([{ id: 'a', label: 'A' }], 'help'), parseCommands([{ id: 'a', label: 'A' }], 'students'));
});
