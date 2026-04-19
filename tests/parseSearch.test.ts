import { describe, expect, test } from 'bun:test';
import { parseSearch, fullyConsumed } from '../src/fastmail/parseSearch.ts';
import { walk } from '../src/compile/search-ir.ts';
import { render } from '../src/compile/render.ts';
import { forbiddenFields } from '../src/fastmail/valid-fields.ts';

describe('parseSearch — accepted shapes', () => {
  test.each([
    ['from:x', 'from:x'],
    ['from:anthropic.com', 'from:anthropic.com'],
    ['subject:"hello world"', 'subject:"hello world"'],
    ['header:"X-Foo:bar"', 'header:"X-Foo:bar"'],
    // Top-level OR group renders bare; parens only appear nested.
    ['(from:a OR from:b)', 'from:a OR from:b'],
    ['from:x (from:a OR from:b)', 'from:x (from:a OR from:b)'],
  ])('parses %p round-trip', (input, expected) => {
    expect(fullyConsumed(input)).toBe(true);
    const tree = parseSearch(input);
    expect(tree).not.toBeNull();
    expect(render(tree!)).toBe(expected);
  });
});

describe('parseSearch — normalization', () => {
  test('prefix dash on a leaf renders as `-` prefix', () => {
    const tree = parseSearch('-from:spam.com');
    expect(render(tree!)).toBe('-from:spam.com');
  });
});

describe('parseSearch — forbidden field detection', () => {
  test('walks to find in: field', () => {
    const tree = parseSearch('in:Inbox from:x');
    const fields = [...walk(tree!)]
      .filter((n) => n.kind === 'field')
      .map((n) => (n.kind === 'field' ? n.field : ''));
    expect(fields).toContain('in');
    expect(forbiddenFields.has('in')).toBe(true);
  });

  test('walks to find attached: field', () => {
    const tree = parseSearch('attached:secret.pdf');
    const fields = [...walk(tree!)]
      .filter((n) => n.kind === 'field')
      .map((n) => (n.kind === 'field' ? n.field : ''));
    expect(fields).toContain('attached');
    expect(forbiddenFields.has('attached')).toBe(true);
  });
});

describe('parseSearch — unparseable input', () => {
  test('unbalanced paren leaves input unconsumed', () => {
    expect(fullyConsumed('(from:x')).toBe(false);
  });

  test('stray closing brace leaves input unconsumed', () => {
    expect(fullyConsumed('from:x }')).toBe(false);
  });
});
