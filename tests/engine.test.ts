import { describe, expect, test } from 'bun:test';
import { computeUpdates, collectRuleLabels, describeActions } from '../src/live/engine.ts';
import type { Actions } from '../src/types.ts';
import type { ExpandedRule } from '../src/compile/expand.ts';

// ExpandedRule carries the source Rule; the engine only reads name/actions/
// continueFlag, so build a minimal stand-in for tests.
function mkRule(partial: { name?: string; actions?: Actions; continueFlag?: boolean }): ExpandedRule {
  return {
    name: partial.name ?? 'r',
    source: {} as ExpandedRule['source'],
    when: { kind: 'always' },
    resolvedCondition: null,
    actions: partial.actions ?? {},
    continueFlag: partial.continueFlag ?? false,
    indexInExpansion: 0,
    expansionSize: 1,
  } as ExpandedRule;
}

const M = { label: 'L1', scope: 'INBOX', junk: 'JUNK', trash: 'TRASH' };

function state(mailboxIds: string[], keywords: string[] = ['$seen']) {
  return {
    mailboxIds: Object.fromEntries(mailboxIds.map((m) => [m, true])),
    keywords: Object.fromEntries(keywords.map((k) => [k, true])),
  };
}

describe('computeUpdates — PatchObject form', () => {
  test('label + archive emits patch keys, never whole maps', () => {
    const cur = new Map([['m1', state(['INBOX'], ['$maskedemail', '$seen'])]]);
    const out = computeUpdates({ add_label: ['Receipts'], archive: true }, ['m1'], cur, M, []);
    expect(out).toEqual({
      m1: { 'mailboxIds/L1': true, 'mailboxIds/INBOX': null },
    });
  });

  test('mark_read adds $seen without touching other keywords', () => {
    const cur = new Map([['m1', state(['INBOX'], ['$maskedemail'])]]);
    const out = computeUpdates({ mark_read: true }, ['m1'], cur, M, []);
    expect(out).toEqual({ m1: { 'keywords/$seen': true } });
  });

  test('no-op when already labelled, read, and archived', () => {
    const cur = new Map([['m1', state(['L1'], ['$seen'])]]);
    const out = computeUpdates({ add_label: ['Receipts'], mark_read: true }, ['m1'], cur, M, []);
    expect(out).toEqual({});
  });

  test('spam move nulls every current mailbox and adds junk', () => {
    const cur = new Map([['m1', state(['INBOX', 'L1'], ['$seen'])]]);
    const out = computeUpdates({ send_to_spam: true }, ['m1'], cur, M, []);
    expect(out).toEqual({
      m1: { 'mailboxIds/INBOX': null, 'mailboxIds/L1': null, 'mailboxIds/JUNK': true },
    });
  });

  test('spam move is idempotent for an already-spammed message', () => {
    const cur = new Map([['m1', state(['JUNK'], ['$seen'])]]);
    const out = computeUpdates({ send_to_spam: true }, ['m1'], cur, M, []);
    expect(out).toEqual({});
  });

  test('missing label warns and skips the label action', () => {
    const warnings: string[] = [];
    const cur = new Map([['m1', state(['INBOX'])]]);
    const out = computeUpdates({ add_label: ['Nope'], archive: true }, ['m1'], cur, { ...M, label: undefined }, warnings);
    expect(out).toEqual({ m1: { 'mailboxIds/INBOX': null } });
    expect(warnings).toHaveLength(1);
  });
});

describe('collectRuleLabels / describeActions', () => {
  test('collects unique label names', () => {
    const rules = [
      mkRule({ actions: { add_label: ['A'] } }),
      mkRule({ actions: { add_label: ['B'] } }),
      mkRule({ actions: { add_label: ['A'], archive: true } }),
      mkRule({ actions: { mark_read: true } }),
    ];
    expect(collectRuleLabels(rules).sort()).toEqual(['A', 'B']);
  });

  test('describeActions renders actions including non-retroactive notes', () => {
    expect(describeActions({ add_label: ['X'], archive: true })).toBe('label "X", archive');
    expect(describeActions({ notify: true, snooze_until: { time: '08:00' } })).toBe(
      'snooze (not retroactive), notify (not retroactive)',
    );
  });
});
