/**
 * Unit tests for the compile-side structured filter emitter
 * (src/compile/emit-filter.ts).
 *
 * The critical case is fail-closed behavior: a rule mixing supported and
 * unsupported leaves must emit filter: null (dropping the unsupported
 * leaf would silently broaden the installed rule), with the reason
 * surfaced so compile/check can warn and sync can refuse the file.
 */

import { describe, expect, test } from 'bun:test';
import { emitRuleFilter } from '../src/compile/emit-filter.ts';
import type { Condition, When } from '../src/types.ts';

const leaf = (c: Condition): [When, Condition | null] => [c, c];

describe('emitRuleFilter — supported leaves', () => {
  test('from address → {from}', () => {
    const out = emitRuleFilter(...leaf({ kind: 'address', field: 'from', match: 'address', value: 'noreply@example.com' }));
    expect(out).toEqual({ filter: { from: 'noreply@example.com' }, unsupported: null });
  });

  test('from domain → {from: "@domain"}', () => {
    const out = emitRuleFilter(...leaf({ kind: 'address', field: 'from', match: 'domain', value: 'example.com' }));
    expect(out).toEqual({ filter: { from: '@example.com' }, unsupported: null });
  });

  test('phrase values keep the renderer quoting (hyphen needs quotes)', () => {
    const out = emitRuleFilter(...leaf({ kind: 'phrase', field: 'subject', match: 'contains', value: 'two-part' }));
    expect(out).toEqual({ filter: { subject: '"two-part"' }, unsupported: null });
  });

  test('to_only → {to}; to → OR over recipient fields', () => {
    expect(emitRuleFilter(...leaf({ kind: 'address', field: 'to_only', match: 'address', value: 'a@b.c' })).filter).toEqual({ to: 'a@b.c' });
    expect(emitRuleFilter(...leaf({ kind: 'address', field: 'to', match: 'address', value: 'a@b.c' })).filter).toEqual({
      operator: 'OR',
      conditions: [{ to: 'a@b.c' }, { cc: 'a@b.c' }, { bcc: 'a@b.c' }, { deliveredTo: 'a@b.c' }],
    });
  });

  test('anywhere phrase → OR over address fields (rule-grammar `with:` parse)', () => {
    const out = emitRuleFilter(...leaf({ kind: 'phrase', field: 'anywhere', match: 'contains', value: 'ebay' }));
    expect(out.filter).toEqual({
      operator: 'OR',
      conditions: [{ from: 'ebay' }, { to: 'ebay' }, { cc: 'ebay' }, { bcc: 'ebay' }, { deliveredTo: 'ebay' }],
    });
  });

  test('raw with: → OR over address fields, bare value', () => {
    const out = emitRuleFilter(...leaf({ kind: 'raw', value: 'with:via' }));
    expect(out.filter).toEqual({
      operator: 'OR',
      conditions: [{ from: 'via' }, { to: 'via' }, { cc: 'via' }, { bcc: 'via' }, { deliveredTo: 'via' }],
    });
  });

  test('raw beyond with: → filter null with reason', () => {
    const out = emitRuleFilter(...leaf({ kind: 'raw', value: 'list:my-list' }));
    expect(out.filter).toBeNull();
    expect(out.unsupported).toContain('raw condition "list:my-list"');
  });

  test('header forms → [name] / [name, value]', () => {
    expect(emitRuleFilter(...leaf({ kind: 'header_exists', name: 'List-Id' })).filter).toEqual({ header: ['List-Id'] });
    expect(
      emitRuleFilter(...leaf({ kind: 'header_contains', name: 'X-SimpleLogin-Original-From', value: 'anthropic.com' })).filter,
    ).toEqual({ header: ['X-SimpleLogin-Original-From', 'anthropic.com'] });
  });

  test('list_id → bare {listId}', () => {
    expect(emitRuleFilter(...leaf({ kind: 'list_id', value: '<announce.example.com>' })).filter).toEqual({
      listId: 'announce.example.com',
    });
  });

  test('size → minSize/maxSize', () => {
    expect(emitRuleFilter(...leaf({ kind: 'size', op: 'larger_than', bytes: 1024, raw: '1M' })).filter).toEqual({ minSize: 1024 });
    expect(emitRuleFilter(...leaf({ kind: 'size', op: 'smaller_than', bytes: 512, raw: '512' })).filter).toEqual({ maxSize: 512 });
  });

  test('predicate mappings', () => {
    expect(emitRuleFilter(...leaf({ kind: 'priority', value: 'high' })).filter).toEqual({ isHighPriority: true });
    expect(emitRuleFilter(...leaf({ kind: 'has_attachment' })).filter).toEqual({ hasAttachment: true });
    expect(emitRuleFilter(...leaf({ kind: 'from_in_contacts' })).filter).toEqual({ fromAnyContact: true });
    expect(emitRuleFilter(...leaf({ kind: 'msg_pinned' })).filter).toEqual({ hasKeyword: '$flagged' });
    expect(emitRuleFilter(...leaf({ kind: 'mimetype', value: 'application/pdf' })).filter).toEqual({ text: 'mimetype:application/pdf' });
  });

  test('all → AND; not → NOT', () => {
    const out = emitRuleFilter(...leaf({
      kind: 'all',
      children: [
        { kind: 'address', field: 'from', match: 'contains', value: 'tumblr' },
        { kind: 'phrase', field: 'subject', match: 'contains', value: 'receipt' },
      ],
    }));
    expect(out.filter).toEqual({
      operator: 'AND',
      conditions: [{ from: 'tumblr' }, { subject: 'receipt' }],
    });

    const negated = emitRuleFilter(...leaf({
      kind: 'not',
      child: { kind: 'phrase', field: 'subject', match: 'contains', value: 'x' },
    }));
    expect(negated.filter).toEqual({ operator: 'NOT', conditions: [{ subject: 'x' }] });
  });
});

describe('emitRuleFilter — dates are UTC, deterministic, DST-safe', () => {
  test('after → UTC midnight, independent of machine timezone', () => {
    const out = emitRuleFilter(...leaf({ kind: 'date', after: '2026-04-22' }));
    expect(out.filter).toEqual({ after: '2026-04-22T00:00:00.000Z' });
  });

  test('equals → [UTC midnight, next UTC calendar day)', () => {
    const out = emitRuleFilter(...leaf({ kind: 'date', equals: '2026-04-22' }));
    expect(out.filter).toEqual({
      operator: 'AND',
      conditions: [{ after: '2026-04-22T00:00:00.000Z' }, { before: '2026-04-23T00:00:00.000Z' }],
    });
  });

  test('equals spans month boundaries by calendar day, not +24h arithmetic alone', () => {
    const out = emitRuleFilter(...leaf({ kind: 'date', equals: '2026-01-31' }));
    expect(out.filter).toEqual({
      operator: 'AND',
      conditions: [{ after: '2026-01-31T00:00:00.000Z' }, { before: '2026-02-01T00:00:00.000Z' }],
    });
  });

  test('range → AND of UTC bounds', () => {
    const out = emitRuleFilter(...leaf({ kind: 'date', after: '2025-03-01', before: '2025-05-31' }));
    expect(out.filter).toEqual({
      operator: 'AND',
      conditions: [{ after: '2025-03-01T00:00:00.000Z' }, { before: '2025-05-31T00:00:00.000Z' }],
    });
  });
});

describe('emitRuleFilter — fail-closed on unsupported leaves', () => {
  test('when: always → filter null with reason', () => {
    const out = emitRuleFilter({ kind: 'always' }, null);
    expect(out).toEqual({ filter: null, unsupported: 'when: always has no structured-filter form' });
  });

  test('a lone unsupported leaf → filter null with reason', () => {
    for (const c of [
      { kind: 'from_in_vips' } as Condition,
      { kind: 'to_in_vips' } as Condition,
      { kind: 'from_in_group', group: 'Family' } as Condition,
      { kind: 'to_in_group', group: 'Family' } as Condition,
    ]) {
      const out = emitRuleFilter(...leaf(c));
      expect(out.filter).toBeNull();
      expect(out.unsupported).toContain('has no structured-filter form');
    }
  });

  test('mixed supported + unsupported leaves → whole rule refused (B1 regression)', () => {
    const out = emitRuleFilter(...leaf({
      kind: 'all',
      children: [
        { kind: 'address', field: 'from', match: 'address', value: 'boss@example.com' },
        { kind: 'not', child: { kind: 'from_in_group', group: 'Contractors' } },
      ],
    }));
    // The negation must NOT vanish into a bare {from: boss@example.com}.
    expect(out.filter).toBeNull();
    expect(out.unsupported).toContain('from_in_group "Contractors"');
  });

  test('not with an unsupported child → refused, not an empty match', () => {
    const out = emitRuleFilter(...leaf({
      kind: 'not',
      child: { kind: 'from_in_group', group: 'Family' },
    }));
    expect(out.filter).toBeNull();
    expect(out.unsupported).toContain('from_in_group "Family"');
  });

  test('multiple unsupported leaves → reasons joined', () => {
    const out = emitRuleFilter(...leaf({
      kind: 'all',
      children: [
        { kind: 'from_in_vips' } as Condition,
        { kind: 'from_in_group', group: 'Family' } as Condition,
      ],
    }));
    expect(out.filter).toBeNull();
    expect(out.unsupported).toContain('from_in_vips');
    expect(out.unsupported).toContain('from_in_group "Family"');
  });

  test('unsupported leaf nested under an any: OR → whole rule refused', () => {
    const out = emitRuleFilter(...leaf({
      kind: 'any',
      children: [
        { kind: 'address', field: 'from', match: 'address', value: 'a@b.c' },
        { kind: 'to_in_vips' } as Condition,
      ],
    }));
    // Dropping the unsupported OR-arm would silently NARROW the rule;
    // refusing keeps the file out of sync entirely.
    expect(out.filter).toBeNull();
    expect(out.unsupported).toContain('to_in_vips');
  });
});
