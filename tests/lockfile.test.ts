import { describe, expect, test } from 'bun:test';
import type { EmittedRule } from '../src/types.ts';
import { reconcileLockfile, type LockfileMap } from '../src/compile/lockfile.ts';
import { ruleFingerprint } from '../src/util/fingerprint.ts';

function mk(name: string, search: string, overrides: Partial<EmittedRule> = {}): EmittedRule {
  return {
    name,
    combinator: 'all',
    conditions: null,
    search,
    markRead: false,
    markFlagged: false,
    showNotification: false,
    redirectTo: null,
    fileIn: null,
    skipInbox: false,
    snoozeUntil: null,
    discard: false,
    markSpam: false,
    stop: false,
    previousFileInName: null,
    created: '2026-04-18T10:00:00Z',
    updated: '2026-04-18T10:00:00Z',
    ...overrides,
  };
}

const NOW = '2026-04-18T12:00:00Z';
const EARLIER = '2026-04-01T00:00:00Z';

describe('reconcileLockfile', () => {
  test('fingerprint hit reuses created; keeps updated as-emitted', () => {
    const rule = mk('a', 'from:x');
    const fp = ruleFingerprint(rule);
    const prev: LockfileMap = { [fp]: { name: 'a', created: EARLIER, updated: EARLIER } };

    const { rules, lockfile } = reconcileLockfile([rule], prev, NOW);
    expect(rules[0]!.created).toBe(EARLIER);
    expect(rules[0]!.updated).toBe(EARLIER);
    expect(lockfile[fp]).toEqual({ name: 'a', created: EARLIER, updated: EARLIER });
  });

  test('name hit (fingerprint miss) reuses created; bumps updated', () => {
    const oldRule = mk('a', 'from:x');
    const oldFp = ruleFingerprint(oldRule);
    const newRule = mk('a', 'from:y'); // same name, new content
    const prev: LockfileMap = { [oldFp]: { name: 'a', created: EARLIER, updated: EARLIER } };

    const { rules, lockfile } = reconcileLockfile([newRule], prev, NOW);
    expect(rules[0]!.created).toBe(EARLIER);
    expect(rules[0]!.updated).toBe(NOW);

    const newFp = ruleFingerprint(newRule);
    expect(lockfile[newFp]).toEqual({ name: 'a', created: EARLIER, updated: NOW });
    expect(lockfile[oldFp]).toBeUndefined();
  });

  test('no match → both created and updated become now', () => {
    const rule = mk('fresh', 'from:x');
    const { rules } = reconcileLockfile([rule], {}, NOW);
    expect(rules[0]!.created).toBe(NOW);
    expect(rules[0]!.updated).toBe(NOW);
  });

  test('orphan entries (no corresponding rule) are dropped', () => {
    const rule = mk('kept', 'from:x');
    const keptFp = ruleFingerprint(rule);
    const orphanFp = 'a'.repeat(64);
    const prev: LockfileMap = {
      [keptFp]: { name: 'kept', created: EARLIER, updated: EARLIER },
      [orphanFp]: { name: 'gone', created: EARLIER, updated: EARLIER },
    };

    const { lockfile } = reconcileLockfile([rule], prev, NOW);
    expect(Object.keys(lockfile)).toEqual([keptFp]);
  });
});
