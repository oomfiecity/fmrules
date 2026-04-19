import { describe, expect, test } from 'bun:test';
import type { EmittedRule } from '../src/types.ts';
import { ruleFingerprint } from '../src/util/fingerprint.ts';

function baseRule(overrides: Partial<EmittedRule> = {}): EmittedRule {
  return {
    name: 'test',
    combinator: 'all',
    conditions: null,
    search: 'from:x',
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
    created: '2024-01-01T00:00:00Z',
    updated: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('ruleFingerprint', () => {
  test('same content → same fingerprint', () => {
    expect(ruleFingerprint(baseRule())).toBe(ruleFingerprint(baseRule()));
  });

  test('name change → different fingerprint', () => {
    expect(ruleFingerprint(baseRule())).not.toBe(
      ruleFingerprint(baseRule({ name: 'other' })),
    );
  });

  test('search change → different fingerprint', () => {
    expect(ruleFingerprint(baseRule())).not.toBe(
      ruleFingerprint(baseRule({ search: 'from:y' })),
    );
  });

  test('action change → different fingerprint', () => {
    expect(ruleFingerprint(baseRule())).not.toBe(
      ruleFingerprint(baseRule({ markRead: true })),
    );
  });

  test('timestamps do NOT affect fingerprint', () => {
    const a = baseRule();
    const b = baseRule({ created: '1999-01-01T00:00:00Z', updated: '1999-01-01T00:00:00Z' });
    expect(ruleFingerprint(a)).toBe(ruleFingerprint(b));
  });

  test('isEnabled does NOT affect fingerprint when value matches default', () => {
    const a = baseRule();
    const b = baseRule({ isEnabled: true });
    expect(ruleFingerprint(a)).toBe(ruleFingerprint(b));
  });
});
