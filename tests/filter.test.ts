import { describe, expect, test } from 'bun:test';
import { renderFilter } from '../src/live/filter.ts';
import type { Condition, When } from '../src/types.ts';

const leaf = (c: Condition): [When, Condition | null] => [c, c];

describe('renderFilter — combinators', () => {
  test('always matches everything (null condition)', () => {
    expect(renderFilter({ kind: 'always' }, null)).toEqual({ condition: null, unsupported: [] });
  });

  test('all → AND', () => {
    const out = renderFilter(...leaf({
      kind: 'all',
      children: [
        { kind: 'address', field: 'from', match: 'contains', value: 'tumblr' },
        { kind: 'phrase', field: 'subject', match: 'contains', value: 'receipt' },
      ],
    }));
    expect(out.condition).toEqual({
      operator: 'AND',
      conditions: [{ from: 'tumblr' }, { subject: 'receipt' }],
    });
  });

  test('any → OR, single child collapses', () => {
    const out = renderFilter(...leaf({
      kind: 'any',
      children: [{ kind: 'address', field: 'from', match: 'contains', value: 'a' }],
    }));
    expect(out.condition).toEqual({ from: 'a' });
  });

  test('not → NOT', () => {
    const out = renderFilter(...leaf({
      kind: 'not',
      child: { kind: 'phrase', field: 'subject', match: 'contains', value: 'x' },
    }));
    expect(out.condition).toEqual({ operator: 'NOT', conditions: [{ subject: 'x' }] });
  });
});

describe('renderFilter — address fields (§8.3)', () => {
  test('from contains → {from}', () => {
    const out = renderFilter(...leaf({ kind: 'address', field: 'from', match: 'contains', value: 'noreply' }));
    expect(out.condition).toEqual({ from: 'noreply' });
  });

  test('from domain → {from: "@domain"}', () => {
    const out = renderFilter(...leaf({ kind: 'address', field: 'from', match: 'domain', value: 'example.com' }));
    expect(out.condition).toEqual({ from: '@example.com' });
  });

  test('from domain_or_subdomain → OR of apex + dot-anchored arms (mirrors compile-side emission)', () => {
    const out = renderFilter(...leaf({ kind: 'address', field: 'from', match: 'domain_or_subdomain', value: 'boost.com.au' }));
    expect(out.condition).toEqual({
      operator: 'OR',
      conditions: [{ from: '@boost.com.au' }, { from: '.boost.com.au' }],
    });
  });

  test('to → OR over to/cc/bcc/deliveredTo', () => {
    const out = renderFilter(...leaf({ kind: 'address', field: 'to', match: 'address', value: 'a@b.c' }));
    expect(out.condition).toEqual({
      operator: 'OR',
      conditions: [{ to: 'a@b.c' }, { cc: 'a@b.c' }, { bcc: 'a@b.c' }, { deliveredTo: 'a@b.c' }],
    });
  });

  test('to_only → {to} (tonotcc parity)', () => {
    const out = renderFilter(...leaf({ kind: 'address', field: 'to_only', match: 'address', value: 'a@b.c' }));
    expect(out.condition).toEqual({ to: 'a@b.c' });
  });

  test('delivered_to → {deliveredTo}', () => {
    const out = renderFilter(...leaf({ kind: 'address', field: 'delivered_to', match: 'address', value: 'a@b.c' }));
    expect(out.condition).toEqual({ deliveredTo: 'a@b.c' });
  });
});

describe('renderFilter — phrases', () => {
  test('subject/body', () => {
    expect(renderFilter(...leaf({ kind: 'phrase', field: 'subject', match: 'contains', value: 'x' })).condition).toEqual({ subject: 'x' });
    expect(renderFilter(...leaf({ kind: 'phrase', field: 'body', match: 'contains', value: 'y' })).condition).toEqual({ body: 'y' });
  });

  test('anywhere → {text}', () => {
    expect(renderFilter(...leaf({ kind: 'phrase', field: 'anywhere', match: 'contains', value: 'z' })).condition).toEqual({ text: 'z' });
  });

  test('attachment_name → hasAttachment + attachmentName', () => {
    expect(renderFilter(...leaf({ kind: 'phrase', field: 'attachment_name', match: 'contains', value: 'scan' })).condition).toEqual({
      hasAttachment: true,
      attachmentName: 'scan',
    });
  });
});

describe('renderFilter — list, size, predicates', () => {
  test('list_id anchors on the List-Id header', () => {
    const out = renderFilter(...leaf({ kind: 'list_id', value: '<announce.example.com>' }));
    expect(out.condition).toEqual({ header: ['List-Id', '<announce.example.com>'] });
  });

  test('size → minSize/maxSize', () => {
    expect(renderFilter(...leaf({ kind: 'size', op: 'larger_than', bytes: 1024, raw: '1M' })).condition).toEqual({ minSize: 1024 });
    expect(renderFilter(...leaf({ kind: 'size', op: 'smaller_than', bytes: 512, raw: '512' })).condition).toEqual({ maxSize: 512 });
  });

  test('predicate mappings', () => {
    expect(renderFilter(...leaf({ kind: 'priority', value: 'high' })).condition).toEqual({ isHighPriority: true });
    expect(renderFilter(...leaf({ kind: 'has_attachment' })).condition).toEqual({ hasAttachment: true });
    expect(renderFilter(...leaf({ kind: 'has_list_id' })).condition).toEqual({ header: ['List-Id'] });
    expect(renderFilter(...leaf({ kind: 'from_in_contacts' })).condition).toEqual({ fromAnyContact: true });
    expect(renderFilter(...leaf({ kind: 'conv_followed' })).condition).toEqual({ hasKeyword: '$followed' });
    expect(renderFilter(...leaf({ kind: 'conv_muted' })).condition).toEqual({ hasKeyword: '$muted' });
    expect(renderFilter(...leaf({ kind: 'msg_pinned' })).condition).toEqual({ hasKeyword: '$flagged' });
    expect(renderFilter(...leaf({ kind: 'msg_replied' })).condition).toEqual({ hasKeyword: '$answered' });
    expect(renderFilter(...leaf({ kind: 'filetype', value: 'pdf' })).condition).toEqual({ attachmentType: 'pdf' });
    expect(renderFilter(...leaf({ kind: 'mimetype', value: 'application/pdf' })).condition).toEqual({ text: 'mimetype:application/pdf' });
  });

  test('to_in_contacts → OR over recipient contact conditions', () => {
    expect(renderFilter(...leaf({ kind: 'to_in_contacts' })).condition).toEqual({
      operator: 'OR',
      conditions: [{ toAnyContact: true }, { ccAnyContact: true }, { bccAnyContact: true }],
    });
  });

  test('VIP and group membership are unsupported', () => {
    for (const c of [
      { kind: 'from_in_vips' } as Condition,
      { kind: 'to_in_vips' } as Condition,
      { kind: 'from_in_group', group: 'Family' } as Condition,
      { kind: 'to_in_group', group: 'Family' } as Condition,
    ]) {
      const out = renderFilter(...leaf(c));
      expect(out.condition).toBeNull();
      expect(out.unsupported.length).toBe(1);
    }
  });
});

describe('renderFilter — headers and dates', () => {
  test('header value forms → [name, value]', () => {
    const out = renderFilter(...leaf({ kind: 'header_contains', name: 'X-SimpleLogin-Original-From', value: 'anthropic.com' }));
    expect(out.condition).toEqual({ header: ['X-SimpleLogin-Original-From', 'anthropic.com'] });
  });

  test('header_exists → [name]', () => {
    expect(renderFilter(...leaf({ kind: 'header_exists', name: 'List-Id' })).condition).toEqual({ header: ['List-Id'] });
  });

  test('date after/before → UTC ISO bounds; equals → UTC day window', () => {
    // Day boundaries are pinned to UTC (util/dates.ts) so compile output
    // is deterministic across machines — the test is timezone-independent.
    const midnight = (d: string) => new Date(`${d}T00:00:00Z`).toISOString();
    const nextMidnight = (d: string) => new Date(new Date(`${d}T00:00:00Z`).getTime() + 24 * 3600 * 1000).toISOString();

    const after = renderFilter(...leaf({ kind: 'date', after: '2026-04-22' }));
    expect(after.condition).toEqual({ after: midnight('2026-04-22') });

    const range = renderFilter(...leaf({ kind: 'date', after: '2026-04-22', before: '2026-05-01' }));
    expect(range.condition).toEqual({
      operator: 'AND',
      conditions: [{ after: midnight('2026-04-22') }, { before: midnight('2026-05-01') }],
    });

    const on = renderFilter(...leaf({ kind: 'date', equals: '2026-04-22' }));
    expect(on.condition).toEqual({
      operator: 'AND',
      conditions: [{ after: midnight('2026-04-22') }, { before: nextMidnight('2026-04-22') }],
    });
  });
});

describe('renderFilter — raw', () => {
  test('raw passes through as text condition', () => {
    const out = renderFilter(...leaf({ kind: 'raw', value: 'with:via' }));
    expect(out.condition).toEqual({ text: 'with:via' });
  });
});
