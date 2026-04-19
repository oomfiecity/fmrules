import { describe, expect, test } from 'bun:test';
import { and, field, flatten, header, not, or, phrase, raw } from '../src/compile/search-ir.ts';
import { render } from '../src/compile/render.ts';

describe('render precedence', () => {
  test('OR inside AND is parenthesized', () => {
    const tree = and(field('from', 'a'), or(field('from', 'b'), field('from', 'c')));
    expect(render(tree)).toBe('from:a (from:b OR from:c)');
  });

  test('AND inside OR is parenthesized', () => {
    const tree = or(and(field('from', 'a'), field('to', 'b')), field('from', 'c'));
    expect(render(tree)).toBe('(from:a to:b) OR from:c');
  });

  test('flat AND is space-joined', () => {
    const tree = and(field('from', 'a'), field('to', 'b'), field('subject', 'c'));
    expect(render(tree)).toBe('from:a to:b subject:c');
  });
});

describe('render quoting', () => {
  test('values with whitespace are quoted', () => {
    expect(render(field('subject', 'hello world'))).toBe('subject:"hello world"');
  });

  test('values with embedded quotes are escaped', () => {
    expect(render(field('subject', 'a"b'))).toBe('subject:"a\\"b"');
  });

  test('plain values stay bare', () => {
    expect(render(field('from', 'anthropic.com'))).toBe('from:anthropic.com');
  });

  test('header is quoted as Name:value', () => {
    expect(render(header('X-Foo', 'bar'))).toBe('header:"X-Foo:bar"');
  });

  test('phrase node quotes', () => {
    expect(render(phrase('abc def'))).toBe('"abc def"');
  });

  test('raw is passed through', () => {
    expect(render(raw('from:x OR from:y'))).toBe('from:x OR from:y');
  });
});

describe('render NOT', () => {
  test('NOT on single term is prefix dash', () => {
    expect(render(not(field('from', 'spam.com')))).toBe('-from:spam.com');
  });

  test('NOT on group uses NOT keyword and parens', () => {
    expect(render(not(or(field('from', 'a'), field('from', 'b'))))).toBe(
      'NOT (from:a OR from:b)',
    );
  });
});

describe('flatten', () => {
  test('nested same-kind groups collapse', () => {
    const t = and(field('from', 'a'), and(field('to', 'b'), field('subject', 'c')));
    const f = flatten(t);
    expect(f.kind).toBe('and');
    if (f.kind === 'and') expect(f.children.length).toBe(3);
  });

  test('single-child group unwraps', () => {
    const t = or(field('from', 'x'));
    const f = flatten(t);
    expect(f.kind).toBe('field');
  });

  test('mixed kinds preserved', () => {
    const t = and(field('from', 'a'), or(field('from', 'b'), field('from', 'c')));
    const f = flatten(t);
    expect(f.kind).toBe('and');
    if (f.kind === 'and') {
      expect(f.children[0]!.kind).toBe('field');
      expect(f.children[1]!.kind).toBe('or');
    }
  });
});
