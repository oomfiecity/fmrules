import { describe, expect, test } from 'bun:test';
import { reconcileLockfile } from '../src/compile/lockfile.ts';
import { ruleFingerprint } from '../src/util/fingerprint.ts';
import type { EmittedRule } from '../src/types.ts';

function mkEmitted(name: string, overrides: Partial<EmittedRule> = {}): EmittedRule {
  return {
    name,
    isEnabled: true,
    combinator: 'all',
    conditions: null,
    search: `search-${name}`,
    filter: { from: name },
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
    created: '',
    updated: '',
    ...overrides,
  } as EmittedRule;
}

describe('reconcileLockfile — match order (fingerprint > name > new)', () => {
  const NOW = '2026-08-31T00:00:00.000Z';

  test('fingerprint hit preserves both created and updated', () => {
    const same = mkEmitted('r1');
    const prev = { [ruleFingerprint(same)]: { name: 'r1', created: 'OLD', updated: 'OLD2' } };
    const { rules, lockfile } = reconcileLockfile([same], prev, NOW);
    expect(rules[0]!.created).toBe('OLD');
    expect(rules[0]!.updated).toBe('OLD2');
    expect(lockfile[ruleFingerprint(same)]!.created).toBe('OLD');
  });

  test('name hit preserves created, refreshes updated', () => {
    const edited = mkEmitted('r1', { search: 'search-changed' });
    const original = mkEmitted('r1');
    const prev = { [ruleFingerprint(original)]: { name: 'r1', created: 'OLD', updated: 'OLD2' } };
    const { rules } = reconcileLockfile([edited], prev, NOW);
    expect(rules[0]!.created).toBe('OLD');
    expect(rules[0]!.updated).toBe(NOW);
  });

  test('no hit → both timestamps are now', () => {
    const fresh = mkEmitted('new-rule');
    const { rules } = reconcileLockfile([fresh], {}, NOW);
    expect(rules[0]!.created).toBe(NOW);
    expect(rules[0]!.updated).toBe(NOW);
  });

  test('orphaned lockfile entries are dropped', () => {
    const keep = mkEmitted('keep');
    const prev = {
      [ruleFingerprint(keep)]: { name: 'keep', created: 'OLD', updated: 'OLD2' },
      ['deadfingerprint']: { name: 'gone', created: 'OLD', updated: 'OLD2' },
    };
    const { lockfile } = reconcileLockfile([keep], prev, NOW);
    expect(Object.keys(lockfile)).toEqual([ruleFingerprint(keep)]);
  });

  test('generated sibling names (foo, foo#2) anchor the name-hit fallback', () => {
    const original1 = mkEmitted('foo');
    const original2 = mkEmitted('foo#2');
    const prev = {
      [ruleFingerprint(original1)]: { name: 'foo', created: 'T1', updated: 'T1' },
      [ruleFingerprint(original2)]: { name: 'foo#2', created: 'T2', updated: 'T2' },
    };
    // foo#2 is edited; foo is unchanged.
    const edited2 = mkEmitted('foo#2', { search: 'search-edited' });
    const { rules } = reconcileLockfile([original1, edited2], prev, NOW);
    expect(rules[1]!.created).toBe('T2');
    expect(rules[1]!.updated).toBe(NOW);
  });
});
