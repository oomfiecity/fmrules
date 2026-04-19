import { describe, expect, test } from 'bun:test';
import { buildDeclarativeModule } from '../src/compile/declarative-module.ts';
import { render } from '../src/compile/render.ts';
import type { PartialRule } from '../src/types.ts';
import type { DeclarativeModuleYaml } from '../src/schema/yaml.ts';

const modCtx = {
  paths: { cwd: '.', rules: '.', meta: '.' },
  log: { warn: () => {}, info: () => {} },
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
      or: [
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
});
