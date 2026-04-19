import { describe, expect, test } from 'bun:test';
import { buildDeclarativeModule } from '../src/compile/declarative-module.ts';
import { render } from '../src/compile/render.ts';
import type { Context } from '../src/context.ts';
import type { PartialRule } from '../src/types.ts';
import type { DeclarativeModuleYaml } from '../src/schema/yaml.ts';

const modCtx: Context = {
  paths: { cwd: '.', rules: '.', meta: '.' },
  log: {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
  },
};

function mkRule(from: string | string[]): PartialRule {
  return {
    name: 'test',
    hasOwnMatchers: true,
    matchers: { from },
    actions: { fileIn: 'Inbox' },
    meta: { file: 't.yaml', fileIndex: 0, fanoutIndex: 0 },
  };
}

const simpleLogin: DeclarativeModuleYaml = {
  module: 'simplelogin',
  targets: 'from',
  transform: {
    from: {
      any: [
        { from: '{value}' },
        { header: { name: 'X-SimpleLogin-Original-From', value: '{value}' } },
      ],
    },
  },
};

describe('buildDeclarativeModule', () => {
  test('applies transform and removes matcher; pushes IR to extraSearch', () => {
    const mod = buildDeclarativeModule(simpleLogin);
    const [out] = mod.apply([mkRule('anthropic.com')], {}, modCtx) as PartialRule[];
    expect(out!.matchers.from).toBeUndefined();
    expect(out!.extraSearch).toBeDefined();
    expect(out!.extraSearch!.length).toBe(1);
    // The OR IR renders bare at the top; parens appear only when nested under AND.
    const rendered = render(out!.extraSearch![0]!);
    expect(rendered).toBe(
      'from:anthropic.com OR header:"X-SimpleLogin-Original-From:anthropic.com"',
    );
  });

  test('array of values creates OR of branches', () => {
    const mod = buildDeclarativeModule(simpleLogin);
    const [out] = mod.apply([mkRule(['a.com', 'b.com'])], {}, modCtx) as PartialRule[];
    const rendered = render(out!.extraSearch![0]!);
    expect(rendered).toContain('from:a.com');
    expect(rendered).toContain('from:b.com');
    expect(rendered).toContain('X-SimpleLogin-Original-From:a.com');
    expect(rendered).toContain('X-SimpleLogin-Original-From:b.com');
  });

  test('targets array applies to each listed field', () => {
    const mod = buildDeclarativeModule({
      module: 'both',
      targets: ['from', 'to'],
      transform: {
        from: { from: '{value}' },
        to: { to: '{value}' },
      },
    });
    const rule: PartialRule = {
      name: 't',
      hasOwnMatchers: true,
      matchers: { from: 'x', to: 'y' },
      actions: { fileIn: 'Inbox' },
      meta: { file: 't.yaml', fileIndex: 0, fanoutIndex: 0 },
    };
    const [out] = mod.apply([rule], {}, modCtx) as PartialRule[];
    expect(out!.matchers.from).toBeUndefined();
    expect(out!.matchers.to).toBeUndefined();
    expect(out!.extraSearch!.length).toBe(2);
  });

  test('unknown target is rejected', () => {
    expect(() =>
      buildDeclarativeModule({
        module: 'bad',
        targets: ['nonsense'],
        transform: { nonsense: { from: '{value}' } },
      }),
    ).toThrow(/unknown target field/);
  });

  test('domain leaf applies @-wrapping via the shared compiler', () => {
    const mod = buildDeclarativeModule({
      module: 'domain-bridge',
      targets: 'from',
      transform: { from: { domain: '{value}' } },
    });
    const [out] = mod.apply([mkRule('anthropic.com')], {}, modCtx) as PartialRule[];
    expect(render(out!.extraSearch![0]!)).toBe('from:@anthropic.com');
  });

  test('list leaf applies <>-wrapping via normalizeListId', () => {
    const mod = buildDeclarativeModule({
      module: 'list-bridge',
      targets: 'from',
      transform: { from: { list: '{value}' } },
    });
    const [out] = mod.apply([mkRule('list.example.com')], {}, modCtx) as PartialRule[];
    expect(render(out!.extraSearch![0]!)).toBe('list:<list.example.com>');
  });

  test('MatcherValue leaf: {any} interpolates into every string position', () => {
    const mod = buildDeclarativeModule({
      module: 'alias-expander',
      targets: 'from',
      transform: {
        from: { from: { any: ['{value}', 'alias-{value}'] } },
      },
    });
    const [out] = mod.apply([mkRule('anthropic.com')], {}, modCtx) as PartialRule[];
    expect(render(out!.extraSearch![0]!)).toBe(
      'from:anthropic.com OR from:alias-anthropic.com',
    );
  });

  test('interpolation preserves $ in value (no regex back-reference corruption)', () => {
    const mod = buildDeclarativeModule({
      module: 'dollar-test',
      targets: 'from',
      transform: { from: { from: '{value}' } },
    });
    const [out] = mod.apply([mkRule('user+$1@example.com')], {}, modCtx) as PartialRule[];
    expect(render(out!.extraSearch![0]!)).toBe('from:user+$1@example.com');
  });

  test('{all: [a, b]} matcher AND-joins per-value transforms (not OR)', () => {
    const mod = buildDeclarativeModule(simpleLogin);
    const rule: PartialRule = {
      name: 't',
      hasOwnMatchers: true,
      matchers: { from: { all: ['a.com', 'b.com'] } },
      actions: { fileIn: 'Inbox' },
      meta: { file: 't.yaml', fileIndex: 0, fanoutIndex: 0 },
    };
    const [out] = mod.apply([rule], {}, modCtx) as PartialRule[];
    const rendered = render(out!.extraSearch![0]!);
    // Two transforms AND-joined; each transform is itself an OR group over
    // the direct from + header alternative.
    expect(rendered).toBe(
      '(from:a.com OR header:"X-SimpleLogin-Original-From:a.com") ' +
        '(from:b.com OR header:"X-SimpleLogin-Original-From:b.com")',
    );
  });

  test('{any: [a], all: [b]} matcher → AND of (any leaf, all leaf)', () => {
    const mod = buildDeclarativeModule({
      module: 'alias-anyall',
      targets: 'from',
      transform: { from: { from: '{value}' } },
    });
    const rule: PartialRule = {
      name: 't',
      hasOwnMatchers: true,
      matchers: { from: { any: ['a.com'], all: ['b.com'] } },
      actions: { fileIn: 'Inbox' },
      meta: { file: 't.yaml', fileIndex: 0, fanoutIndex: 0 },
    };
    const [out] = mod.apply([rule], {}, modCtx) as PartialRule[];
    // AND across the any-group and each all-member; any-group with one
    // element collapses to the bare leaf.
    expect(render(out!.extraSearch![0]!)).toBe('from:a.com from:b.com');
  });
});
