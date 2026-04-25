import { describe, expect, test } from 'bun:test';
import { ErrorCollector } from '../src/compile/errors.ts';
import { expandRule, countLeaves } from '../src/compile/expand.ts';
import type { Rule } from '../src/types.ts';

function mkRule(partial: Partial<Rule>): Rule {
  return {
    name: partial.name ?? 'r',
    enabled: partial.enabled ?? true,
    continue: partial.continue ?? false,
    when: partial.when ?? { kind: 'always' },
    actions: partial.actions ?? {},
    sourceFile: 'rules/r.yml',
    sourceIndex: 0,
  };
}

describe('expand (§10.4)', () => {
  test('zero labels → one rule with all actions', () => {
    const r = mkRule({
      actions: { mark_read: true, pin: true, archive: true },
      continue: false,
    });
    const errs = new ErrorCollector();
    const out = expandRule(r, null, errs);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('r');
    expect(out[0]!.actions.mark_read).toBe(true);
    expect(out[0]!.actions.pin).toBe(true);
    expect(out[0]!.actions.archive).toBe(true);
    expect(out[0]!.continueFlag).toBe(false);
    expect(errs.hasErrors()).toBe(false);
  });

  test('one label → one rule with label + all actions', () => {
    const r = mkRule({
      actions: { add_label: ['Foo'], mark_read: true, archive: true },
      continue: false,
    });
    const errs = new ErrorCollector();
    const out = expandRule(r, null, errs);
    expect(out).toHaveLength(1);
    expect(out[0]!.actions.add_label).toEqual(['Foo']);
    expect(out[0]!.actions.mark_read).toBe(true);
    expect(out[0]!.actions.archive).toBe(true);
  });

  test('three labels → three rules, first gets first-rule actions, last gets last-rule actions', () => {
    const r = mkRule({
      actions: {
        add_label: ['A', 'B', 'C'],
        notify: true,
        send_copy_to: ['x@y.com'],
        snooze_until: { time: '08:00' },
        archive: true,
      },
      continue: false,
    });
    const errs = new ErrorCollector();
    const out = expandRule(r, null, errs);
    expect(out).toHaveLength(3);

    // First: A + notify + send_copy_to; continue true (not last)
    expect(out[0]!.name).toBe('r');
    expect(out[0]!.actions.add_label).toEqual(['A']);
    expect(out[0]!.actions.notify).toBe(true);
    expect(out[0]!.actions.send_copy_to).toEqual(['x@y.com']);
    expect(out[0]!.actions.archive).toBeUndefined();
    expect(out[0]!.actions.snooze_until).toBeUndefined();
    expect(out[0]!.continueFlag).toBe(true);

    // Middle: B only; continue true
    expect(out[1]!.name).toBe('r#2');
    expect(out[1]!.actions.add_label).toEqual(['B']);
    expect(out[1]!.actions.notify).toBeUndefined();
    expect(out[1]!.actions.archive).toBeUndefined();
    expect(out[1]!.continueFlag).toBe(true);

    // Last: C + snooze + archive; continue inherits YAML value (false)
    expect(out[2]!.name).toBe('r#3');
    expect(out[2]!.actions.add_label).toEqual(['C']);
    expect(out[2]!.actions.snooze_until).toEqual({ time: '08:00' });
    expect(out[2]!.actions.archive).toBe(true);
    expect(out[2]!.continueFlag).toBe(false);
  });

  test('two-label no-terminal preserves continue: false on last', () => {
    const r = mkRule({
      actions: { add_label: ['Bugs', 'Incoming'] },
      continue: false,
    });
    const errs = new ErrorCollector();
    const out = expandRule(r, null, errs);
    expect(out).toHaveLength(2);
    expect(out[0]!.continueFlag).toBe(true);
    expect(out[1]!.continueFlag).toBe(false);
  });

  test('leaf-count cap (§8.8) rejects > 50 leaves', () => {
    const kids = Array.from({ length: 51 }, (_, i) => ({
      kind: 'address' as const,
      field: 'from' as const,
      match: 'address' as const,
      value: `a${i}@x.com`,
    }));
    const cond = { kind: 'all' as const, children: kids };
    const r = mkRule({
      when: cond,
      actions: { mark_read: true },
    });
    const errs = new ErrorCollector();
    const out = expandRule(r, cond, errs);
    expect(out).toHaveLength(0);
    expect(errs.count()).toBe(1);
    expect(errs.getErrors()[0]!.tag).toBe('12.2');
  });
});

describe('countLeaves', () => {
  test('counts each leaf once', () => {
    expect(
      countLeaves({
        kind: 'all',
        children: [
          { kind: 'address', field: 'from', match: 'address', value: 'a' },
          {
            kind: 'any',
            children: [
              { kind: 'phrase', field: 'subject', match: 'contains', value: 'x' },
              { kind: 'phrase', field: 'subject', match: 'contains', value: 'y' },
            ],
          },
          { kind: 'not', child: { kind: 'raw', value: 'priority:high' } },
        ],
      }),
    ).toBe(4);
  });

  test('always counts as 0', () => {
    expect(countLeaves({ kind: 'always' })).toBe(0);
  });
});
