import { describe, expect, test } from 'bun:test';
import { resolveModuleChain, normalizeRule } from '../src/compile/normalize.ts';

describe('resolveModuleChain', () => {
  test('concatenates defaults → archetype → rule', () => {
    const chain = resolveModuleChain([['simplelogin'], ['vip'], ['quiet_hours']]);
    expect(chain.map((m) => m.name)).toEqual(['simplelogin', 'vip', 'quiet_hours']);
  });

  test('dedupes by name+args preserving first', () => {
    const chain = resolveModuleChain([['simplelogin'], ['vip'], ['simplelogin']]);
    expect(chain.map((m) => m.name)).toEqual(['simplelogin', 'vip']);
  });

  test('different args on same name are distinct entries', () => {
    const chain = resolveModuleChain([
      [{ name: 'vip', args: { notify: true } }],
      [{ name: 'vip', args: { notify: false } }],
    ]);
    expect(chain.length).toBe(2);
    expect(chain[0]!.args).toEqual({ notify: true });
    expect(chain[1]!.args).toEqual({ notify: false });
  });

  test('-name subtracts all prior entries of that name', () => {
    const chain = resolveModuleChain([['simplelogin', 'vip'], ['-simplelogin']]);
    expect(chain.map((m) => m.name)).toEqual(['vip']);
  });

  test('handles undefined layers gracefully', () => {
    expect(resolveModuleChain([undefined, ['vip'], undefined])).toEqual([{ name: 'vip' }]);
  });
});

describe('normalizeRule merge precedence', () => {
  const meta = { file: 'x.yaml', fileIndex: 0, fanoutIndex: 0 };

  test('rule body overrides archetype overrides defaults', () => {
    const r = normalizeRule({
      rule: { name: 'r', from: 'rule.com', archetype: 'alert' },
      defaults: { from: 'defaults.com', file_in: 'Inbox' },
      archetypes: { alert: { from: 'archetype.com', file_in: 'Alerts' } },
      meta,
    });
    expect(r.matchers.from).toBe('rule.com');
    expect(r.actions.fileIn).toBe('Alerts');
  });

  test('missing archetype throws', () => {
    expect(() =>
      normalizeRule({
        rule: { name: 'r', archetype: 'nope' },
        archetypes: {},
        meta,
      }),
    ).toThrow(/unknown archetype/);
  });

  test('module chain assembled from all three layers', () => {
    const r = normalizeRule({
      rule: { name: 'r', archetype: 'a', use: ['rule_mod'] },
      defaults: { use: ['def_mod'] },
      archetypes: { a: { use: ['arch_mod'] } },
      meta,
    });
    expect(r.moduleChain!.map((m) => m.name)).toEqual(['def_mod', 'arch_mod', 'rule_mod']);
  });
});
