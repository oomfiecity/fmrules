import { describe, expect, test } from 'bun:test';
import { FIELDS } from '../src/schema/fields.ts';
import type { Actions, EmittedRule, Matchers } from '../src/types.ts';

// These no-op functions coerce a compile-time type into a runtime value we
// can introspect for key names. The type system guarantees the keys list
// matches the interface; the runtime body is irrelevant.
const matcherKeys: Array<keyof Matchers> = [
  'from',
  'to',
  'subject',
  'body',
  'header',
  'match',
  'list',
  'with',
  'text',
  'domain',
  'searchRaw',
];
const actionKeys: Array<keyof Actions> = [
  'skipInbox',
  'markRead',
  'markFlagged',
  'showNotification',
  'fileIn',
  'redirectTo',
  'snoozeUntil',
  'discard',
  'markSpam',
  'stop',
];
const emittedActionKeys: Array<keyof EmittedRule> = [
  'markRead',
  'markFlagged',
  'showNotification',
  'redirectTo',
  'fileIn',
  'skipInbox',
  'snoozeUntil',
  'discard',
  'markSpam',
  'stop',
];

describe('FIELDS registry', () => {
  test('every matcher row has a matching key on Matchers', () => {
    const matcherRows = FIELDS.filter((f) => f.kind === 'matcher');
    for (const f of matcherRows) {
      expect(matcherKeys).toContain(f.internal as keyof Matchers);
    }
  });

  test('every Matchers key is covered by a matcher row', () => {
    const internals = new Set(
      FIELDS.filter((f) => f.kind === 'matcher').map((f) => f.internal),
    );
    for (const k of matcherKeys) expect(internals.has(k)).toBe(true);
  });

  test('every action row has a matching key on Actions and EmittedRule', () => {
    const actionRows = FIELDS.filter((f) => f.kind === 'action');
    for (const f of actionRows) {
      expect(actionKeys).toContain(f.internal as keyof Actions);
      expect(emittedActionKeys).toContain(f.internal as keyof EmittedRule);
    }
  });

  test('every Actions key is covered by an action row', () => {
    const internals = new Set(
      FIELDS.filter((f) => f.kind === 'action').map((f) => f.internal),
    );
    for (const k of actionKeys) expect(internals.has(k)).toBe(true);
  });

  test('yaml names are unique and snake_case', () => {
    const seen = new Set<string>();
    for (const f of FIELDS) {
      expect(seen.has(f.yaml)).toBe(false);
      seen.add(f.yaml);
      expect(f.yaml).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  test('internal names are unique and camelCase', () => {
    const seen = new Set<string>();
    for (const f of FIELDS) {
      expect(seen.has(f.internal)).toBe(false);
      seen.add(f.internal);
      expect(f.internal).toMatch(/^[a-z][a-zA-Z0-9]*$/);
    }
  });
});
